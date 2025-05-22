// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IAccessControlEnumerable} from "@openzeppelin/contracts-v4.4/access/AccessControlEnumerable.sol";
import {IBurner as IBurnerWithoutAccessControl} from "contracts/common/interfaces/IBurner.sol";
import {ILido} from "contracts/0.8.25/interfaces/ILido.sol";
import {IVersioned} from "contracts/common/interfaces/IVersioned.sol";
import {IOssifiableProxy} from "./interfaces/IOssifiableProxy.sol";
import {V3Addresses} from "./V3Addresses.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {VaultFactory} from "contracts/0.8.25/vaults/VaultFactory.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/UpgradeableBeacon.sol";
import {OperatorGrid} from "contracts/0.8.25/vaults/OperatorGrid.sol";
import {V3Addresses} from "./V3Addresses.sol";

interface IBaseOracle is IAccessControlEnumerable, IVersioned {
    function getConsensusContract() external view returns (address);
}

interface IStakingRouter is IAccessControlEnumerable {
    function REPORT_REWARDS_MINTED_ROLE() external view returns (bytes32);
}

interface IBurner is IBurnerWithoutAccessControl, IAccessControlEnumerable {
    function REQUEST_BURN_SHARES_ROLE() external view returns (bytes32);
    function isMigrationAllowed() external view returns (bool);
}

interface ILidoWithFinalizeUpgrade is ILido {
    function finalizeUpgrade_v3(address _oldBurner, address[4] calldata _contractsWithBurnerAllowances) external;
}

interface IAccountingOracle is IBaseOracle {
    function finalizeUpgrade_v3(uint256 consensusVersion) external;
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
*   - `startUpgrade()` after upgrading LidoLocator and before everything else
*   - `finishUpgrade()` as the last step of the upgrade
*/
contract V3Template is V3Addresses {
    //
    // Events
    //

    event UpgradeFinished();

    //
    // -------- Constants --------
    //

    uint256 internal constant ACCOUNTING_ORACLE_CONSENSUS_VERSION = 4;
    uint256 internal constant EXPECTED_FINAL_LIDO_VERSION = 3;
    uint256 internal constant EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION = 3;

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    // Timestamp since startUpgrade() and finishUpgrade() revert with Expired()
    // This behavior is introduced to disarm the template if the upgrade voting creation or enactment didn't
    // happen in proper time period
    uint256 public constant EXPIRE_SINCE_INCLUSIVE = 1761868800; // 2025-10-31 00:00:00 UTC

    // Initial value of upgradeBlockNumber storage variable
    uint256 internal constant UPGRADE_NOT_STARTED = 0;

    uint256 internal constant INFINITE_ALLOWANCE = type(uint256).max;

    //
    // Structured storage
    //

    uint256 public upgradeBlockNumber = UPGRADE_NOT_STARTED;
    bool public isUpgradeFinished;
    uint256 internal initialOldBurnerStethSharesBalance;
    uint256 internal initialTotalShares;
    uint256 internal initialTotalPooledEther;


    /// @param _params Params required to initialize the addresses contract
    constructor(V3AddressesParams memory _params) V3Addresses(_params) {
    }

    /// @notice Must be called after LidoLocator is upgraded
    function startUpgrade() external {
        if (msg.sender != AGENT) revert OnlyVotingCanUpgrade();
        if (block.timestamp >= EXPIRE_SINCE_INCLUSIVE) revert Expired();
        if (upgradeBlockNumber != UPGRADE_NOT_STARTED) revert UpgradeAlreadyStarted();

        upgradeBlockNumber = block.number;

        initialTotalShares = ILidoWithFinalizeUpgrade(LIDO).getTotalShares();
        initialTotalPooledEther = ILidoWithFinalizeUpgrade(LIDO).getTotalPooledEther();

        _assertPreUpgradeState();

        // Save initial state for the check after burner migration
        initialOldBurnerStethSharesBalance = ILidoWithFinalizeUpgrade(LIDO).sharesOf(OLD_BURNER);
    }

    function finishUpgrade() external {
        if (msg.sender != AGENT) revert OnlyVotingCanUpgrade();
        if (upgradeBlockNumber != block.number) revert StartAndFinishMustBeInSameBlock();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();

        isUpgradeFinished = true;

        ILidoWithFinalizeUpgrade(LIDO).finalizeUpgrade_v3(OLD_BURNER, [
            WITHDRAWAL_QUEUE,
            NODE_OPERATORS_REGISTRY,
            SIMPLE_DVT,
            CSM_ACCOUNTING
        ]);

        IAccountingOracle(ACCOUNTING_ORACLE).finalizeUpgrade_v3(ACCOUNTING_ORACLE_CONSENSUS_VERSION);

        _assertPostUpgradeState();

        emit UpgradeFinished();
    }

    function _assertPreUpgradeState() internal view {
        // Check initial implementations of the proxies to be upgraded
        _assertProxyImplementation(IOssifiableProxy(LOCATOR), OLD_LOCATOR_IMPLEMENTATION);
        _assertProxyImplementation(IOssifiableProxy(ACCOUNTING_ORACLE), OLD_ACCOUNTING_ORACLE_IMPLEMENTATION);
        _assertAragonAppImplementation(IAragonAppRepo(ARAGON_APP_LIDO_REPO), OLD_LIDO_IMPLEMENTATION);

        // Check allowances of the old burner
        address[4] memory contracts = [
            WITHDRAWAL_QUEUE,
            NODE_OPERATORS_REGISTRY,
            SIMPLE_DVT,
            CSM_ACCOUNTING
        ];
        for (uint256 i = 0; i < contracts.length; ++i) {
            if (ILidoWithFinalizeUpgrade(LIDO).allowance(contracts[i], OLD_BURNER) != INFINITE_ALLOWANCE) {
                revert IncorrectBurnerAllowance(contracts[i], OLD_BURNER);
            }
        }
    }

    function _assertPostUpgradeState() internal view {
        if (
            ILidoWithFinalizeUpgrade(LIDO).getTotalShares() != initialTotalShares ||
            ILidoWithFinalizeUpgrade(LIDO).getTotalPooledEther() != initialTotalPooledEther
        ) {
            revert TotalSharesOrPooledEtherChanged();
        }

        _assertProxyImplementation(IOssifiableProxy(LOCATOR), NEW_LOCATOR_IMPLEMENTATION);

        _assertContractVersion(IVersioned(LIDO), EXPECTED_FINAL_LIDO_VERSION);
        _assertContractVersion(IVersioned(ACCOUNTING_ORACLE), EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION);

        _assertFinalACL();

        _checkBurnerMigratedCorrectly();

        if (VaultFactory(VAULT_FACTORY).BEACON() != UPGRADEABLE_BEACON) {
            revert IncorrectVaultFactoryBeacon(VAULT_FACTORY, UPGRADEABLE_BEACON);
        }
        if (VaultFactory(VAULT_FACTORY).DASHBOARD_IMPL() != DASHBOARD_IMPLEMENTATION) {
            revert IncorrectVaultFactoryDashboardImplementation(VAULT_FACTORY, DASHBOARD_IMPLEMENTATION);
        }
        if (UpgradeableBeacon(UPGRADEABLE_BEACON).owner() != AGENT) {
            revert IncorrectUpgradeableBeaconOwner(UPGRADEABLE_BEACON, AGENT);
        }
        if (UpgradeableBeacon(UPGRADEABLE_BEACON).implementation() != STAKING_VAULT_IMPLEMENTATION) {
            revert IncorrectUpgradeableBeaconImplementation(UPGRADEABLE_BEACON, STAKING_VAULT_IMPLEMENTATION);
        }
    }

    function _assertFinalACL() internal view {
        address agent = AGENT;

        // Burner
        bytes32 requestBurnSharesRole = IBurner(BURNER).REQUEST_BURN_SHARES_ROLE();
        _assertSingleOZRoleHolder(IBurner(BURNER), DEFAULT_ADMIN_ROLE, agent);
        {
            address[] memory holders = new address[](4);
            holders[0] = LIDO;
            holders[1] = NODE_OPERATORS_REGISTRY;
            holders[2] = SIMPLE_DVT;
            holders[3] = ACCOUNTING;
            _assertOZRoleHolders(IBurner(BURNER), requestBurnSharesRole, holders);
        }
        _assertZeroOZRoleHolders(IBurner(OLD_BURNER), requestBurnSharesRole);

        // VaultHub
        _assertSingleOZRoleHolder(IAccessControlEnumerable(VAULT_HUB), DEFAULT_ADMIN_ROLE, agent);
        _assertSingleOZRoleHolder(IAccessControlEnumerable(VAULT_HUB), VaultHub(VAULT_HUB).VAULT_MASTER_ROLE(), agent);
        _assertZeroOZRoleHolders(IAccessControlEnumerable(VAULT_HUB), VaultHub(VAULT_HUB).VAULT_REGISTRY_ROLE());
        _assertProxyAdmin(IOssifiableProxy(VAULT_HUB), agent);
        // TODO: add PausableUntilWithRoles checks when gate seal is added

        // AccountingOracle
        _assertSingleOZRoleHolder(IAccountingOracle(ACCOUNTING_ORACLE), DEFAULT_ADMIN_ROLE, agent);

        // OracleReportSanityChecker
        IOracleReportSanityChecker checker = IOracleReportSanityChecker(ORACLE_REPORT_SANITY_CHECKER);
        _assertSingleOZRoleHolder(checker, DEFAULT_ADMIN_ROLE, AGENT);

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
            _assertZeroOZRoleHolders(checker, roles[i]);
        }

        // Accounting
        _assertProxyAdmin(IOssifiableProxy(ACCOUNTING), agent);

        // PredepositGuarantee
        _assertProxyAdmin(IOssifiableProxy(PREDEPOSIT_GUARANTEE), agent);

        // StakingRouter
        {
            address[] memory holders = new address[](2);
            holders[0] = LIDO;
            holders[1] = ACCOUNTING;
            _assertOZRoleHolders(IAccessControlEnumerable(STAKING_ROUTER), IStakingRouter(STAKING_ROUTER).REPORT_REWARDS_MINTED_ROLE(), holders);
        }

        // OperatorGrid
        _assertProxyAdmin(IOssifiableProxy(OPERATOR_GRID), agent);
        _assertSingleOZRoleHolder(IAccessControlEnumerable(OPERATOR_GRID), DEFAULT_ADMIN_ROLE, agent);
        _assertSingleOZRoleHolder(IAccessControlEnumerable(OPERATOR_GRID), OperatorGrid(OPERATOR_GRID).REGISTRY_ROLE(), agent);
    }

    function _checkBurnerMigratedCorrectly() internal view {
        (uint256 oldCoverShares, uint256 oldNonCoverShares) = IBurner(OLD_BURNER).getSharesRequestedToBurn();
        (uint256 newCoverShares, uint256 newNonCoverShares) = IBurner(BURNER).getSharesRequestedToBurn();
        if (
            IBurner(OLD_BURNER).getCoverSharesBurnt() != IBurner(BURNER).getCoverSharesBurnt() ||
            IBurner(OLD_BURNER).getNonCoverSharesBurnt() != IBurner(BURNER).getNonCoverSharesBurnt() ||
            oldCoverShares != newCoverShares ||
            oldNonCoverShares != newNonCoverShares ||
            ILidoWithFinalizeUpgrade(LIDO).balanceOf(OLD_BURNER) != 0 ||
            ILidoWithFinalizeUpgrade(LIDO).balanceOf(BURNER) != initialOldBurnerStethSharesBalance ||
            IBurner(BURNER).isMigrationAllowed()
        ) {
            revert IncorrectBurnerSharesMigration();
        }

        address[4] memory contracts = [
            WITHDRAWAL_QUEUE,
            SIMPLE_DVT,
            NODE_OPERATORS_REGISTRY,
            CSM_ACCOUNTING
        ];
        for (uint256 i = 0; i < contracts.length; i++) {
            if (ILidoWithFinalizeUpgrade(LIDO).allowance(contracts[i], OLD_BURNER) != 0) {
                revert IncorrectBurnerAllowance(contracts[i], OLD_BURNER);
            }
            if (ILidoWithFinalizeUpgrade(LIDO).allowance(contracts[i], BURNER) != INFINITE_ALLOWANCE) {
                revert IncorrectBurnerAllowance(contracts[i], BURNER);
            }
        }
    }

    function _assertProxyAdmin(IOssifiableProxy proxy, address admin) internal view {
        if (proxy.proxy__getAdmin() != admin) revert IncorrectProxyAdmin(address(proxy));
    }

    function _assertProxyImplementation(IOssifiableProxy proxy, address implementation) internal view {
        address actualImplementation = proxy.proxy__getImplementation();
        if (actualImplementation != implementation) {
            revert IncorrectProxyImplementation(address(proxy), actualImplementation);
        }
    }

    function _assertZeroOZRoleHolders(IAccessControlEnumerable accessControlled, bytes32 role) internal view {
        if (accessControlled.getRoleMemberCount(role) != 0) {
            revert NonZeroRoleHolders(address(accessControlled), role);
        }
    }

    function _assertSingleOZRoleHolder(
        IAccessControlEnumerable accessControlled, bytes32 role, address holder
    ) internal view {
        if (accessControlled.getRoleMemberCount(role) != 1
         || accessControlled.getRoleMember(role, 0) != holder
        ) {
            revert IncorrectOZAccessControlRoleHolders(address(accessControlled), role);
        }
    }

    function _assertOZRoleHolders(
        IAccessControlEnumerable accessControlled, bytes32 role, address[] memory holders
    ) internal view {
        if (accessControlled.getRoleMemberCount(role) != holders.length) {
            revert IncorrectOZAccessControlRoleHolders(address(accessControlled), role);
        }
        for (uint256 i = 0; i < holders.length; i++) {
            if (accessControlled.getRoleMember(role, i) != holders[i]) {
                revert IncorrectOZAccessControlRoleHolders(address(accessControlled), role);
            }
        }
    }

    function _assertAragonAppImplementation(IAragonAppRepo repo, address implementation) internal view {
        (, address actualImplementation, ) = repo.getLatest();
        if (actualImplementation != implementation) {
            revert IncorrectAragonAppImplementation(address(repo), implementation);
        }
    }

    function _assertContractVersion(IVersioned versioned, uint256 expectedVersion) internal view {
        if (versioned.getContractVersion() != expectedVersion) {
            revert InvalidContractVersion(address(versioned), expectedVersion);
        }
    }

    error OnlyVotingCanUpgrade();
    error UpgradeAlreadyStarted();
    error UpgradeAlreadyFinished();
    error IncorrectProxyAdmin(address proxy);
    error IncorrectProxyImplementation(address proxy, address implementation);
    error InvalidContractVersion(address contractAddress, uint256 actualVersion);
    error IncorrectOZAccessControlRoleHolders(address contractAddress, bytes32 role);
    error NonZeroRoleHolders(address contractAddress, bytes32 role);
    error IncorrectAragonAppImplementation(address repo, address implementation);
    error StartAndFinishMustBeInSameBlock();
    error Expired();
    error IncorrectBurnerSharesMigration();
    error IncorrectBurnerAllowance(address contractAddress, address burner);
    error IncorrectVaultFactoryBeacon(address factory, address beacon);
    error IncorrectVaultFactoryDashboardImplementation(address factory, address delegation);
    error IncorrectUpgradeableBeaconOwner(address beacon, address owner);
    error IncorrectUpgradeableBeaconImplementation(address beacon, address implementation);
    error TotalSharesOrPooledEtherChanged();
}
