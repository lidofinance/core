// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;


interface IAccessControlEnumerable {
    function grantRole(bytes32 role, address account) external;
    function renounceRole(bytes32 role, address account) external;
    function getRoleMemberCount(bytes32 role) external view returns (uint256);
    function getRoleMember(bytes32 role, uint256 index) external view returns (address);
}

interface IVersioned {
    function getContractVersion() external view returns (uint256);
}

interface IPausableUntil {
    function isPaused() external view returns (bool);
    function getResumeSinceTimestamp() external view returns (uint256);
    function PAUSE_INFINITELY() external view returns (uint256);
}

interface IPausableUntilWithRoles is IPausableUntil, IAccessControlEnumerable {
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

interface IAccountingOracle is IBaseOracle, IOssifiableProxy {
    function initialize(address admin, address consensusContract, uint256 consensusVersion) external;
}

interface IAccounting is IOssifiableProxy {
}

interface IAragonAppRepo {
    function getLatest() external view returns (uint16[3] memory, address, bytes memory);
}

interface IBurner is IAccessControlEnumerable {
    function getCoverSharesBurnt() external view returns (uint256);
    function getNonCoverSharesBurnt() external view returns (uint256);
    function getSharesRequestedToBurn() external view returns (uint256 coverShares, uint256 nonCoverShares);
    function isMigrationAllowed() external view returns (bool);
}

interface IUpgradeableBeacon {
    function implementation() external view returns (address);
    function owner() external view returns (address);
}

interface IWithdrawalsManagerProxy {
    function proxy_getAdmin() external view returns (address);
    function implementation() external view returns (address);
}

interface IWithdrawalVault is IAccessControlEnumerable, IVersioned, IWithdrawalsManagerProxy {
    function getConsensusContract() external view returns (address);
}

interface IVaultFactory {
    function BEACON() external view returns (address);
    function DELEGATION_IMPL() external view returns (address);
}

interface IVaultHub is IPausableUntilWithRoles, IOssifiableProxy {
}

interface ILido is IVersioned {
    function allowance(address _owner, address _spender) external view returns (uint256);
    function balanceOf(address _account) external view returns (uint256);
}

interface ILidoLocator is IOssifiableProxy {
    function accountingOracle() external view returns(address);
    function depositSecurityModule() external view returns(address);
    function elRewardsVault() external view returns(address);
    function legacyOracle() external view returns(address);
    function lido() external view returns(address);
    function oracleReportSanityChecker() external view returns(address);
    function postTokenRebaseReceiver() external view returns(address);
    function burner() external view returns(address);
    function stakingRouter() external view returns(address);
    function treasury() external view returns(address);
    function validatorsExitBusOracle() external view returns(address);
    function withdrawalQueue() external view returns(address);
    function withdrawalVault() external view returns(address);
    function oracleDaemonConfig() external view returns(address);
    function accounting() external view returns(address);
    function predepositGuarantee() external view returns(address);
    function wstETH() external view returns(address);
    function vaultHub() external view returns(address);
}

interface IOracleReportSanityChecker is IAccessControlEnumerable {
}

interface IPredepositGuarantee is IOssifiableProxy {
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
        // New proxy contracts
        address accounting;
        address vaultHub;
        address predepositGuarantee;

        // New non-proxy contracts
        address burner;
        address oracleReportSanityChecker;
        address vaultFactory;

        // New fancy proxy contracts
        address upgradeableBeacon;
        address stakingVaultImplementation;
        address delegationImplementation;

        // New Aragon apps implementations
        address lidoImplementation;

        // New non-aragon implementations
        address accountingOracleImplementation;
        address newLocatorImplementation;
        address withdrawalVaultImplementation;

        // Existing proxies and contracts
        address agent;
        address aragonAppLidoRepo;
        address csmAccounting;
        address locator; // not upgraded at the time of the template creation
        address nodeOperatorsRegistry;
        address simpleDvt;
        address voting;
        address wstETH;
    }
    // Old upgraded non-proxy contracts
    IBurner public immutable _oldBurner;
    IOracleReportSanityChecker public immutable _oldOracleReportSanityChecker;

    // New proxy contracts
    IAccounting public immutable _accounting;
    IVaultHub public immutable _vaultHub;
    IPredepositGuarantee public immutable _predepositGuarantee;

    // New non-proxy contracts
    IBurner public immutable _burner;
    IOracleReportSanityChecker public immutable _oracleReportSanityChecker;
    IVaultFactory public immutable _vaultFactory;

    // New fancy proxy contracts
    IUpgradeableBeacon public immutable _upgradeableBeacon;
    address public immutable _stakingVaultImplementation;
    address public immutable _delegationImplementation;

    // Aragon Apps new implementations
    address public immutable _lidoImplementation;

    // New non-aragon implementations
    address public immutable _accountingOracleImplementation;
    address public immutable _newLocatorImplementation;
    address public immutable _withdrawalVaultImplementation;

    // Existing proxies and contracts
    address public immutable _agent;
    IAragonAppRepo public immutable _aragonAppLidoRepo;
    IAccountingOracle public immutable _accountingOracle;
    address public immutable _csmAccounting;
    address public immutable _elRewardsVault;
    ILido public immutable _lido;
    ILidoLocator public immutable _locator;
    address public immutable _nodeOperatorsRegistry;
    address public immutable _simpleDvt;
    address public immutable _validatorsExitBusOracle;
    address public immutable _voting;
    address public immutable _withdrawalQueue;
    IWithdrawalVault public immutable _withdrawalVault;
    address public immutable _wstETH;

    // Values to set

    //
    // Roles
    // (stored instead of reading from the contracts to save contract bytecode size)
    //
    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    // Burner
    bytes32 internal constant REQUEST_BURN_SHARES_ROLE = keccak256("REQUEST_BURN_SHARES_ROLE");
    bytes32 internal constant REQUEST_BURN_MY_STETH_ROLE = keccak256("REQUEST_BURN_MY_STETH_ROLE");
    // PauseUntilWithRoles
    bytes32 internal constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    // OracleReportSanityChecker
    bytes32 internal constant ALL_LIMITS_MANAGER_ROLE = keccak256("ALL_LIMITS_MANAGER_ROLE");
    bytes32 public constant EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE =
        keccak256("EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE");
    bytes32 public constant APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE =
        keccak256("APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE");
    bytes32 public constant ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE =
        keccak256("ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE");
    bytes32 public constant SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE =
        keccak256("SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE");
    bytes32 public constant MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE =
        keccak256("MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE");
    bytes32 public constant MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE =
        keccak256("MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE");
    bytes32 public constant MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE =
        keccak256("MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE");
    bytes32 public constant REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE = keccak256("REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE");
    bytes32 public constant MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE =
        keccak256("MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE");
    bytes32 public constant SECOND_OPINION_MANAGER_ROLE =
        keccak256("SECOND_OPINION_MANAGER_ROLE");
    bytes32 public constant INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE =
        keccak256("INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE");

    // WithdrawalVault
    bytes32 internal constant ADD_FULL_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_FULL_WITHDRAWAL_REQUEST_ROLE");

    // VaultHub
    bytes32 public constant VAULT_MASTER_ROLE = keccak256("Vaults.VaultHub.VaultMasterRole");
    bytes32 public constant VAULT_REGISTRY_ROLE = keccak256("Vaults.VaultHub.VaultRegistryRole");

    //
    // Values for checks to compare with or other
    //

    uint256 internal constant EXPECTED_FINAL_LIDO_VERSION = 3;
    uint256 internal constant EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION = 3;
    uint256 internal constant EXPECTED_FINAL_WITHDRAWAL_VAULT_VERSION = 2;

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
    // Immutables
    //
    bool immutable public ALLOW_NON_SINGLE_BLOCK_UPGRADE;

    //
    // Structured storage
    //
    uint256 private _upgradeBlockNumber = UPGRADE_NOT_STARTED;
    bool public _isUpgradeFinished;
    uint256 internal _initialOldBurnerStethBalance;


    /// @param params Parameters for the upgrade template
    /// @param allowNonSingleBlockUpgrade Hack to allow mocking DAO upgrade (in multiple blocks)
    constructor(UpgradeTemplateV3Params memory params, bool allowNonSingleBlockUpgrade) {
        ALLOW_NON_SINGLE_BLOCK_UPGRADE = allowNonSingleBlockUpgrade;

        _accounting = IAccounting(params.accounting);
        _vaultHub = IVaultHub(params.vaultHub);
        // NB: we pass some of the addresses available in the new locator as parameters
        //     because at the template creation time locator is not upgraded
        _predepositGuarantee = IPredepositGuarantee(params.predepositGuarantee);
        _burner = IBurner(params.burner);
        _vaultFactory = IVaultFactory(params.vaultFactory);
        _upgradeableBeacon = IUpgradeableBeacon(params.upgradeableBeacon);
        _stakingVaultImplementation = params.stakingVaultImplementation;
        _delegationImplementation = params.delegationImplementation;

        _locator = ILidoLocator(params.locator);
        _agent = params.agent;
        _aragonAppLidoRepo = IAragonAppRepo(params.aragonAppLidoRepo);
        _csmAccounting = params.csmAccounting;
        _voting = params.voting;
        _nodeOperatorsRegistry = params.nodeOperatorsRegistry;
        _simpleDvt = params.simpleDvt;
        _wstETH = params.wstETH;

        _lidoImplementation = params.lidoImplementation;

        _accountingOracleImplementation = params.accountingOracleImplementation;
        _newLocatorImplementation = params.newLocatorImplementation;
        _withdrawalVaultImplementation = params.withdrawalVaultImplementation;

        _oldBurner = IBurner(_locator.burner());
        _oldOracleReportSanityChecker = IOracleReportSanityChecker(_locator.oracleReportSanityChecker());
        _oracleReportSanityChecker = IOracleReportSanityChecker(params.oracleReportSanityChecker);
        _accountingOracle = IAccountingOracle(_locator.accountingOracle());
        _elRewardsVault = _locator.elRewardsVault();
        _lido = ILido(_locator.lido());
        _validatorsExitBusOracle = _locator.validatorsExitBusOracle();
        _withdrawalQueue = _locator.withdrawalQueue();
        _withdrawalVault = IWithdrawalVault(_locator.withdrawalVault());
    }

    /// @notice Must be called after LidoLocator is upgraded
    function startUpgrade() external {
        if (msg.sender != _voting) revert OnlyVotingCanUpgrade();
        _assertNotExpired();
        if (_isUpgradeFinished) revert UpgradeAlreadyFinished();

        if (!ALLOW_NON_SINGLE_BLOCK_UPGRADE) {
            if (_upgradeBlockNumber != UPGRADE_NOT_STARTED) revert UpgradeAlreadyStarted();
            _upgradeBlockNumber = block.number;
        }

        // Save initial state for the check after burner migration
        _initialOldBurnerStethBalance = _lido.balanceOf(address(_oldBurner));

        _assertProxyImplementation(_locator, _newLocatorImplementation);
        _assertNewLocatorAddresses();
        _assertOldBurnerAllowances();
    }

    function finishUpgrade() external {
        if (msg.sender != _voting) revert OnlyVotingCanUpgrade();
        _assertNotExpired();
        if (_isUpgradeFinished) revert CanOnlyFinishOnce();
        _isUpgradeFinished = true;

        if (!ALLOW_NON_SINGLE_BLOCK_UPGRADE) {
            if (_upgradeBlockNumber != block.number) revert StartAndFinishMustBeInSameBlock();
        }

        _passAdminRolesFromTemplateToAgent();

        _assertStateAfterUpgrade();

        emit UpgradeFinished();
    }

    function _assertNewLocatorAddresses() internal view {
        ILidoLocator locator = _locator;
        if (locator.burner() != address(_burner)
         || locator.oracleReportSanityChecker() != address(_oracleReportSanityChecker)
         || locator.accounting() != address(_accounting)
         || locator.wstETH() != address(_wstETH)
         || locator.vaultHub() != address(_vaultHub)
         || locator.predepositGuarantee() != address(_predepositGuarantee)
        ) {
            revert IncorrectLocatorAddresses();
        }
    }

    function _assertOldBurnerAllowances() internal view {
        address oldBurner = address(_oldBurner);
        uint256 infiniteAllowance = type(uint256).max;

        if (_lido.allowance(_withdrawalQueue, oldBurner) != infiniteAllowance) {
            revert IncorrectOldBurnerAllowance(_withdrawalQueue);
        }

        if (_lido.allowance(_simpleDvt, oldBurner) != infiniteAllowance) {
            revert IncorrectOldBurnerAllowance(_simpleDvt);
        }

        if (_lido.allowance(_nodeOperatorsRegistry, oldBurner) != infiniteAllowance) {
            revert IncorrectOldBurnerAllowance(_nodeOperatorsRegistry);
        }

        if (_lido.allowance(_csmAccounting, oldBurner) != infiniteAllowance) {
            revert IncorrectOldBurnerAllowance(_csmAccounting);
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
        IOracleReportSanityChecker checker = _oracleReportSanityChecker;
        _assertSingleOZRoleHolder(checker, DEFAULT_ADMIN_ROLE, _agent);
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
        if (_withdrawalVault.implementation() != _withdrawalVaultImplementation) {
            revert IncorrectInitialImplementation(address(_withdrawalVault));
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

    function _passAdminRolesFromTemplateToAgent() internal {
        _transferOZAdminFromThisToAgent(_burner);
    }

    function _assertStateAfterUpgrade() internal view {
        _assertFinalACL();

        _checkContractVersions();

        _checkBurnerMigratedCorrectly();

        _assertAragonAppImplementation(_aragonAppLidoRepo, _lidoImplementation);

        _assertProxyImplementation(_accountingOracle, _accountingOracleImplementation);

        _assertBurnerAllowances();

        if (_withdrawalVault.implementation() != _withdrawalVaultImplementation) {
            revert IncorrectProxyImplementation(address(_withdrawalVault), _withdrawalVaultImplementation);
        }

        if (_vaultFactory.BEACON() != address(_upgradeableBeacon)) {
            revert IncorrectVaultFactoryBeacon(address(_vaultFactory), address(_upgradeableBeacon));
        }
        if (_vaultFactory.DELEGATION_IMPL() != _delegationImplementation) {
            revert IncorrectVaultFactoryDelegationImplementation(address(_vaultFactory), _delegationImplementation);
        }

        if (_upgradeableBeacon.owner() != address(_agent)) {
            revert IncorrectUpgradeableBeaconOwner(address(_upgradeableBeacon), _agent);
        }

        if (_upgradeableBeacon.implementation() != _stakingVaultImplementation) {
            revert IncorrectUpgradeableBeaconImplementation(address(_upgradeableBeacon), _stakingVaultImplementation);
        }
    }

    function _assertBurnerAllowances() internal view {
        if (_lido.allowance(_withdrawalQueue, address(_oldBurner)) != 0) {
            revert IncorrectBurnerAllowance(_withdrawalQueue, address(_oldBurner));
        }
        if (_lido.allowance(_withdrawalQueue, address(_burner)) != type(uint256).max) {
            revert IncorrectBurnerAllowance(_withdrawalQueue, address(_burner));
        }

        if (_lido.allowance(address(_simpleDvt), address(_oldBurner)) != 0) {
            revert IncorrectBurnerAllowance(address(_simpleDvt), address(_oldBurner));
        }
        if (_lido.allowance(address(_simpleDvt), address(_burner)) != type(uint256).max) {
            revert IncorrectBurnerAllowance(address(_simpleDvt), address(_burner));
        }

        if (_lido.allowance(address(_nodeOperatorsRegistry), address(_oldBurner)) != 0) {
            revert IncorrectBurnerAllowance(address(_nodeOperatorsRegistry), address(_oldBurner));
        }
        if (_lido.allowance(address(_nodeOperatorsRegistry), address(_burner)) != type(uint256).max) {
            revert IncorrectBurnerAllowance(address(_nodeOperatorsRegistry), address(_burner));
        }

        if (_lido.allowance(address(_csmAccounting), address(_oldBurner)) != 0) {
            revert IncorrectBurnerAllowance(address(_csmAccounting), address(_oldBurner));
        }
        if (_lido.allowance(address(_csmAccounting), address(_burner)) != type(uint256).max) {
            revert IncorrectBurnerAllowance(address(_csmAccounting), address(_burner));
        }

        if (_lido.allowance(address(_accounting), address(_burner)) != type(uint256).max) {
            revert IncorrectBurnerAllowance(address(_accounting), address(_burner));
        }
    }

    function _checkBurnerMigratedCorrectly() internal view {
        (uint256 oldCoverShares, uint256 oldNonCoverShares) = _oldBurner.getSharesRequestedToBurn();
        (uint256 newCoverShares, uint256 newNonCoverShares) = _burner.getSharesRequestedToBurn();

        if (
            _oldBurner.getCoverSharesBurnt() != _burner.getCoverSharesBurnt() ||
            _oldBurner.getNonCoverSharesBurnt() != _burner.getNonCoverSharesBurnt() ||
            oldCoverShares != newCoverShares ||
            oldNonCoverShares != newNonCoverShares ||
            _lido.balanceOf(address(_oldBurner)) != 0 ||
            _lido.balanceOf(address(_burner)) != _initialOldBurnerStethBalance ||
            _burner.isMigrationAllowed()
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
        address agent = _agent;

        // Burner
        IBurner burner = _burner;
        _assertSingleOZRoleHolder(burner, DEFAULT_ADMIN_ROLE, agent);
        address[] memory holders = new address[](4);
        holders[0] = address(_lido);
        holders[1] = _nodeOperatorsRegistry;
        holders[2] = _simpleDvt;
        holders[3] = address(_accounting);
        _assertOZRoleHolders(burner, REQUEST_BURN_SHARES_ROLE, holders);
        // NB: we don't check REQUEST_BURN_SHARES_ROLE on the old burner is revoked
        //     because it is left intentionally to simplify aragon voting operations

        // WithdrawalVault
        _assertSingleOZRoleHolder(_withdrawalVault, DEFAULT_ADMIN_ROLE, _agent);
        _assertSingleOZRoleHolder(_withdrawalVault, ADD_FULL_WITHDRAWAL_REQUEST_ROLE, _validatorsExitBusOracle);

        // VaultHub
        _assertSingleOZRoleHolder(_vaultHub, DEFAULT_ADMIN_ROLE, _agent);
        _assertSingleOZRoleHolder(_vaultHub, VAULT_MASTER_ROLE, _agent);
        _assertZeroOZRoleHolders(_vaultHub, VAULT_REGISTRY_ROLE);
        _assertProxyAdmin(_vaultHub, _agent);
        // TODO: add PausableUntilWithRoles checks when gate seal is added

        // AccountingOracle
        _assertSingleOZRoleHolder(_accountingOracle, DEFAULT_ADMIN_ROLE, agent);

        // OracleReportSanityChecker
        _assertOracleReportSanityCheckerRoles();

        // Accounting
        _assertProxyAdmin(_accounting, _agent);

        // PredepositGuarantee
        _assertProxyAdmin(_predepositGuarantee, _agent);
    }

    function _checkContractVersions() internal view {
        _assertContractVersion(_lido, EXPECTED_FINAL_LIDO_VERSION);
        _assertContractVersion(_accountingOracle, EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION);
        _assertContractVersion(_withdrawalVault, EXPECTED_FINAL_WITHDRAWAL_VAULT_VERSION);
    }

    function _assertContractVersion(IVersioned versioned, uint256 expectedVersion) internal view {
        if (versioned.getContractVersion() != expectedVersion) {
            revert InvalidContractVersion(address(versioned), expectedVersion);
        }
    }

    function _transferOZAdminFromThisToAgent(IAccessControlEnumerable accessControlled) internal {
        accessControlled.grantRole(DEFAULT_ADMIN_ROLE, _agent);
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
    error IncorrectVaultFactoryDelegationImplementation(address factory, address delegation);
    error IncorrectUpgradeableBeaconOwner(address beacon, address owner);
    error IncorrectUpgradeableBeaconImplementation(address beacon, address implementation);
}
