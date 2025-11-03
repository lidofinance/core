// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IAccessControlEnumerable} from "@openzeppelin/contracts-v4.4/access/AccessControlEnumerable.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/UpgradeableBeacon.sol";

import {IBurner as IBurnerWithoutAccessControl} from "contracts/common/interfaces/IBurner.sol";
import {IVersioned} from "contracts/common/interfaces/IVersioned.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {LazyOracle} from "contracts/0.8.25/vaults/LazyOracle.sol";
import {VaultFactory} from "contracts/0.8.25/vaults/VaultFactory.sol";
import {OperatorGrid} from "contracts/0.8.25/vaults/OperatorGrid.sol";
import {PausableUntilWithRoles} from "contracts/0.8.25/utils/PausableUntilWithRoles.sol";

import {V3Addresses} from "./V3Addresses.sol";

interface IBaseOracle is IAccessControlEnumerable, IVersioned {
    function getConsensusContract() external view returns (address);
}

interface IEasyTrack {
    function getEVMScriptFactories() external view returns (address[] memory);
}

interface IStakingRouter is IAccessControlEnumerable {
    function REPORT_REWARDS_MINTED_ROLE() external view returns (bytes32);
}

interface IBurner is IBurnerWithoutAccessControl, IAccessControlEnumerable {
    function REQUEST_BURN_SHARES_ROLE() external view returns (bytes32);
    function isMigrationAllowed() external view returns (bool);
}

interface ILidoWithFinalizeUpgrade is ILido {
    function finalizeUpgrade_v3(address _oldBurner, address[] calldata _contractsWithBurnerAllowances, uint256 _initialMaxExternalRatioBP) external;
}

interface IAccountingOracle is IBaseOracle {
    function finalizeUpgrade_v4(uint256 consensusVersion) external;
}

interface IAragonAppRepo {
    function getLatest() external view returns (uint16[3] memory, address, bytes memory);
}

interface IWithdrawalsManagerProxy {
    function proxy_getAdmin() external view returns (address);
    function implementation() external view returns (address);
}

interface IOracleReportSanityChecker is IAccessControlEnumerable {
    function ALL_LIMITS_MANAGER_ROLE() external view returns (bytes32);
    function EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE() external view returns (bytes32);
    function APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE() external view returns (bytes32);
    function ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE() external view returns (bytes32);
    function SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE() external view returns (bytes32);
    function MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE() external view returns (bytes32);
    function MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE() external view returns (bytes32);
    function MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE() external view returns (bytes32);
    function REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE() external view returns (bytes32);
    function MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE() external view returns (bytes32);
    function SECOND_OPINION_MANAGER_ROLE() external view returns (bytes32);
    function INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE() external view returns (bytes32);
}


/**
* @title Lido V3 Upgrade Template
*
* @dev Must be used by means of two calls:
*   - `startUpgrade()` before upgrading LidoLocator and before everything else
*   - `finishUpgrade()` as the last step of the upgrade
*/
contract V3Template is V3Addresses {
    //
    // Events
    //

    event UpgradeStarted();
    event UpgradeFinished();

    //
    // -------- Constants --------
    //

    uint256 public constant EXPECTED_FINAL_LIDO_VERSION = 3;
    uint256 public constant EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION = 4;
    uint256 public constant EXPECTED_FINAL_ACCOUNTING_ORACLE_CONSENSUS_VERSION = 5;

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    // Timestamp since which startUpgrade()
    // This behavior is introduced to disarm the template if the upgrade voting creation or enactment
    // didn't happen in proper time period
    uint256 public immutable EXPIRE_SINCE_INCLUSIVE;

    // Initial value of upgradeBlockNumber storage variable
    uint256 public constant UPGRADE_NOT_STARTED = 0;

    uint256 public constant INFINITE_ALLOWANCE = type(uint256).max;

    //
    // Structured storage
    //

    uint256 public upgradeBlockNumber = UPGRADE_NOT_STARTED;
    bool public isUpgradeFinished;
    uint256 public initialOldBurnerStethSharesBalance;
    uint256 public initialTotalShares;
    uint256 public initialTotalPooledEther;
    address[] public contractsWithBurnerAllowances;
    uint256 public immutable INITIAL_MAX_EXTERNAL_RATIO_BP;

    //
    // Slots for transient storage
    //

    // Slot for the upgrade started flag
    // keccak256("V3Template.upgradeStartedFlag")
    bytes32 public constant UPGRADE_STARTED_SLOT =
        0x058d69f67a3d86c424c516d23a070ff8bed34431617274caa2049bd702675e3f;


    /// @param _params Params required to initialize the addresses contract
    /// @param _expireSinceInclusive Unix timestamp after which upgrade actions revert
    /// @param _initialMaxExternalRatioBP Initial maximum external ratio in basis points
    constructor(V3AddressesParams memory _params, uint256 _expireSinceInclusive, uint256 _initialMaxExternalRatioBP) V3Addresses(_params) {
        EXPIRE_SINCE_INCLUSIVE = _expireSinceInclusive;
        INITIAL_MAX_EXTERNAL_RATIO_BP = _initialMaxExternalRatioBP;
        contractsWithBurnerAllowances.push(WITHDRAWAL_QUEUE);
        // NB: NOR and SIMPLE_DVT allowances are set to 0 in TW upgrade, so they are not migrated
        contractsWithBurnerAllowances.push(CSM_ACCOUNTING);
    }

    /// @notice Must be called before LidoLocator is upgraded
    function startUpgrade() external {
        if (msg.sender != AGENT) revert OnlyAgentCanUpgrade();
        if (block.timestamp >= EXPIRE_SINCE_INCLUSIVE) revert Expired();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (_isStartCalledInThisTx()) revert StartAlreadyCalledInThisTx();
        if (upgradeBlockNumber != UPGRADE_NOT_STARTED) revert UpgradeAlreadyStarted();

        assembly { tstore(UPGRADE_STARTED_SLOT, 1) }
        upgradeBlockNumber = block.number;

        initialTotalShares = ILidoWithFinalizeUpgrade(LIDO).getTotalShares();
        initialTotalPooledEther = ILidoWithFinalizeUpgrade(LIDO).getTotalPooledEther();

        _assertPreUpgradeState();

        // Save initial state for the check after burner migration
        initialOldBurnerStethSharesBalance = ILidoWithFinalizeUpgrade(LIDO).sharesOf(OLD_BURNER);

        emit UpgradeStarted();
    }

    function finishUpgrade() external {
        if (msg.sender != AGENT) revert OnlyAgentCanUpgrade();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (!_isStartCalledInThisTx()) revert StartAndFinishMustBeInSameTx();

        isUpgradeFinished = true;

        ILidoWithFinalizeUpgrade(LIDO).finalizeUpgrade_v3(OLD_BURNER, contractsWithBurnerAllowances, INITIAL_MAX_EXTERNAL_RATIO_BP);

        IAccountingOracle(ACCOUNTING_ORACLE).finalizeUpgrade_v4(EXPECTED_FINAL_ACCOUNTING_ORACLE_CONSENSUS_VERSION);

        _assertPostUpgradeState();

        emit UpgradeFinished();
    }

    function _assertPreUpgradeState() internal view {
        // Check initial implementations of the proxies to be upgraded
        _assertProxyImplementation(IOssifiableProxy(LOCATOR), OLD_LOCATOR_IMPL);
        _assertProxyImplementation(IOssifiableProxy(ACCOUNTING_ORACLE), OLD_ACCOUNTING_ORACLE_IMPL);
        _assertAragonAppImplementation(IAragonAppRepo(ARAGON_APP_LIDO_REPO), OLD_LIDO_IMPL);

        // Check allowances of the old burner
        address[] memory contractsWithBurnerAllowances_ = contractsWithBurnerAllowances;
        for (uint256 i = 0; i < contractsWithBurnerAllowances_.length; ++i) {
            if (ILidoWithFinalizeUpgrade(LIDO).allowance(contractsWithBurnerAllowances_[i], OLD_BURNER) != INFINITE_ALLOWANCE) {
                revert IncorrectBurnerAllowance(contractsWithBurnerAllowances_[i], OLD_BURNER);
            }
        }
        if (ILidoWithFinalizeUpgrade(LIDO).allowance(NODE_OPERATORS_REGISTRY, OLD_BURNER) != 0) {
            revert IncorrectBurnerAllowance(NODE_OPERATORS_REGISTRY, OLD_BURNER);
        }
        if (ILidoWithFinalizeUpgrade(LIDO).allowance(SIMPLE_DVT, OLD_BURNER) != 0) {
            revert IncorrectBurnerAllowance(SIMPLE_DVT, OLD_BURNER);
        }

        if (!IBurner(BURNER).isMigrationAllowed()) revert BurnerMigrationNotAllowed();
    }

    function _assertPostUpgradeState() internal view {
        if (
            ILidoWithFinalizeUpgrade(LIDO).getTotalShares() != initialTotalShares ||
            ILidoWithFinalizeUpgrade(LIDO).getTotalPooledEther() != initialTotalPooledEther
        ) {
            revert TotalSharesOrPooledEtherChanged();
        }

        _assertProxyImplementation(IOssifiableProxy(LOCATOR), NEW_LOCATOR_IMPL);

        _assertContractVersion(IVersioned(LIDO), EXPECTED_FINAL_LIDO_VERSION);
        _assertContractVersion(IVersioned(ACCOUNTING_ORACLE), EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION);

        _assertFinalACL();

        _checkBurnerMigratedCorrectly();

        if (VaultFactory(VAULT_FACTORY).BEACON() != UPGRADEABLE_BEACON) {
            revert IncorrectVaultFactoryBeacon(VAULT_FACTORY, UPGRADEABLE_BEACON);
        }
        if (VaultFactory(VAULT_FACTORY).DASHBOARD_IMPL() != DASHBOARD_IMPL) {
            revert IncorrectVaultFactoryDashboardImplementation(VAULT_FACTORY, DASHBOARD_IMPL);
        }
        if (UpgradeableBeacon(UPGRADEABLE_BEACON).owner() != AGENT) {
            revert IncorrectUpgradeableBeaconOwner(UPGRADEABLE_BEACON, AGENT);
        }
        if (UpgradeableBeacon(UPGRADEABLE_BEACON).implementation() != STAKING_VAULT_IMPL) {
            revert IncorrectUpgradeableBeaconImplementation(UPGRADEABLE_BEACON, STAKING_VAULT_IMPL);
        }
    }

    function _assertFinalACL() internal view {
        // Burner
        bytes32 requestBurnSharesRole = IBurner(BURNER).REQUEST_BURN_SHARES_ROLE();
        _assertZeroOZRoleHolders(OLD_BURNER, requestBurnSharesRole);

        _assertProxyAdmin(IOssifiableProxy(BURNER), AGENT);
        _assertSingleOZRoleHolder(BURNER, DEFAULT_ADMIN_ROLE, AGENT);
        {
            address[] memory holders = new address[](2);
            holders[0] = ACCOUNTING;
            holders[1] = CSM_ACCOUNTING;
            _assertOZRoleHolders(BURNER, requestBurnSharesRole, holders);
        }

        // VaultHub
        _assertProxyAdmin(IOssifiableProxy(VAULT_HUB), AGENT);
        _assertSingleOZRoleHolder(VAULT_HUB, DEFAULT_ADMIN_ROLE, AGENT);

        _assertSingleOZRoleHolder(VAULT_HUB, VaultHub(VAULT_HUB).VAULT_MASTER_ROLE(), AGENT);
        _assertTwoOZRoleHolders(VAULT_HUB, VaultHub(VAULT_HUB).REDEMPTION_MASTER_ROLE(), AGENT, VAULTS_ADAPTER);

        _assertSingleOZRoleHolder(VAULT_HUB, VaultHub(VAULT_HUB).VALIDATOR_EXIT_ROLE(), VAULTS_ADAPTER);
        _assertSingleOZRoleHolder(VAULT_HUB, VaultHub(VAULT_HUB).BAD_DEBT_MASTER_ROLE(), VAULTS_ADAPTER);
        _assertSingleOZRoleHolder(VAULT_HUB, PausableUntilWithRoles(VAULT_HUB).PAUSE_ROLE(), GATE_SEAL);

        // OperatorGrid
        _assertProxyAdmin(IOssifiableProxy(OPERATOR_GRID), AGENT);
        _assertSingleOZRoleHolder(OPERATOR_GRID, DEFAULT_ADMIN_ROLE, AGENT);
        _assertThreeOZRoleHolders(OPERATOR_GRID, OperatorGrid(OPERATOR_GRID).REGISTRY_ROLE(), AGENT, EVM_SCRIPT_EXECUTOR, VAULTS_ADAPTER);

        // LazyOracle
        _assertProxyAdmin(IOssifiableProxy(LAZY_ORACLE), AGENT);
        _assertSingleOZRoleHolder(LAZY_ORACLE, DEFAULT_ADMIN_ROLE, AGENT);
        _assertSingleOZRoleHolder(LAZY_ORACLE, LazyOracle(LAZY_ORACLE).UPDATE_SANITY_PARAMS_ROLE(), AGENT);

        // AccountingOracle
        _assertSingleOZRoleHolder(ACCOUNTING_ORACLE, DEFAULT_ADMIN_ROLE, AGENT);

        // OracleReportSanityChecker
        IOracleReportSanityChecker checker = IOracleReportSanityChecker(ORACLE_REPORT_SANITY_CHECKER);
        _assertSingleOZRoleHolder(ORACLE_REPORT_SANITY_CHECKER, DEFAULT_ADMIN_ROLE, AGENT);
        bytes32[12] memory roles = [
            checker.ALL_LIMITS_MANAGER_ROLE(),
            checker.EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(),
            checker.APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(),
            checker.ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE(),
            checker.SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE(),
            checker.MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE(),
            checker.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE(),
            checker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE(),
            checker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE(),
            checker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
            checker.SECOND_OPINION_MANAGER_ROLE(),
            checker.INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE()
        ];
        for (uint256 i = 0; i < roles.length; ++i) {
            _assertZeroOZRoleHolders(ORACLE_REPORT_SANITY_CHECKER, roles[i]);
        }

        // Accounting
        _assertProxyAdmin(IOssifiableProxy(ACCOUNTING), AGENT);

        // PredepositGuarantee
        _assertProxyAdmin(IOssifiableProxy(PREDEPOSIT_GUARANTEE), AGENT);
        _assertSingleOZRoleHolder(PREDEPOSIT_GUARANTEE, DEFAULT_ADMIN_ROLE, AGENT);
        _assertSingleOZRoleHolder(PREDEPOSIT_GUARANTEE, PausableUntilWithRoles(PREDEPOSIT_GUARANTEE).PAUSE_ROLE(), GATE_SEAL);

        // StakingRouter
        bytes32 reportRewardsMintedRole = IStakingRouter(STAKING_ROUTER).REPORT_REWARDS_MINTED_ROLE();
        _assertSingleOZRoleHolder(STAKING_ROUTER, reportRewardsMintedRole, ACCOUNTING);

        _assertEasyTrackFactoriesAdded();
    }

    function _assertEasyTrackFactoriesAdded() internal view {
        IEasyTrack easyTrack = IEasyTrack(EASY_TRACK);
        address[] memory factories = easyTrack.getEVMScriptFactories();

        // The expected order of the last 9 EasyTrack factories
        address[9] memory expectedFactories = [
            ETF_ALTER_TIERS_IN_OPERATOR_GRID,
            ETF_REGISTER_GROUPS_IN_OPERATOR_GRID,
            ETF_REGISTER_TIERS_IN_OPERATOR_GRID,
            ETF_UPDATE_GROUPS_SHARE_LIMIT_IN_OPERATOR_GRID,
            ETF_SET_JAIL_STATUS_IN_OPERATOR_GRID,
            ETF_UPDATE_VAULTS_FEES_IN_OPERATOR_GRID,
            ETF_FORCE_VALIDATOR_EXITS_IN_VAULT_HUB,
            ETF_SET_LIABILITY_SHARES_TARGET_IN_VAULT_HUB,
            ETF_SOCIALIZE_BAD_DEBT_IN_VAULT_HUB
        ];

        uint256 numFactories = factories.length;
        if (numFactories < expectedFactories.length) {
            revert UnexpectedEasyTrackFactories();
        }

        for (uint256 i = 0; i < expectedFactories.length; ++i) {
            if (factories[numFactories - expectedFactories.length + i] != expectedFactories[i]) {
                revert UnexpectedEasyTrackFactories();
            }
        }
    }

    function _checkBurnerMigratedCorrectly() internal view {
        if (IBurner(OLD_BURNER).getCoverSharesBurnt() != IBurner(BURNER).getCoverSharesBurnt()) {
            revert IncorrectBurnerSharesMigration("Cover shares burnt mismatch");
        }

        if (IBurner(OLD_BURNER).getNonCoverSharesBurnt() != IBurner(BURNER).getNonCoverSharesBurnt()) {
            revert IncorrectBurnerSharesMigration("Non-cover shares burnt mismatch");
        }

        (uint256 oldCoverShares, uint256 oldNonCoverShares) = IBurner(OLD_BURNER).getSharesRequestedToBurn();
        (uint256 newCoverShares, uint256 newNonCoverShares) = IBurner(BURNER).getSharesRequestedToBurn();
        if (oldCoverShares != newCoverShares) {
            revert IncorrectBurnerSharesMigration("Cover shares requested to burn mismatch");
        }

        if (oldNonCoverShares != newNonCoverShares) {
            revert IncorrectBurnerSharesMigration("Non-cover shares requested to burn mismatch");
        }

        if (ILidoWithFinalizeUpgrade(LIDO).balanceOf(OLD_BURNER) != 0) {
            revert IncorrectBurnerSharesMigration("Old burner stETH balance is not zero");
        }

        if (ILidoWithFinalizeUpgrade(LIDO).sharesOf(BURNER) != initialOldBurnerStethSharesBalance) {
            revert IncorrectBurnerSharesMigration("New burner stETH balance mismatch");
        }

        if (IBurner(BURNER).isMigrationAllowed()) {
            revert IncorrectBurnerSharesMigration("Burner migration is still allowed");
        }

        address[] memory contractsWithBurnerAllowances_ = contractsWithBurnerAllowances;
        for (uint256 i = 0; i < contractsWithBurnerAllowances_.length; i++) {
            if (ILidoWithFinalizeUpgrade(LIDO).allowance(contractsWithBurnerAllowances_[i], OLD_BURNER) != 0) {
                revert IncorrectBurnerAllowance(contractsWithBurnerAllowances_[i], OLD_BURNER);
            }
            if (ILidoWithFinalizeUpgrade(LIDO).allowance(contractsWithBurnerAllowances_[i], BURNER) != INFINITE_ALLOWANCE) {
                revert IncorrectBurnerAllowance(contractsWithBurnerAllowances_[i], BURNER);
            }
        }
    }

    function _assertProxyAdmin(IOssifiableProxy _proxy, address _admin) internal view {
        if (_proxy.proxy__getAdmin() != _admin) revert IncorrectProxyAdmin(address(_proxy));
    }

    function _assertProxyImplementation(IOssifiableProxy _proxy, address _implementation) internal view {
        address actualImplementation = _proxy.proxy__getImplementation();
        if (actualImplementation != _implementation) {
            revert IncorrectProxyImplementation(address(_proxy), actualImplementation);
        }
    }

    function _assertZeroOZRoleHolders(address _accessControlled, bytes32 _role) internal view {
        IAccessControlEnumerable accessControlled = IAccessControlEnumerable(_accessControlled);
        if (accessControlled.getRoleMemberCount(_role) != 0) {
            revert NonZeroRoleHolders(address(accessControlled), _role);
        }
    }

    function _assertSingleOZRoleHolder(
        address _accessControlled, bytes32 _role, address _holder
    ) internal view {
        IAccessControlEnumerable accessControlled = IAccessControlEnumerable(_accessControlled);
        if (accessControlled.getRoleMemberCount(_role) != 1
         || accessControlled.getRoleMember(_role, 0) != _holder
        ) {
            revert IncorrectOZAccessControlRoleHolders(address(accessControlled), _role);
        }
    }

    function _assertTwoOZRoleHolders(
        address _accessControlled, bytes32 _role, address _holder1, address _holder2
    ) internal view {
        address[] memory holders = new address[](2);
        holders[0] = _holder1;
        holders[1] = _holder2;
        _assertOZRoleHolders(_accessControlled, _role, holders);
    }

    function _assertThreeOZRoleHolders(
        address _accessControlled, bytes32 _role, address _holder1, address _holder2, address _holder3
    ) internal view {
        address[] memory holders = new address[](3);
        holders[0] = _holder1;
        holders[1] = _holder2;
        holders[2] = _holder3;
        _assertOZRoleHolders(_accessControlled, _role, holders);
    }

    function _assertOZRoleHolders(
        address _accessControlled, bytes32 _role, address[] memory _holders
    ) internal view {
        IAccessControlEnumerable accessControlled = IAccessControlEnumerable(_accessControlled);
        if (accessControlled.getRoleMemberCount(_role) != _holders.length) {
            revert IncorrectOZAccessControlRoleHolders(address(accessControlled), _role);
        }
        for (uint256 i = 0; i < _holders.length; i++) {
            if (accessControlled.getRoleMember(_role, i) != _holders[i]) {
                revert IncorrectOZAccessControlRoleHolders(address(accessControlled), _role);
            }
        }
    }

    function _assertAragonAppImplementation(IAragonAppRepo _repo, address _implementation) internal view {
        (, address actualImplementation, ) = _repo.getLatest();
        if (actualImplementation != _implementation) {
            revert IncorrectAragonAppImplementation(address(_repo), _implementation);
        }
    }

    function _assertContractVersion(IVersioned _versioned, uint256 _expectedVersion) internal view {
        if (_versioned.getContractVersion() != _expectedVersion) {
            revert InvalidContractVersion(address(_versioned), _expectedVersion);
        }
    }

    function _isStartCalledInThisTx() internal view returns (bool isStartCalledInThisTx) {
        assembly {
            isStartCalledInThisTx := tload(UPGRADE_STARTED_SLOT)
        }
    }

    error OnlyAgentCanUpgrade();
    error UpgradeAlreadyStarted();
    error UpgradeAlreadyFinished();
    error IncorrectProxyAdmin(address proxy);
    error IncorrectProxyImplementation(address proxy, address implementation);
    error InvalidContractVersion(address contractAddress, uint256 actualVersion);
    error IncorrectOZAccessControlRoleHolders(address contractAddress, bytes32 role);
    error NonZeroRoleHolders(address contractAddress, bytes32 role);
    error IncorrectAragonAppImplementation(address repo, address implementation);
    error StartAndFinishMustBeInSameBlock();
    error StartAndFinishMustBeInSameTx();
    error StartAlreadyCalledInThisTx();
    error Expired();
    error IncorrectBurnerSharesMigration(string reason);
    error IncorrectBurnerAllowance(address contractAddress, address burner);
    error BurnerMigrationNotAllowed();
    error IncorrectVaultFactoryBeacon(address factory, address beacon);
    error IncorrectVaultFactoryDashboardImplementation(address factory, address delegation);
    error IncorrectUpgradeableBeaconOwner(address beacon, address owner);
    error IncorrectUpgradeableBeaconImplementation(address beacon, address implementation);
    error TotalSharesOrPooledEtherChanged();
    error UnexpectedEasyTrackFactories();
}
