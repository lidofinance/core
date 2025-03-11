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
    function initialize(uint256 _totalCoverSharesBurnt, uint256 _totalNonCoverSharesBurnt) external;
}

interface IWithdrawalsManagerProxy {
    function proxy_getAdmin() external view returns (address);
    function implementation() external view returns (address);
}

interface IWithdrawalVault is IAccessControlEnumerable, IVersioned, IWithdrawalsManagerProxy {
    function getConsensusContract() external view returns (address);
}

interface IVaultHub is IPausableUntilWithRoles, IOssifiableProxy {
}

interface ILido is IVersioned {
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
    function wstETH() external view returns(address);
    function vaultHub() external view returns(address);
}

interface IOracleReportSanityChecker is IAccessControlEnumerable {
}

/**
* @title Lido V3 Upgrade Template
*
* @dev Must be used by means of two calls:
*   - `finishUpgrade()` after updating implementation
*/
contract UpgradeTemplateV3 {
    //
    // Events
    //
    event UpgradeFinished();

    // Old upgraded non-proxy contracts
    IBurner public constant _oldBurner = IBurner(0xD15a672319Cf0352560eE76d9e89eAB0889046D3);
    IOracleReportSanityChecker public constant _oldOracleReportSanityChecker = IOracleReportSanityChecker(0x6232397ebac4f5772e53285B26c47914E9461E75);

    // New proxy contracts
    IAccounting public constant _accounting = IAccounting(0x9015957A2210BB8B10e27d8BBEEF8d9498f123eF);
    IVaultHub public constant _vaultHub = IVaultHub(0x9C6c49E1a5108eC5A2111c0b9B62624100d11e3a);

    // New non-proxy contracts
    IBurner public constant _burner = IBurner(0x897945A56464616a525C9e5F11a8D400a72a8f3A);
    IOracleReportSanityChecker public constant _oracleReportSanityChecker = IOracleReportSanityChecker(0x633a7eB9b8912b22f3616013F3153de687F96074);

    // Existing proxies and contracts
    address public constant _agent = 0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c;
    IAragonAppRepo public constant _aragonAppLidoRepo = IAragonAppRepo(0xF5Dc67E54FC96F993CD06073f71ca732C1E654B1);
    ILidoLocator public constant _locator = ILidoLocator(0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb);
    IAccountingOracle public constant _accountingOracle = IAccountingOracle(0x852deD011285fe67063a08005c71a85690503Cee);
    address public constant _elRewardsVault = 0x388C818CA8B9251b393131C08a736A67ccB19297;
    ILido public constant _lido = ILido(0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84);
    address public constant _voting = 0x2e59A20f205bB85a89C53f1936454680651E618e;
    IWithdrawalVault public constant _withdrawalVault = IWithdrawalVault(0xB9D7934878B5FB9610B3fE8A5e441e8fad7E293f);
    address public constant _validatorsExitBusOracle = 0x0De4Ea0184c2ad0BacA7183356Aea5B8d5Bf5c6e;
    address public constant _nodeOperatorsRegistry = 0x55032650b14df07b85bF18A3a3eC8E0Af2e028d5;
    address public constant _simpleDvt = 0xaE7B191A31f627b4eB1d4DaC64eaB9976995b433;
    address public constant _wstETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;

    // Aragon Apps new implementations
    address public constant _lidoImplementation = 0x267fB71b280FB34B278CedE84180a9A9037C941b;

    // New non-aragon implementations
    address public constant _accountingOracleImplementation = 0xF3c5E0A67f32CF1dc07a8817590efa102079a1aF;
    address public constant _locatorImplementation = 0x1D920cc5bACf7eE506a271a5259f2417CaDeCE1d;
    address public constant _withdrawalVaultImplementation = 0xCC52f17756C04bBa7E377716d7062fC36D7f69Fd;

    // Values to set

    //
    // Roles
    // (stored instead of reading from the contracts to save contract bytecode size)
    //
    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    // Burner
    bytes32 internal constant REQUEST_BURN_SHARES_ROLE = keccak256("REQUEST_BURN_SHARES_ROLE");
    bytes32 internal constant REQUEST_BURN_MY_STETH_ROLE = keccak256("REQUEST_BURN_MY_STETH_ROLE");
    // HashConsensus
    bytes32 internal constant MANAGE_MEMBERS_AND_QUORUM_ROLE = keccak256("MANAGE_MEMBERS_AND_QUORUM_ROLE");
    bytes32 internal constant DISABLE_CONSENSUS_ROLE = keccak256("DISABLE_CONSENSUS_ROLE");
    bytes32 internal constant MANAGE_FRAME_CONFIG_ROLE = keccak256("MANAGE_FRAME_CONFIG_ROLE");
    bytes32 internal constant MANAGE_FAST_LANE_CONFIG_ROLE = keccak256("MANAGE_FAST_LANE_CONFIG_ROLE");
    bytes32 internal constant MANAGE_REPORT_PROCESSOR_ROLE = keccak256("MANAGE_REPORT_PROCESSOR_ROLE");
    // StakingRouter
    bytes32 internal constant STAKING_MODULE_PAUSE_ROLE = keccak256("STAKING_MODULE_PAUSE_ROLE");
    bytes32 internal constant STAKING_MODULE_RESUME_ROLE = keccak256("STAKING_MODULE_RESUME_ROLE");
    bytes32 internal constant STAKING_MODULE_MANAGE_ROLE = keccak256("STAKING_MODULE_MANAGE_ROLE");
    bytes32 internal constant REPORT_EXITED_VALIDATORS_ROLE = keccak256("REPORT_EXITED_VALIDATORS_ROLE");
    bytes32 internal constant REPORT_REWARDS_MINTED_ROLE = keccak256("REPORT_REWARDS_MINTED_ROLE");
    // WithdrawalQueue
    bytes32 internal constant FINALIZE_ROLE = keccak256("FINALIZE_ROLE");
    bytes32 internal constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    // WithdrawalQueue and ValidatorsExitBusOracle
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

    // Auxiliary constants
    uint256 internal constant TOTAL_BASIS_POINTS = 10000;
    uint256 internal constant UPGRADE_NOT_STARTED = 0;

    //
    // Values for checks to compare with or other
    //

    uint256 internal constant EXPECTED_FINAL_LIDO_VERSION = 3;
    uint256 internal constant EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION = 3;
    uint256 internal constant EXPECTED_FINAL_WITHDRAWAL_VAULT_VERSION = 2;

    //
    // Immutables
    //
    // Timestamp since startUpgrade() and finishUpgrade() revert with Expired()
    // This behavior is introduced to disarm the template if the upgrade voting creation or enactment didn't
    // happen in proper time period
    uint256 public constant EXPIRE_SINCE_INCLUSIVE = 1754006400; // 2025-08-01 00:00:00 UTC

    //
    // Structured storage
    //
    bool public _isUpgradeFinished;

    /// @notice Need to be called after LidoOracle implementation is upgraded to LegacyOracle
    function finishUpgrade() external {
        _assertNotExpired();
        _finishUpgrade();
        emit UpgradeFinished();
    }

    /// @notice Used externally for 2nd Aragon voting (roles revoke) to fail if 1st voting isn't enacted
    function revertIfUpgradeNotFinished() public view {
        if (!_isUpgradeFinished) {
            revert UpgradeNotFinished();
        }
    }

    function _assertLocatorAddresses() internal view {
        ILidoLocator locator = _locator;
        if (
            locator.accountingOracle() != address(_accountingOracle)
         || locator.burner() != address(_burner)
        //  || locator.depositSecurityModule() != address(_depositSecurityModule)
         || locator.elRewardsVault() != _elRewardsVault
         || locator.lido() != address(_lido)
        //  || locator.legacyOracle() != address(_legacyOracle)
        //  || locator.oracleDaemonConfig() != address(_oracleDaemonConfig)
         || locator.oracleReportSanityChecker() != address(_oracleReportSanityChecker)
        //  || locator.postTokenRebaseReceiver() != address(_legacyOracle)
        //  || locator.stakingRouter() != address(_stakingRouter)
         || locator.treasury() != _agent
        //  || locator.validatorsExitBusOracle() != address(_validatorsExitBusOracle)
        //  || locator.withdrawalQueue() != address(_withdrawalQueue)
         || locator.withdrawalVault() != address(_withdrawalVault)
         || locator.accounting() != address(_accounting)
         || locator.wstETH() != address(_wstETH)
         || locator.vaultHub() != address(_vaultHub)
        ) {
            revert IncorrectLocatorAddresses();
        }
    }

    function _upgradeOssifiableProxy(IOssifiableProxy proxy, address newImplementation) internal {
        // NB: Such separation of external call into a separate function saves contract bytecode size
        proxy.proxy__upgradeTo(newImplementation);
    }

    function _assertAdminsOfProxies(address admin) internal view {
        _assertProxyAdmin(_locator, admin);
        _assertProxyAdmin(_accountingOracle, admin);
    }

    function _assertProxyAdmin(IOssifiableProxy proxy, address admin) internal view {
        if (proxy.proxy__getAdmin() != admin) revert IncorrectProxyAdmin(address(proxy));
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

    function _assertTwoOZRoleHolders(
        IAccessControlEnumerable accessControlled, bytes32 role, address holder1, address holder2
    ) internal view {
        if (accessControlled.getRoleMemberCount(role) != 2
         || accessControlled.getRoleMember(role, 0) != holder1
         || accessControlled.getRoleMember(role, 1) != holder2
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

    function _finishUpgrade() internal {
        if (msg.sender != _voting) revert OnlyVotingCanUpgrade();
        if (_isUpgradeFinished) revert CanOnlyFinishOnce();
        _isUpgradeFinished = true;

        _burner.initialize(
            _oldBurner.getCoverSharesBurnt(),
            _oldBurner.getNonCoverSharesBurnt()
        );

        _passAdminRoleFromTemplateToAgent();

        _assertUpgradeIsFinishedCorrectly();
    }

    function _passAdminRoleFromTemplateToAgent() internal {
        _transferOZAdminFromThisToAgent(_burner);
    }

    function _assertUpgradeIsFinishedCorrectly() internal view {
        // if (_upgradeBlockNumber == UPGRADE_NOT_STARTED) revert UpgradeNotStarted();
        // revertIfUpgradeNotFinished();

        _checkContractVersions();

        _assertFinalACL();

        _assertNewAragonAppImplementations();
    }

    function _assertNewAragonAppImplementations() internal view {
        _assertSingleAragonAppImplementation(_aragonAppLidoRepo, _lidoImplementation);
    }

    function _assertSingleAragonAppImplementation(IAragonAppRepo repo, address implementation) internal view {
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
    error CanOnlyFinishOnce();
    error UpgradeNotStarted();
    error UpgradeNotFinished();
    error LidoOracleMustNotBeUpgradedToLegacyYet();
    error LidoOracleMustBeUpgradedToLegacy();
    error IncorrectDsmOwner();
    error IncorrectProxyAdmin(address proxy);
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
}
