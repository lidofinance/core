// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {
    IAccessControl,
    IAccessControlEnumerable
} from "@openzeppelin/contracts-v5.2/access/extensions/IAccessControlEnumerable.sol";

import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";
import {ModuleStateConfig, StakingModuleStatus} from "contracts/0.8.25/sr/SRTypes.sol";
import {
    UpgradeParameters,
    ILidoWithFinalizeUpgrade,
    IAccountingOracle,
    IWithdrawalsManagerProxy,
    IAragonKernel,
    IVersioned,
    IEasyTrack,
    IWithdrawalVault,
    IWithdrawalsManagerProxy,
    IStakingRouter,
    IDepositSecurityModule
} from "./UpgradeTypes.sol";

import {UpgradeConfig} from "./UpgradeConfig.sol";

/**
 * @title Lido Upgrade Template
 *
 * @dev Must be used by means of two calls:
 *   - `startUpgrade()` before upgrading LidoLocator and before everything else
 *   - `finishUpgrade()` as the last step of the upgrade
 */
contract UpgradeTemplate is UpgradeConfig {
    //
    // Events
    //

    event UpgradeStarted();
    event UpgradeFinished();

    //
    // -------- Constants --------
    //

    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 internal constant ALLOW_PAIR_ROLE = keccak256("ALLOW_PAIR_ROLE");
    bytes32 internal constant DISALLOW_PAIR_ROLE = keccak256("DISALLOW_PAIR_ROLE");
    bytes32 internal constant TOP_UP_ROLE = keccak256("TOP_UP_ROLE");
    bytes32 internal constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");
    bytes32 internal constant PUBLISH_ROLE = keccak256("PUBLISH_ROLE");
    bytes32 internal constant EXECUTE_ROLE = keccak256("EXECUTE_ROLE");
    bytes32 internal constant REMOVE_ROLE = keccak256("REMOVE_ROLE");
    // sr roles
    bytes32 internal constant MANAGE_WITHDRAWAL_CREDENTIALS_ROLE = keccak256("MANAGE_WITHDRAWAL_CREDENTIALS_ROLE");
    bytes32 internal constant STAKING_MODULE_MANAGE_ROLE = keccak256("STAKING_MODULE_MANAGE_ROLE");
    bytes32 internal constant STAKING_MODULE_UNVETTING_ROLE = keccak256("STAKING_MODULE_UNVETTING_ROLE");
    bytes32 internal constant REPORT_EXITED_VALIDATORS_ROLE = keccak256("REPORT_EXITED_VALIDATORS_ROLE");
    bytes32 internal constant UNSAFE_SET_EXITED_VALIDATORS_ROLE = keccak256("UNSAFE_SET_EXITED_VALIDATORS_ROLE");
    bytes32 internal constant REPORT_REWARDS_MINTED_ROLE = keccak256("REPORT_REWARDS_MINTED_ROLE");
    bytes32 internal constant REPORT_VALIDATOR_EXITING_STATUS_ROLE = keccak256("REPORT_VALIDATOR_EXITING_STATUS_ROLE");
    bytes32 internal constant REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE = keccak256("REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE");
    bytes32 internal constant STAKING_MODULE_SHARE_MANAGE_ROLE = keccak256("STAKING_MODULE_SHARE_MANAGE_ROLE");

    //sanitychecker roles
    bytes32 internal constant ALL_LIMITS_MANAGER_ROLE = keccak256("ALL_LIMITS_MANAGER_ROLE");
    bytes32 internal constant EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE =
        keccak256("EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE");
    bytes32 internal constant APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE =
        keccak256("APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE");
    bytes32 internal constant ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE =
        keccak256("ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE");
    bytes32 internal constant SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE =
        keccak256("SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE");
    bytes32 internal constant MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE =
        keccak256("MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE");
    bytes32 internal constant MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE =
        keccak256("MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE");
    bytes32 internal constant MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE =
        keccak256("MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE");
    bytes32 internal constant REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE =
        keccak256("REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE");
    bytes32 internal constant MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE =
        keccak256("MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE");
    bytes32 internal constant SECOND_OPINION_MANAGER_ROLE = keccak256("SECOND_OPINION_MANAGER_ROLE");
    bytes32 internal constant INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE =
        keccak256("INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE");

    uint256 public constant EXPECTED_FINAL_LIDO_VERSION = 4;
    uint256 public constant EXPECTED_FINAL_STAKING_ROUTER_VERSION = 4;
    uint256 public constant EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION = 4;
    uint256 public constant EXPECTED_FINAL_ACCOUNTING_ORACLE_CONSENSUS_VERSION = 6;
    uint256 public constant EXPECTED_FINAL_VALIDATORS_EXIT_BUS_ORACLE_CONSENSUS_VERSION = 5;
    uint256 public constant EXPECTED_FINAL_WITHDRAWAL_VAULT_VERSION = 3;

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    // Initial value of upgradeBlockNumber storage variable
    uint256 public constant UPGRADE_NOT_STARTED = 0;
    uint256 public constant INFINITE_ALLOWANCE = type(uint256).max;

    // Timestamp since which startUpgrade()
    // This behavior is introduced to disarm the template if the upgrade voting creation or enactment
    // didn't happen in proper time period
    uint256 public immutable EXPIRE_SINCE_INCLUSIVE;

    //
    // Structured storage
    //

    uint256 public upgradeBlockNumber = UPGRADE_NOT_STARTED;
    bool public isUpgradeFinished;

    // uint256 public initialOldBurnerStethSharesBalance;
    // uint256 public initialTotalShares;
    // uint256 public initialTotalPooledEther;
    uint256 internal initialBufferedEther;
    uint256 internal initialDepositedValidators;
    uint256 internal initialBeaconValidators;
    uint256 internal initialBeaconBalance;
    // bytes32 internal initialWithdrawalCredentials;
    uint256 internal initialModulesCount;
    // address[] internal initialDSMGuardians;
    // uint256 internal initialDSMGuardianQuorum;

    //
    // Slots for transient storage
    //

    // Slot for the upgrade started flag
    // / keccak256("UpgradeTemplate.upgradeStartedFlag");
    bytes32 public constant UPGRADE_STARTED_SLOT = 0x058d69f67a3d86c424c516d23a070ff8bed34431617274caa2049bd702675e3f;

    /// @param _params Params required to initialize the addresses contract
    /// @param _expireSinceInclusive Unix timestamp after which upgrade actions revert
    constructor(UpgradeParameters memory _params, uint256 _expireSinceInclusive) UpgradeConfig(_params) {
        EXPIRE_SINCE_INCLUSIVE = _expireSinceInclusive;
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

        initialBufferedEther = ILidoWithFinalizeUpgrade(LIDO).getBufferedEther();
        (initialDepositedValidators, initialBeaconValidators, initialBeaconBalance) =
            ILidoWithFinalizeUpgrade(LIDO).getBeaconStat();

        IStakingRouter sr = IStakingRouter(STAKING_ROUTER);
        // initialWithdrawalCredentials = sr.getWithdrawalCredentials();
        initialModulesCount = sr.getStakingModulesCount();

        // initialDSMGuardians = IDepositSecurityModule(OLD_DEPOSIT_SECURITY_MODULE).getGuardians();
        // initialDSMGuardianQuorum = IDepositSecurityModule(OLD_DEPOSIT_SECURITY_MODULE).getGuardianQuorum();

        _assertPreUpgradeState();

        emit UpgradeStarted();
    }

    function finishUpgrade() external {
        if (msg.sender != AGENT) revert OnlyAgentCanUpgrade();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (!_isStartCalledInThisTx()) revert StartAndFinishMustBeInSameTx();

        isUpgradeFinished = true;

        ILidoWithFinalizeUpgrade(LIDO).finalizeUpgrade_v4();
        IWithdrawalVault(WITHDRAWAL_VAULT).finalizeUpgrade_v3();
        IAccountingOracle(ACCOUNTING_ORACLE).finalizeUpgrade_v5(EXPECTED_FINAL_ACCOUNTING_ORACLE_CONSENSUS_VERSION);

        _assertPostUpgradeState();

        emit UpgradeFinished();
    }

    //
    // Assertions
    //

    function _assertPreUpgradeState() internal view {
        // Check initial implementations of the proxies to be upgraded
        _assertAragonKernelImplementation(IAragonKernel(KERNEL), OLD_LIDO_IMPL);

        _assertProxyImplementation(LOCATOR, OLD_LOCATOR_IMPL);
        _assertProxyImplementation(ACCOUNTING, OLD_ACCOUNTING_IMPL);
        _assertProxyImplementation(ACCOUNTING_ORACLE, OLD_ACCOUNTING_ORACLE_IMPL);
        _assertProxyImplementation(STAKING_ROUTER, OLD_STAKING_ROUTER_IMPL);
        _assertProxyImplementation(VALIDATORS_EXIT_BUS_ORACLE, OLD_VALIDATORS_EXIT_BUS_ORACLE_IMPL);

        _assertWithdrawalsManagerProxyImplementation(WITHDRAWAL_VAULT, OLD_WITHDRAWAL_VAULT_IMPL);
    }

    function _assertPostUpgradeState() internal view {
        // if (
        //     ILidoWithFinalizeUpgrade(LIDO).getTotalShares() != initialTotalShares
        //         || ILidoWithFinalizeUpgrade(LIDO).getTotalPooledEther() != initialTotalPooledEther
        // ) {
        //     revert TotalSharesOrPooledEtherChanged();
        // }

        _assertAragonKernelImplementation(IAragonKernel(KERNEL), NEW_LIDO_IMPL);

        _assertProxyImplementation(LOCATOR, NEW_LOCATOR_IMPL);
        _assertProxyImplementation(ACCOUNTING, NEW_ACCOUNTING_IMPL);
        _assertProxyImplementation(ACCOUNTING_ORACLE, NEW_ACCOUNTING_ORACLE_IMPL);
        _assertProxyImplementation(STAKING_ROUTER, NEW_STAKING_ROUTER_IMPL);
        _assertProxyImplementation(VALIDATORS_EXIT_BUS_ORACLE, NEW_VALIDATORS_EXIT_BUS_ORACLE_IMPL);

        _assertWithdrawalsManagerProxyImplementation(WITHDRAWAL_VAULT, NEW_WITHDRAWAL_VAULT_IMPL);

        _assertProxyImplementation(CONSOLIDATION_BUS, CONSOLIDATION_BUS_IMPL);
        _assertProxyImplementation(CONSOLIDATION_MIGRATOR, CONSOLIDATION_MIGRATOR_IMPL);
        _assertProxyImplementation(TOP_UP_GATEWAY, TOP_UP_GATEWAY_IMPL);

        _assertContractVersion(LIDO, EXPECTED_FINAL_LIDO_VERSION);
        _assertContractVersion(ACCOUNTING_ORACLE, EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION);
        _assertContractVersion(WITHDRAWAL_VAULT, EXPECTED_FINAL_WITHDRAWAL_VAULT_VERSION);

        // TODO uncomment for testnet/mainnet
        // _assertEasyTrackFactories();

        _assertFinalACL();

        _checkStakingRouter();
        _checkLido();
        _checkDSM();
    }

    function _assertFinalACL() internal view {
        // Accounting
        _assertProxyAdmin(ACCOUNTING, AGENT);
        _assertSingleOZRoleHolder(ACCOUNTING, DEFAULT_ADMIN_ROLE, AGENT);

        // AccountingOracle
        _assertProxyAdmin(ACCOUNTING_ORACLE, AGENT);
        _assertSingleOZRoleHolder(ACCOUNTING_ORACLE, DEFAULT_ADMIN_ROLE, AGENT);

        // StakingRouter
        _assertProxyAdmin(STAKING_ROUTER, AGENT);
        _assertSingleOZRoleHolder(STAKING_ROUTER, DEFAULT_ADMIN_ROLE, AGENT);
        _assertSingleOZRoleHolder(STAKING_ROUTER, STAKING_MODULE_MANAGE_ROLE, AGENT);
        _assertSingleOZRoleHolder(STAKING_ROUTER, STAKING_MODULE_UNVETTING_ROLE, NEW_DEPOSIT_SECURITY_MODULE);
        _assertSingleOZRoleHolder(STAKING_ROUTER, REPORT_REWARDS_MINTED_ROLE, ACCOUNTING);
        _assertSingleOZRoleHolder(STAKING_ROUTER, REPORT_EXITED_VALIDATORS_ROLE, ACCOUNTING_ORACLE);
        _assertSingleOZRoleHolder(STAKING_ROUTER, REPORT_VALIDATOR_EXITING_STATUS_ROLE, VALIDATOR_EXIT_DELAY_VERIFIER);
        _assertSingleOZRoleHolder(STAKING_ROUTER, REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE, TRIGGERABLE_WITHDRAWALS_GATEWAY);
        _assertSingleOZRoleHolder(STAKING_ROUTER, STAKING_MODULE_SHARE_MANAGE_ROLE, EASY_TRACK_EVM_SCRIPT_EXECUTOR);
        _assertZeroOZRoleHolders(STAKING_ROUTER, MANAGE_WITHDRAWAL_CREDENTIALS_ROLE);
        _assertZeroOZRoleHolders(STAKING_ROUTER, UNSAFE_SET_EXITED_VALIDATORS_ROLE);

        // ValidatorsExitBusOracle
        _assertProxyAdmin(VALIDATORS_EXIT_BUS_ORACLE, AGENT);
        _assertSingleOZRoleHolder(VALIDATORS_EXIT_BUS_ORACLE, DEFAULT_ADMIN_ROLE, AGENT);

        // WithdrawalVault
        _assertWithdrawalsManagerProxyAdmin(WITHDRAWAL_VAULT, AGENT);

        // Consolidation rollout
        _assertSingleOZRoleHolder(CONSOLIDATION_GATEWAY, DEFAULT_ADMIN_ROLE, AGENT);
        _assertTwoOZRoleHolders(CONSOLIDATION_GATEWAY, PAUSE_ROLE, CONSOLIDATION_GATEWAY_GATE_SEAL, RESEAL_MANAGER);
        _assertSingleOZRoleHolder(CONSOLIDATION_GATEWAY, RESUME_ROLE, RESEAL_MANAGER);

        _assertSingleOZRoleHolder(CONSOLIDATION_GATEWAY, ADD_CONSOLIDATION_REQUEST_ROLE, CONSOLIDATION_BUS);
        _assertSingleOZRoleHolder(CONSOLIDATION_GATEWAY, PAUSE_ROLE, CONSOLIDATION_GATEWAY_GATE_SEAL);

        _assertProxyAdmin(CONSOLIDATION_BUS, AGENT);
        _assertSingleOZRoleHolder(CONSOLIDATION_BUS, DEFAULT_ADMIN_ROLE, AGENT);
        _assertSingleOZRoleHolder(CONSOLIDATION_BUS, PUBLISH_ROLE, CONSOLIDATION_MIGRATOR);
        _assertSingleOZRoleHolder(CONSOLIDATION_BUS, REMOVE_ROLE, AGENT);

        _assertProxyAdmin(CONSOLIDATION_MIGRATOR, AGENT);
        _assertSingleOZRoleHolder(CONSOLIDATION_MIGRATOR, DEFAULT_ADMIN_ROLE, AGENT);
        _assertSingleOZRoleHolder(CONSOLIDATION_MIGRATOR, ALLOW_PAIR_ROLE, EASY_TRACK_EVM_SCRIPT_EXECUTOR);
        _assertSingleOZRoleHolder(CONSOLIDATION_MIGRATOR, DISALLOW_PAIR_ROLE, CURATED_MODULE_COMMITTEE);

        // TopUps
        _assertProxyAdmin(TOP_UP_GATEWAY, AGENT);
        _assertSingleOZRoleHolder(TOP_UP_GATEWAY, DEFAULT_ADMIN_ROLE, AGENT);
        _assertSingleOZRoleHolder(TOP_UP_GATEWAY, TOP_UP_ROLE, TOP_UP_GATEWAY_DEPOSITOR);

        // OracleReportSanityChecker
        _assertSingleOZRoleHolder(NEW_ORACLE_REPORT_SANITY_CHECKER, DEFAULT_ADMIN_ROLE, AGENT);
        bytes32[12] memory roles = [
            ALL_LIMITS_MANAGER_ROLE,
            EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE,
            APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE,
            ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE,
            SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE,
            MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE,
            MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE,
            MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE,
            REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE,
            MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE,
            SECOND_OPINION_MANAGER_ROLE,
            INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE
        ];
        for (uint256 i = 0; i < roles.length; ++i) {
            _assertZeroOZRoleHolders(NEW_ORACLE_REPORT_SANITY_CHECKER, roles[i]);
        }
    }

    function _assertEasyTrackFactories() internal view {
        IEasyTrack easyTrack = IEasyTrack(EASY_TRACK);

        address[9] memory newFactories = [
            ETF_NEW_UPDATE_STAKING_MODULE_SHARE_LIMITS,
            ETF_NEW_ALLOW_CONSOLIDATION_PAIR,
            ETF_NEW_SET_MERKLE_GATE_TREE_FOR_CSM,
            ETF_NEW_REPORT_WITHDRAWALS_FOR_SLASHED_VALIDATORS_FOR_CSM,
            ETF_NEW_SETTLE_GENERAL_DELAYED_PENALTY_FOR_CSM,
            ETF_NEW_SET_MERKLE_GATE_TREE_FOR_CM,
            ETF_NEW_REPORT_WITHDRAWALS_FOR_SLASHED_VALIDATORS_FOR_CM,
            ETF_NEW_SETTLE_GENERAL_DELAYED_PENALTY_FOR_CM,
            ETF_NEW_CREATE_OR_UPDATE_OPERATOR_GROUP
        ];

        for (uint256 i = 0; i < newFactories.length; ++i) {
            if (!easyTrack.isEVMScriptFactory(newFactories[i])) {
                revert UnexpectedNewEasyTrackFactories();
            }
        }

        // address[1] memory oldFactories =
        //     [ETF_OLD_SETTLE_EL_STEALING_PENALTY];

        // for (uint256 i = 0; i < newFactories.length; ++i) {
        //     if (easyTrack.isEVMScriptFactory(newFactories[i])) {
        //         revert UnexpectedOldEasyTrackFactories();
        //     }
        // }
    }

    function _checkStakingRouter() internal view {
        IStakingRouter sr = IStakingRouter(STAKING_ROUTER);
        // bytes32 newWithdrawalCredentials = sr.getWithdrawalCredentials();
        // if (newWithdrawalCredentials != initialWithdrawalCredentials) {
        //     revert StakingRouterMigrationIncorrectWithdrawalCredentials();
        // }
        // uint256[] memory moduleIds = sr.getStakingModuleIds();
        // if (moduleIds.length != initialModulesCount + 1) {
        //     // 1 new module is added in this upgrade
        //     revert StakingRouterMigrationIncorrectModulesCount();
        // }

        // uint256 newModuleId = moduleIds[moduleIds.length - 1];
        uint256 newModuleId = initialModulesCount; // the new module should be added
        ModuleStateConfig memory config = sr.getStakingModuleStateConfig(newModuleId);
        if (
            config.moduleAddress != CURATED_MODULE
            // || config.moduleFee != CURATED_STAKING_MODULE_FEE
            //     || config.treasuryFee != CURATED_TREASURY_FEE || config.stakeShareLimit != CURATED_STAKE_SHARE_LIMIT
            //     || config.priorityExitShareThreshold != CURATED_PRIORITY_EXIT_SHARE_THRESHOLD
            //     || config.status != StakingModuleStatus.Active || config.withdrawalCredentialsType != 0x02
        ) {
            revert StakingRouterMigrationIncorrectAddStakingModule();
        }
    }

    function _checkLido() internal view {
        uint256 bufferedEther = ILidoWithFinalizeUpgrade(LIDO).getBufferedEther();
        if (bufferedEther != initialBufferedEther) {
            revert LidoMigrationIncorrectBufferedEther();
        }

        // (uint256 depositedValidators, uint256 clValidators, uint256 beaconBalance) =
        //     ILidoWithFinalizeUpgrade(LIDO).getBeaconStat();

        // if (depositedValidators != initialDepositedValidators || clValidators != depositedValidators) {
        //     revert LidoMigrationIncorrectDepositedValidators();
        // }

        (
            uint256 clValidatorsBalanceAtLastReport,
            uint256 clPendingBalanceAtLastReport,
            uint256 depositedSinceLastReport,
            uint256 depositedForCurrentReport
        ) = ILidoWithFinalizeUpgrade(LIDO).getBalanceStats();

        if (clValidatorsBalanceAtLastReport != initialBeaconBalance || clPendingBalanceAtLastReport != 0) {
            revert LidoMigrationIncorrectBeaconBalance();
        }

        if (
            depositedSinceLastReport != (initialDepositedValidators - initialBeaconValidators) * 32 ether
                || depositedForCurrentReport != 0
        ) {
            revert LidoMigrationIncorrectDepositedSinceLastReport();
        }
    }

    function _checkDSM() internal view {
        IDepositSecurityModule dsm = IDepositSecurityModule(NEW_DEPOSIT_SECURITY_MODULE);
        // IDepositSecurityModule oldDsm = IDepositSecurityModule(OLD_DEPOSIT_SECURITY_MODULE);
        if (dsm.getOwner() != AGENT) {
            revert DSMMigrationIncorrectOwner();
        }

        // address[] memory guardians = dsm.getGuardians();
        // if (dsm.getGuardianQuorum() != oldDsm.getGuardianQuorum()) {
        //     revert DSMMigrationIncorrectGuardianQuorum();
        // }
        // for (uint256 i = 0; i < guardians.length; ++i) {
        //     if (!oldDsm.isGuardian(guardians[i])) {
        //         revert DSMMigrationIncorrectGuardians();
        //     }
        // }
    }

    function _assertProxyAdmin(address _proxy, address _admin) internal view {
        if (IOssifiableProxy(_proxy).proxy__getAdmin() != _admin) revert IncorrectProxyAdmin(_proxy);
    }

    function _assertProxyImplementation(address _proxy, address _implementation) internal view {
        address actualImplementation = IOssifiableProxy(_proxy).proxy__getImplementation();
        if (actualImplementation != _implementation) {
            revert IncorrectProxyImplementation(_proxy, actualImplementation);
        }
    }

    function _assertAragonKernelImplementation(IAragonKernel _kernel, address _implementation) internal view {
        if (_kernel.getApp(_kernel.APP_BASES_NAMESPACE(), LIDO_APP_ID) != _implementation) {
            revert IncorrectAragonKernelImplementation(address(_kernel), _implementation);
        }
    }

    function _assertWithdrawalsManagerProxyAdmin(address _proxy, address _admin) internal view {
        if (IWithdrawalsManagerProxy(_proxy).proxy_getAdmin() != _admin) revert IncorrectProxyAdmin(_proxy);
    }

    function _assertWithdrawalsManagerProxyImplementation(address _proxy, address _implementation) internal view {
        address actualImplementation = IWithdrawalsManagerProxy(_proxy).implementation();
        if (actualImplementation != _implementation) {
            revert IncorrectProxyImplementation(_proxy, actualImplementation);
        }
    }

    function _assertZeroOZRoleHolders(address _accessControlled, bytes32 _role) internal view {
        IAccessControlEnumerable accessControlled = IAccessControlEnumerable(_accessControlled);
        if (accessControlled.getRoleMemberCount(_role) != 0) {
            revert NonZeroRoleHolders(address(accessControlled), _role);
        }
    }

    function _assertSingleOZRoleHolder(address _accessControlled, bytes32 _role, address _holder) internal view {
        IAccessControlEnumerable accessControlled = IAccessControlEnumerable(_accessControlled);
        if (accessControlled.getRoleMemberCount(_role) != 1 || accessControlled.getRoleMember(_role, 0) != _holder) {
            revert IncorrectOZAccessControlRoleHolders(address(accessControlled), _role);
        }
    }

    function _assertTwoOZRoleHolders(address _accessControlled, bytes32 _role, address _holder1, address _holder2)
        internal
        view
    {
        address[] memory holders = new address[](2);
        holders[0] = _holder1;
        holders[1] = _holder2;
        _assertOZRoleHolders(_accessControlled, _role, holders);
    }

    function _assertOZRoleHolders(address _accessControlled, bytes32 _role, address[] memory _holders) internal view {
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

    function _assertContractVersion(address _versioned, uint256 _expectedVersion) internal view {
        if (IVersioned(_versioned).getContractVersion() != _expectedVersion) {
            revert InvalidContractVersion(_versioned, _expectedVersion);
        }
    }

    function _isStartCalledInThisTx() internal view returns (bool isStartCalledInThisTx) {
        assembly {
            isStartCalledInThisTx := tload(UPGRADE_STARTED_SLOT)
        }
    }

    function _transferAdminToAgent(address _contract) private {
        IAccessControl(_contract).grantRole(DEFAULT_ADMIN_ROLE, AGENT);
        IAccessControl(_contract).renounceRole(DEFAULT_ADMIN_ROLE, address(this));
    }

    error OnlyAgentCanUpgrade();
    error UpgradeAlreadyStarted();
    error UpgradeAlreadyFinished();
    error IncorrectProxyAdmin(address proxy);
    error IncorrectProxyImplementation(address proxy, address implementation);
    error InvalidContractVersion(address contractAddress, uint256 actualVersion);
    error IncorrectOZAccessControlRoleHolders(address contractAddress, bytes32 role);
    error NonZeroRoleHolders(address contractAddress, bytes32 role);
    error IncorrectAragonKernelImplementation(address kernel, address implementation);
    error StartAndFinishMustBeInSameTx();
    error StartAlreadyCalledInThisTx();
    error Expired();
    error LidoMigrationIncorrectBufferedEther();
    error LidoMigrationIncorrectDepositedValidators();
    error LidoMigrationIncorrectBeaconBalance();
    error LidoMigrationIncorrectDepositedSinceLastReport();

    error StakingRouterMigrationIncorrectAddStakingModule();
    error StakingRouterMigrationIncorrectModulesCount();
    error StakingRouterMigrationIncorrectWithdrawalCredentials();

    error DSMMigrationIncorrectOwner();
    error DSMMigrationIncorrectGuardianQuorum();
    error DSMMigrationIncorrectGuardians();

    error UnexpectedNewEasyTrackFactories();
    error UnexpectedOldEasyTrackFactories();
}
