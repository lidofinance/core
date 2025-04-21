// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import { IAccessControlEnumerable } from "@openzeppelin/contracts-v4.4/access/AccessControlEnumerable.sol";
import { IBurner as IBurnerWithoutAccessControl } from "contracts/common/interfaces/IBurner.sol";
import { ILido } from "contracts/0.8.25/interfaces/ILido.sol";
import { ILidoLocator } from "contracts/common/interfaces/ILidoLocator.sol";
import { IVersioned } from "contracts/common/interfaces/IVersioned.sol";


interface IPausableUntil {
    function isPaused() external view returns (bool);
    function getResumeSinceTimestamp() external view returns (uint256);
    function PAUSE_INFINITELY() external view returns (uint256);
}

interface IPausableUntilWithRoles is IPausableUntil, IAccessControlEnumerable {
}

interface IOperatorGrid is IAccessControlEnumerable {
    function REGISTRY_ROLE() external view returns (bytes32);
}

interface IOssifiableProxy {
    function proxy__upgradeTo(address newImplementation) external;
    function proxy__changeAdmin(address newAdmin) external;
    function proxy__getAdmin() external view returns (address);
    function proxy__getImplementation() external view returns (address);
}

interface IBaseOracle is IAccessControlEnumerable, IVersioned {
    function getConsensusContract() external view returns (address);
}

interface IBurner is IBurnerWithoutAccessControl, IAccessControlEnumerable {
    function REQUEST_BURN_SHARES_ROLE() external view returns (bytes32);
    function REQUEST_BURN_MY_STETH_ROLE() external view returns (bytes32);
}

interface ILidoLocatorOld {
    function accountingOracle() external view returns(address);
    function depositSecurityModule() external view returns(address);
    function elRewardsVault() external view returns(address);
    function legacyOracle() external view returns(address);
    function lido() external view returns(address);
    function oracleReportSanityChecker() external view returns(address);
    function burner() external view returns(address);
    function stakingRouter() external view returns(address);
    function treasury() external view returns(address);
    function validatorsExitBusOracle() external view returns(address);
    function withdrawalQueue() external view returns(address);
    function withdrawalVault() external view returns(address);
    function postTokenRebaseReceiver() external view returns(address);
    function oracleDaemonConfig() external view returns(address);
}

interface IAccountingOracle is IBaseOracle {
    function initialize(address admin, address consensusContract, uint256 consensusVersion) external;
}

interface IAragonAppRepo {
    function getLatest() external view returns (uint16[3] memory, address, bytes memory);
}

interface IStakingRouter is IAccessControlEnumerable {
    function REPORT_REWARDS_MINTED_ROLE() external view returns (bytes32);
}

interface IUpgradeableBeacon {
    function implementation() external view returns (address);
    function owner() external view returns (address);
}

interface IWithdrawalsManagerProxy {
    function proxy_getAdmin() external view returns (address);
    function implementation() external view returns (address);
}

interface IVaultFactory {
    function BEACON() external view returns (address);
    function DASHBOARD_IMPL() external view returns (address);
}

interface IVaultHub is IPausableUntilWithRoles {
    function VAULT_MASTER_ROLE() external view returns (bytes32);
    function VAULT_REGISTRY_ROLE() external view returns (bytes32);
    function RESUME_ROLE() external view returns (bytes32);
    function PAUSE_ROLE() external view returns (bytes32);
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
contract UpgradeTemplateV3 {
    //
    // Events
    //
    event UpgradeFinished();

    struct UpgradeTemplateV3Params {
        // New non-proxy contracts
        address vaultFactory;

        // New fancy proxy contracts
        address upgradeableBeacon;
        address stakingVaultImplementation;
        address dashboardImplementation;

        // New Aragon apps implementations
        address lidoImplementation;

        // New non-aragon implementations
        address accountingOracleImplementation;
        address newLocatorImplementation;

        // Existing proxies and contracts
        address oldLocatorImpl;
        address agent;
        address aragonAppLidoRepo;
        address csmAccounting;
        address locator; // not upgraded at the time of the template creation
        address nodeOperatorsRegistry;
        address simpleDvt;
        address voting;
    }

    // Old upgraded non-proxy contracts
    IBurner public immutable OLD_BURNER;
    IOracleReportSanityChecker public immutable OLD_ORACLE_REPORT_SANITY_CHECKER;

    // New proxy contracts
    address public immutable ACCOUNTING;
    IVaultHub public immutable VAULT_HUB;
    address public immutable PREDEPOSIT_GUARANTEE;

    // New non-proxy contracts
    IBurner public immutable BURNER;
    IOracleReportSanityChecker public immutable ORACLE_REPORT_SANITY_CHECKER;
    IVaultFactory public immutable VAULT_FACTORY;

    // New fancy proxy contracts
    IUpgradeableBeacon public immutable UPGRADEABLE_BEACON;
    address public immutable STAKING_VAULT_IMPLEMENTATION;
    address public immutable DASHBOARD_IMPLEMENTATION;

    // Aragon Apps new implementations
    address public immutable LIDO_IMPLEMENTATION;

    // New non-aragon implementations
    address public immutable ACCOUNTING_ORACLE_IMPLEMENTATION;
    address public immutable NEW_LOCATOR_IMPLEMENTATION;

    // Existing proxies and contracts
    address public immutable AGENT;
    IAragonAppRepo public immutable ARAGON_APP_LIDO_REPO;
    IAccountingOracle public immutable ACCOUNTING_ORACLE;
    address public immutable CSM_ACCOUNTING;
    address public immutable EL_REWARDS_VAULT;
    ILido public immutable LIDO;
    ILidoLocator public immutable LOCATOR;
    address public immutable NODE_OPERATORS_REGISTRY;
    IOperatorGrid public immutable OPERATOR_GRID;
    address public immutable SIMPLE_DVT;
    IStakingRouter public immutable STAKING_ROUTER;
    address public immutable VALIDATORS_EXIT_BUS_ORACLE;
    address public immutable VOTING;
    address public immutable WITHDRAWAL_QUEUE;
    address public immutable WSTETH;

    // Roles
    // (stored as immutables initialized from contracts)
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    // Burner
    bytes32 public immutable REQUEST_BURN_SHARES_ROLE;
    bytes32 public immutable REQUEST_BURN_MY_STETH_ROLE;
    // PauseUntilWithRoles
    bytes32 public immutable RESUME_ROLE;
    bytes32 public immutable PAUSE_ROLE;
    // OracleReportSanityChecker
    bytes32 public immutable ALL_LIMITS_MANAGER_ROLE;
    bytes32 public immutable EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE;
    bytes32 public immutable APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE;
    bytes32 public immutable ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE;
    bytes32 public immutable SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE;
    bytes32 public immutable MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE;
    bytes32 public immutable MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE;
    bytes32 public immutable MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE;
    bytes32 public immutable REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE;
    bytes32 public immutable MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE;
    bytes32 public immutable SECOND_OPINION_MANAGER_ROLE;
    bytes32 public immutable INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE;
    // StakingRouter
    bytes32 public immutable REPORT_REWARDS_MINTED_ROLE;
    // VaultHub
    bytes32 public immutable VAULT_MASTER_ROLE;
    bytes32 public immutable VAULT_REGISTRY_ROLE;
    // OperatorGrid
    bytes32 public immutable REGISTRY_ROLE;

    //
    // Values for checks to compare with or other
    //

    uint256 internal constant EXPECTED_FINAL_LIDO_VERSION = 3;
    uint256 internal constant EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION = 3;

    //
    // Constants
    //

    // Timestamp since startUpgrade() and finishUpgrade() revert with Expired()
    // This behavior is introduced to disarm the template if the upgrade voting creation or enactment didn't
    // happen in proper time period
    uint256 public constant EXPIRE_SINCE_INCLUSIVE = 1754006400; // 2025-08-01 00:00:00 UTC

    // Initial value of _upgradeBlockNumber
    uint256 internal constant UPGRADE_NOT_STARTED = 0;

    //
    // Structured storage
    //
    uint256 private _upgradeBlockNumber = UPGRADE_NOT_STARTED;
    bool public _isUpgradeFinished;
    uint256 internal _initialOldBurnerStethBalance;


    /// @param params Parameters for the upgrade template
    constructor(UpgradeTemplateV3Params memory params) {
        if (params.newLocatorImplementation == params.oldLocatorImpl) {
            revert NewAndOldLocatorImplementationsMustBeDifferent();
        }

        NEW_LOCATOR_IMPLEMENTATION = params.newLocatorImplementation;
        LOCATOR = ILidoLocator(params.locator);

        ILidoLocatorOld oldLocatorImpl = ILidoLocatorOld(params.oldLocatorImpl);
        OLD_BURNER = IBurner(oldLocatorImpl.burner());
        OLD_ORACLE_REPORT_SANITY_CHECKER = IOracleReportSanityChecker(oldLocatorImpl.oracleReportSanityChecker());
        ACCOUNTING_ORACLE = IAccountingOracle(oldLocatorImpl.accountingOracle());
        EL_REWARDS_VAULT = oldLocatorImpl.elRewardsVault();
        STAKING_ROUTER = IStakingRouter(oldLocatorImpl.stakingRouter());
        LIDO = ILido(oldLocatorImpl.lido());
        VALIDATORS_EXIT_BUS_ORACLE = oldLocatorImpl.validatorsExitBusOracle();
        WITHDRAWAL_QUEUE = oldLocatorImpl.withdrawalQueue();

        ILidoLocator newLocatorImpl = ILidoLocator(params.newLocatorImplementation);
        ACCOUNTING = newLocatorImpl.accounting();
        VAULT_HUB = IVaultHub(newLocatorImpl.vaultHub());
        PREDEPOSIT_GUARANTEE = newLocatorImpl.predepositGuarantee();
        BURNER = IBurner(newLocatorImpl.burner());
        WSTETH = newLocatorImpl.wstETH();
        ORACLE_REPORT_SANITY_CHECKER = IOracleReportSanityChecker(newLocatorImpl.oracleReportSanityChecker());
        OPERATOR_GRID = IOperatorGrid(newLocatorImpl.operatorGrid());

        VAULT_FACTORY = IVaultFactory(params.vaultFactory);
        UPGRADEABLE_BEACON = IUpgradeableBeacon(params.upgradeableBeacon);
        STAKING_VAULT_IMPLEMENTATION = params.stakingVaultImplementation;
        DASHBOARD_IMPLEMENTATION = params.dashboardImplementation;
        AGENT = params.agent;
        ARAGON_APP_LIDO_REPO = IAragonAppRepo(params.aragonAppLidoRepo);
        VOTING = params.voting;
        CSM_ACCOUNTING = params.csmAccounting;
        NODE_OPERATORS_REGISTRY = params.nodeOperatorsRegistry;
        SIMPLE_DVT = params.simpleDvt;
        LIDO_IMPLEMENTATION = params.lidoImplementation;
        ACCOUNTING_ORACLE_IMPLEMENTATION = params.accountingOracleImplementation;

        // Initialize Burner roles
        REQUEST_BURN_SHARES_ROLE = BURNER.REQUEST_BURN_SHARES_ROLE();
        REQUEST_BURN_MY_STETH_ROLE = BURNER.REQUEST_BURN_MY_STETH_ROLE();

        // Initialize PauseUntilWithRoles roles
        RESUME_ROLE = VAULT_HUB.RESUME_ROLE();
        PAUSE_ROLE = VAULT_HUB.PAUSE_ROLE();

        // Initialize OracleReportSanityChecker roles
        ALL_LIMITS_MANAGER_ROLE = ORACLE_REPORT_SANITY_CHECKER.ALL_LIMITS_MANAGER_ROLE();
        EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE = ORACLE_REPORT_SANITY_CHECKER.EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE();
        APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE = ORACLE_REPORT_SANITY_CHECKER.APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE();
        ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE = ORACLE_REPORT_SANITY_CHECKER.ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE();
        SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE = ORACLE_REPORT_SANITY_CHECKER.SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE();
        MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE = ORACLE_REPORT_SANITY_CHECKER.MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE();
        MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE = ORACLE_REPORT_SANITY_CHECKER.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE();
        MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE = ORACLE_REPORT_SANITY_CHECKER.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE();
        REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE = ORACLE_REPORT_SANITY_CHECKER.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE();
        MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE = ORACLE_REPORT_SANITY_CHECKER.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE();
        SECOND_OPINION_MANAGER_ROLE = ORACLE_REPORT_SANITY_CHECKER.SECOND_OPINION_MANAGER_ROLE();
        INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE = ORACLE_REPORT_SANITY_CHECKER.INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE();

        // Initialize StakingRouter roles
        REPORT_REWARDS_MINTED_ROLE = STAKING_ROUTER.REPORT_REWARDS_MINTED_ROLE();

        // Initialize VaultHub roles
        VAULT_MASTER_ROLE = VAULT_HUB.VAULT_MASTER_ROLE();
        VAULT_REGISTRY_ROLE = VAULT_HUB.VAULT_REGISTRY_ROLE();

        // Initialize OperatorGrid roles
        REGISTRY_ROLE = OPERATOR_GRID.REGISTRY_ROLE();
    }

    /// @notice Must be called after LidoLocator is upgraded
    function startUpgrade() external {
        if (msg.sender != VOTING) revert OnlyVotingCanUpgrade();
        _assertNotExpired();
        if (_isUpgradeFinished) revert UpgradeAlreadyFinished();

        if (_upgradeBlockNumber != UPGRADE_NOT_STARTED) revert UpgradeAlreadyStarted();
        _upgradeBlockNumber = block.number;

        // Save initial state for the check after burner migration
        _initialOldBurnerStethBalance = LIDO.balanceOf(address(OLD_BURNER));

        _assertProxyImplementation(IOssifiableProxy(address(LOCATOR)), NEW_LOCATOR_IMPLEMENTATION);
        _assertNewLocatorAddresses();
        _assertOldBurnerAllowances();
    }

    function finishUpgrade() external {
        if (msg.sender != VOTING) revert OnlyVotingCanUpgrade();
        _assertNotExpired();
        if (_isUpgradeFinished) revert CanOnlyFinishOnce();
        _isUpgradeFinished = true;

        if (_upgradeBlockNumber != block.number) revert StartAndFinishMustBeInSameBlock();

        _passAdminRolesFromTemplateToAgent();

        _assertStateAfterUpgrade();

        emit UpgradeFinished();
    }

    function _assertNewLocatorAddresses() internal view {
        ILidoLocator locator = LOCATOR;
        if (locator.burner() != address(BURNER)
         || locator.oracleReportSanityChecker() != address(ORACLE_REPORT_SANITY_CHECKER)
         || locator.accounting() != ACCOUNTING
         || locator.wstETH() != address(WSTETH)
         || locator.vaultHub() != address(VAULT_HUB)
         || locator.predepositGuarantee() != address(PREDEPOSIT_GUARANTEE)
        ) {
            revert IncorrectLocatorAddresses();
        }
    }

    function _assertOldBurnerAllowances() internal view {
        address oldBurner = address(OLD_BURNER);
        uint256 infiniteAllowance = type(uint256).max;

        if (LIDO.allowance(WITHDRAWAL_QUEUE, oldBurner) != infiniteAllowance) {
            revert IncorrectOldBurnerAllowance(WITHDRAWAL_QUEUE);
        }

        if (LIDO.allowance(SIMPLE_DVT, oldBurner) != infiniteAllowance) {
            revert IncorrectOldBurnerAllowance(SIMPLE_DVT);
        }

        if (LIDO.allowance(NODE_OPERATORS_REGISTRY, oldBurner) != infiniteAllowance) {
            revert IncorrectOldBurnerAllowance(NODE_OPERATORS_REGISTRY);
        }

        if (LIDO.allowance(CSM_ACCOUNTING, oldBurner) != infiniteAllowance) {
            revert IncorrectOldBurnerAllowance(CSM_ACCOUNTING);
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

    function _assertOracleReportSanityCheckerRoles() internal view {
        IOracleReportSanityChecker checker = ORACLE_REPORT_SANITY_CHECKER;
        _assertSingleOZRoleHolder(checker, DEFAULT_ADMIN_ROLE, AGENT);
        _assertZeroOZRoleHolders(checker, ALL_LIMITS_MANAGER_ROLE);
        _assertZeroOZRoleHolders(checker, EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE);
        _assertZeroOZRoleHolders(checker, APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE);
        _assertZeroOZRoleHolders(checker, ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE);
        _assertZeroOZRoleHolders(checker, SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE);
        _assertZeroOZRoleHolders(checker, MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE);
        _assertZeroOZRoleHolders(checker, MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE);
        _assertZeroOZRoleHolders(checker, MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE);
        _assertZeroOZRoleHolders(checker, REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE);
        _assertZeroOZRoleHolders(checker, MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE);
        _assertZeroOZRoleHolders(checker, SECOND_OPINION_MANAGER_ROLE);
        _assertZeroOZRoleHolders(checker, INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE);
    }

    function _assertInitialProxyImplementations() internal view {
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

    function _passAdminRolesFromTemplateToAgent() internal {
        _transferOZAdminFromThisToAgent(BURNER);
    }

    function _assertStateAfterUpgrade() internal view {
        _assertFinalACL();

        _checkContractVersions();

        _checkBurnerMigratedCorrectly();

        _assertAragonAppImplementation(ARAGON_APP_LIDO_REPO, LIDO_IMPLEMENTATION);

        _assertProxyImplementation(IOssifiableProxy(address(ACCOUNTING_ORACLE)), ACCOUNTING_ORACLE_IMPLEMENTATION);

        _assertBurnerAllowances();

        if (VAULT_FACTORY.BEACON() != address(UPGRADEABLE_BEACON)) {
            revert IncorrectVaultFactoryBeacon(address(VAULT_FACTORY), address(UPGRADEABLE_BEACON));
        }
        if (VAULT_FACTORY.DASHBOARD_IMPL() != DASHBOARD_IMPLEMENTATION) {
            revert IncorrectVaultFactoryDashboardImplementation(address(VAULT_FACTORY), DASHBOARD_IMPLEMENTATION);
        }

        if (UPGRADEABLE_BEACON.owner() != address(AGENT)) {
            revert IncorrectUpgradeableBeaconOwner(address(UPGRADEABLE_BEACON), AGENT);
        }

        if (UPGRADEABLE_BEACON.implementation() != STAKING_VAULT_IMPLEMENTATION) {
            revert IncorrectUpgradeableBeaconImplementation(address(UPGRADEABLE_BEACON), STAKING_VAULT_IMPLEMENTATION);
        }
    }

    function _assertBurnerAllowances() internal view {
        if (LIDO.allowance(WITHDRAWAL_QUEUE, address(OLD_BURNER)) != 0) {
            revert IncorrectBurnerAllowance(WITHDRAWAL_QUEUE, address(OLD_BURNER));
        }
        if (LIDO.allowance(WITHDRAWAL_QUEUE, address(BURNER)) != type(uint256).max) {
            revert IncorrectBurnerAllowance(WITHDRAWAL_QUEUE, address(BURNER));
        }

        if (LIDO.allowance(address(SIMPLE_DVT), address(OLD_BURNER)) != 0) {
            revert IncorrectBurnerAllowance(address(SIMPLE_DVT), address(OLD_BURNER));
        }
        if (LIDO.allowance(address(SIMPLE_DVT), address(BURNER)) != type(uint256).max) {
            revert IncorrectBurnerAllowance(address(SIMPLE_DVT), address(BURNER));
        }

        if (LIDO.allowance(address(NODE_OPERATORS_REGISTRY), address(OLD_BURNER)) != 0) {
            revert IncorrectBurnerAllowance(address(NODE_OPERATORS_REGISTRY), address(OLD_BURNER));
        }
        if (LIDO.allowance(address(NODE_OPERATORS_REGISTRY), address(BURNER)) != type(uint256).max) {
            revert IncorrectBurnerAllowance(address(NODE_OPERATORS_REGISTRY), address(BURNER));
        }

        if (LIDO.allowance(address(CSM_ACCOUNTING), address(OLD_BURNER)) != 0) {
            revert IncorrectBurnerAllowance(address(CSM_ACCOUNTING), address(OLD_BURNER));
        }
        if (LIDO.allowance(address(CSM_ACCOUNTING), address(BURNER)) != type(uint256).max) {
            revert IncorrectBurnerAllowance(address(CSM_ACCOUNTING), address(BURNER));
        }
    }

    function _checkBurnerMigratedCorrectly() internal view {
        (uint256 oldCoverShares, uint256 oldNonCoverShares) = OLD_BURNER.getSharesRequestedToBurn();
        (uint256 newCoverShares, uint256 newNonCoverShares) = BURNER.getSharesRequestedToBurn();

        if (
            OLD_BURNER.getCoverSharesBurnt() != BURNER.getCoverSharesBurnt() ||
            OLD_BURNER.getNonCoverSharesBurnt() != BURNER.getNonCoverSharesBurnt() ||
            oldCoverShares != newCoverShares ||
            oldNonCoverShares != newNonCoverShares ||
            LIDO.balanceOf(address(OLD_BURNER)) != 0 ||
            LIDO.balanceOf(address(BURNER)) != _initialOldBurnerStethBalance ||
            BURNER.isMigrationAllowed()
        ) {
            revert IncorrectBurnerMigration();
        }
    }

    function _assertAragonAppImplementation(IAragonAppRepo repo, address implementation) internal view {
        (, address actualImplementation, ) = repo.getLatest();
        if (actualImplementation != implementation) {
            revert IncorrectAragonAppImplementation(address(repo), implementation);
        }
    }

    function _assertFinalACL() internal view {
        address agent = AGENT;

        // Burner
        _assertSingleOZRoleHolder(BURNER, DEFAULT_ADMIN_ROLE, agent);
        {
            address[] memory holders = new address[](4);
            holders[0] = address(LIDO);
            holders[1] = NODE_OPERATORS_REGISTRY;
            holders[2] = SIMPLE_DVT;
            holders[3] = ACCOUNTING;
            _assertOZRoleHolders(BURNER, REQUEST_BURN_SHARES_ROLE, holders);
        }
        _assertZeroOZRoleHolders(OLD_BURNER, REQUEST_BURN_SHARES_ROLE);

        // VaultHub
        _assertSingleOZRoleHolder(VAULT_HUB, DEFAULT_ADMIN_ROLE, agent);
        _assertSingleOZRoleHolder(VAULT_HUB, VAULT_MASTER_ROLE, agent);
        _assertZeroOZRoleHolders(VAULT_HUB, VAULT_REGISTRY_ROLE);
        _assertProxyAdmin(IOssifiableProxy(address(VAULT_HUB)), agent);
        // TODO: add PausableUntilWithRoles checks when gate seal is added

        // AccountingOracle
        _assertSingleOZRoleHolder(ACCOUNTING_ORACLE, DEFAULT_ADMIN_ROLE, agent);

        // OracleReportSanityChecker
        _assertOracleReportSanityCheckerRoles();

        // Accounting
        _assertProxyAdmin(IOssifiableProxy(ACCOUNTING), agent);

        // PredepositGuarantee
        _assertProxyAdmin(IOssifiableProxy(address(PREDEPOSIT_GUARANTEE)), agent);

        // StakingRouter
        {
            address[] memory holders = new address[](2);
            holders[0] = address(LIDO);
            holders[1] = ACCOUNTING;
            _assertOZRoleHolders(STAKING_ROUTER, REPORT_REWARDS_MINTED_ROLE, holders);
        }

        // OperatorGrid
        _assertProxyAdmin(IOssifiableProxy(address(OPERATOR_GRID)), agent);
        _assertSingleOZRoleHolder(IAccessControlEnumerable(OPERATOR_GRID), DEFAULT_ADMIN_ROLE, agent);
        _assertSingleOZRoleHolder(IAccessControlEnumerable(OPERATOR_GRID), REGISTRY_ROLE, agent);
    }

    function _checkContractVersions() internal view {
        _assertContractVersion(LIDO, EXPECTED_FINAL_LIDO_VERSION);
        _assertContractVersion(ACCOUNTING_ORACLE, EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION);
    }

    function _assertContractVersion(IVersioned versioned, uint256 expectedVersion) internal view {
        if (versioned.getContractVersion() != expectedVersion) {
            revert InvalidContractVersion(address(versioned), expectedVersion);
        }
    }

    function _transferOZAdminFromThisToAgent(IAccessControlEnumerable accessControlled) internal {
        accessControlled.grantRole(DEFAULT_ADMIN_ROLE, AGENT);
        accessControlled.renounceRole(DEFAULT_ADMIN_ROLE, address(this));
    }

    function _assertNotExpired() internal view {
        if (block.timestamp >= EXPIRE_SINCE_INCLUSIVE) {
            revert Expired();
        }
    }

    error OnlyVotingCanUpgrade();
    error UpgradeAlreadyStarted();
    error UpgradeAlreadyFinished();
    error CanOnlyFinishOnce();
    error UpgradeNotStarted();
    error UpgradeNotFinished();
    error LidoOracleMustNotBeUpgradedToLegacyYet();
    error LidoOracleMustBeUpgradedToLegacy();
    error IncorrectDsmOwner();
    error IncorrectProxyAdmin(address proxy);
    error IncorrectProxyImplementation(address proxy, address implementation);
    error IncorrectInitialImplementation(address proxy);
    error InvalidContractVersion(address contractAddress, uint256 actualVersion);
    error IncorrectOZAccessControlAdmin(address contractAddress);
    error IncorrectOZAccessControlRoleHolders(address contractAddress, bytes32 role);
    error NonZeroRoleHolders(address contractAddress, bytes32 role);
    error WQNotResumed();
    error VEBONotResumed();
    error IncorrectOracleAndHashConsensusBinding(address oracle, address hashConsensus);
    error IncorrectDepositSecurityModuleParameters(address depositSecurityModule);
    error IncorrectStakingModulesCount();
    error IncorrectOracleReportSanityCheckerConfig();
    error IncorrectSealGateSealables();
    error IncorrectStakingModuleParameters();
    error IncorrectOracleDaemonConfigKeyValue(string key);
    error IncorrectLocatorAddresses();
    error IncorrectHashConsensusInitialState(address hashConsensus);
    error IncorrectAragonAppImplementation(address repo, address implementation);
    error IncorrectFeeDistribution();
    error StartAndFinishMustBeInSameBlock();
    error Expired();
    error IncorrectBurnerMigration();
    error IncorrectBurnerAllowance(address contractAddress, address burner);
    error IncorrectOldBurnerAllowance(address contractAddress);
    error IncorrectVaultFactoryBeacon(address factory, address beacon);
    error IncorrectVaultFactoryDashboardImplementation(address factory, address delegation);
    error IncorrectUpgradeableBeaconOwner(address beacon, address owner);
    error IncorrectUpgradeableBeaconImplementation(address beacon, address implementation);
    error NewAndOldLocatorImplementationsMustBeDifferent();
}
