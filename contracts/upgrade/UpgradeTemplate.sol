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
    GlobalConfig,
    CoreUpgradeConfig,
    CuratedModuleConfig,
    EasyTrackNewFactories,
    EasyTrackOldFactories,
    ILidoWithFinalizeUpgrade,
    IBaseOracle,
    IValidatorsExitBusOracle,
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
contract UpgradeTemplate {
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
    uint256 public constant EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION = 5;
    uint256 public constant EXPECTED_FINAL_ACCOUNTING_ORACLE_CONSENSUS_VERSION = 6;
    uint256 public constant EXPECTED_FINAL_VALIDATORS_EXIT_BUS_ORACLE_VERSION = 3;
    uint256 public constant EXPECTED_FINAL_VALIDATORS_EXIT_BUS_ORACLE_CONSENSUS_VERSION = 5;
    uint256 public constant EXPECTED_FINAL_WITHDRAWAL_VAULT_VERSION = 3;

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    // Initial value of upgradeBlockNumber storage variable
    uint256 public constant UPGRADE_NOT_STARTED = 0;
    uint256 public constant INFINITE_ALLOWANCE = type(uint256).max;

    // Upgrade config (self deployed internal contract)
    UpgradeConfig public immutable CONFIG;
    address public immutable AGENT;

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
    bytes32 internal initialWithdrawalCredentials;
    uint256 internal initialModulesCount;
    address[] internal initialDSMGuardians;
    uint256 internal initialDSMGuardianQuorum;

    //
    // Slots for transient storage
    //

    // Slot for the upgrade started flag
    // / keccak256("UpgradeTemplate.upgradeStartedFlag");
    bytes32 public constant UPGRADE_STARTED_SLOT = 0x058d69f67a3d86c424c516d23a070ff8bed34431617274caa2049bd702675e3f;

    /// @param _params Params required to initialize the addresses contract
    /// @param _expireSinceInclusive Unix timestamp after which upgrade actions revert
    constructor(UpgradeParameters memory _params, uint256 _expireSinceInclusive) {
        UpgradeConfig config = new UpgradeConfig(_params);
        CONFIG = config;
        AGENT = config.AGENT();
        EXPIRE_SINCE_INCLUSIVE = _expireSinceInclusive;
    }

    /// @notice Must be called before LidoLocator is upgraded
    function startUpgrade() external {
        UpgradeConfig config = UpgradeConfig(CONFIG);
        GlobalConfig memory g = config.getGlobalConfig();
        CoreUpgradeConfig memory c = config.getCoreUpgradeConfig();

        if (msg.sender != g.agent) revert OnlyAgentCanUpgrade();
        if (block.timestamp >= EXPIRE_SINCE_INCLUSIVE) revert Expired();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (_isStartCalledInThisTx()) revert StartAlreadyCalledInThisTx();
        if (upgradeBlockNumber != UPGRADE_NOT_STARTED) revert UpgradeAlreadyStarted();

        assembly { tstore(UPGRADE_STARTED_SLOT, 1) }
        upgradeBlockNumber = block.number;

        initialBufferedEther = ILidoWithFinalizeUpgrade(g.lido).getBufferedEther();
        (initialDepositedValidators, initialBeaconValidators, initialBeaconBalance) =
            ILidoWithFinalizeUpgrade(g.lido).getBeaconStat();

        IStakingRouter sr = IStakingRouter(g.stakingRouter);
        initialWithdrawalCredentials = sr.getWithdrawalCredentials();
        initialModulesCount = sr.getStakingModulesCount();

        initialDSMGuardians = IDepositSecurityModule(c.oldDepositSecurityModule).getGuardians();
        initialDSMGuardianQuorum = IDepositSecurityModule(c.oldDepositSecurityModule).getGuardianQuorum();

        _assertPreUpgradeState(g, c);

        emit UpgradeStarted();
    }

    function finishUpgrade() external {
        UpgradeConfig config = UpgradeConfig(CONFIG);
        GlobalConfig memory g = config.getGlobalConfig();
        CoreUpgradeConfig memory c = config.getCoreUpgradeConfig();

        if (msg.sender != g.agent) revert OnlyAgentCanUpgrade();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (!_isStartCalledInThisTx()) revert StartAndFinishMustBeInSameTx();

        isUpgradeFinished = true;

        ILidoWithFinalizeUpgrade(g.lido).finalizeUpgrade_v4();
        IWithdrawalVault(c.withdrawalVault).finalizeUpgrade_v3();
        IAccountingOracle(c.accountingOracle).finalizeUpgrade_v5(c.aoConsensusVersion);
        IValidatorsExitBusOracle(c.validatorsExitBusOracle)
            .finalizeUpgrade_v3(
                c.veboMaxValidatorsPerReport,
                c.veboMaxExitBalanceEth,
                c.veboBalancePerFrameEth,
                c.veboFrameDurationInSec,
                c.veboConsensusVersion
            );

        _assertPostUpgradeState(g, c);

        emit UpgradeFinished();
    }

    //
    // Assertions
    //

    function _assertPreUpgradeState(GlobalConfig memory g, CoreUpgradeConfig memory c) internal view {
        // Check initial implementations of the proxies to be upgraded
        _assertAragonKernelImplementation(IAragonKernel(c.kernel), c.lidoAppId, c.oldLidoImpl);

        _assertProxyImplementation(c.locator, c.oldLocatorImpl);
        _assertProxyImplementation(c.accounting, c.oldAccountingImpl);
        _assertProxyImplementation(c.accountingOracle, c.oldAccountingOracleImpl);
        _assertProxyImplementation(g.stakingRouter, c.oldStakingRouterImpl);
        _assertProxyImplementation(c.validatorsExitBusOracle, c.oldValidatorsExitBusOracleImpl);

        _assertWithdrawalsManagerProxyImplementation(c.withdrawalVault, c.oldWithdrawalVaultImpl);
    }

    function _assertPostUpgradeState(GlobalConfig memory g, CoreUpgradeConfig memory c) internal view {
        // if (
        //     ILidoWithFinalizeUpgrade(LIDO).getTotalShares() != initialTotalShares
        //         || ILidoWithFinalizeUpgrade(LIDO).getTotalPooledEther() != initialTotalPooledEther
        // ) {
        //     revert TotalSharesOrPooledEtherChanged();
        // }

        _assertAragonKernelImplementation(IAragonKernel(c.kernel), c.lidoAppId, c.newLidoImpl);

        _assertProxyImplementation(c.locator, c.newLocatorImpl);
        _assertProxyImplementation(c.accounting, c.newAccountingImpl);
        _assertProxyImplementation(c.accountingOracle, c.newAccountingOracleImpl);
        _assertProxyImplementation(g.stakingRouter, c.newStakingRouterImpl);
        _assertProxyImplementation(c.validatorsExitBusOracle, c.newValidatorsExitBusOracleImpl);

        _assertWithdrawalsManagerProxyImplementation(c.withdrawalVault, c.newWithdrawalVaultImpl);

        _assertProxyImplementation(c.consolidationBus, c.consolidationBusImpl);
        _assertProxyImplementation(c.consolidationMigrator, c.consolidationMigratorImpl);
        _assertProxyImplementation(c.topUpGateway, c.topUpGatewayImpl);

        _assertContractVersion(g.lido, EXPECTED_FINAL_LIDO_VERSION);
        _assertContractVersion(g.stakingRouter, EXPECTED_FINAL_STAKING_ROUTER_VERSION);
        _assertContractVersion(c.accountingOracle, EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION);
        _assertOracleConsensusVersion(c.accountingOracle, EXPECTED_FINAL_ACCOUNTING_ORACLE_CONSENSUS_VERSION);
        _assertContractVersion(c.validatorsExitBusOracle, EXPECTED_FINAL_VALIDATORS_EXIT_BUS_ORACLE_VERSION);
        _assertOracleConsensusVersion(
            c.validatorsExitBusOracle, EXPECTED_FINAL_VALIDATORS_EXIT_BUS_ORACLE_CONSENSUS_VERSION
        );
        _assertContractVersion(c.withdrawalVault, EXPECTED_FINAL_WITHDRAWAL_VAULT_VERSION);

        _assertEasyTrackFactories(g, c);

        _assertFinalACL(g, c);

        _checkSRMigration(g, c);
        _checkLidoMigration(g, c);
        _checkDSMMigration(g, c);
    }

    function _assertFinalACL(GlobalConfig memory g, CoreUpgradeConfig memory c) internal view {
        address agent = g.agent;
        // address resealManager = g.resealManager;
        address stakingRouter = g.stakingRouter;
        // StakingRouter
        _assertProxyAdmin(stakingRouter, agent);
        _assertSingleOZRoleHolder(stakingRouter, DEFAULT_ADMIN_ROLE, agent);
        _assertSingleOZRoleHolder(stakingRouter, STAKING_MODULE_MANAGE_ROLE, agent);
        _assertSingleOZRoleHolder(stakingRouter, STAKING_MODULE_UNVETTING_ROLE, c.newDepositSecurityModule);
        _assertSingleOZRoleHolder(stakingRouter, REPORT_REWARDS_MINTED_ROLE, c.accounting);
        _assertSingleOZRoleHolder(stakingRouter, REPORT_EXITED_VALIDATORS_ROLE, c.accountingOracle);
        _assertSingleOZRoleHolder(stakingRouter, REPORT_VALIDATOR_EXITING_STATUS_ROLE, c.validatorsExitBusOracle);
        _assertSingleOZRoleHolder(stakingRouter, REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE, c.withdrawalVault);
        _assertSingleOZRoleHolder(stakingRouter, STAKING_MODULE_SHARE_MANAGE_ROLE, g.easyTrackEVMScriptExecutor);
        _assertZeroOZRoleHolders(stakingRouter, MANAGE_WITHDRAWAL_CREDENTIALS_ROLE);
        _assertZeroOZRoleHolders(stakingRouter, UNSAFE_SET_EXITED_VALIDATORS_ROLE);

        // Accounting
        _assertProxyAdmin(c.accounting, agent);
        _assertSingleOZRoleHolder(c.accounting, DEFAULT_ADMIN_ROLE, agent);

        // AccountingOracle
        _assertProxyAdmin(c.accountingOracle, agent);
        _assertSingleOZRoleHolder(c.accountingOracle, DEFAULT_ADMIN_ROLE, agent);

        // ValidatorsExitBusOracle
        _assertProxyAdmin(c.validatorsExitBusOracle, agent);
        _assertSingleOZRoleHolder(c.validatorsExitBusOracle, DEFAULT_ADMIN_ROLE, agent);

        // WithdrawalVault
        _assertWithdrawalsManagerProxyAdmin(c.withdrawalVault, agent);

        // Consolidation rollout
        _assertSingleOZRoleHolder(c.consolidationGateway, DEFAULT_ADMIN_ROLE, agent);
        _assertTwoOZRoleHolders(c.consolidationGateway, PAUSE_ROLE, g.circuitBreaker, g.resealManager);
        _assertSingleOZRoleHolder(c.consolidationGateway, RESUME_ROLE, g.resealManager);

        _assertSingleOZRoleHolder(c.consolidationGateway, ADD_CONSOLIDATION_REQUEST_ROLE, c.consolidationBus);

        _assertProxyAdmin(c.consolidationBus, agent);
        _assertSingleOZRoleHolder(c.consolidationBus, DEFAULT_ADMIN_ROLE, agent);
        _assertSingleOZRoleHolder(c.consolidationBus, PUBLISH_ROLE, c.consolidationMigrator);
        _assertSingleOZRoleHolder(c.consolidationBus, REMOVE_ROLE, agent);

        _assertProxyAdmin(c.consolidationMigrator, agent);
        _assertSingleOZRoleHolder(c.consolidationMigrator, DEFAULT_ADMIN_ROLE, agent);
        _assertSingleOZRoleHolder(c.consolidationMigrator, ALLOW_PAIR_ROLE, g.easyTrackEVMScriptExecutor);
        _assertSingleOZRoleHolder(c.consolidationMigrator, DISALLOW_PAIR_ROLE, c.curatedModuleCommittee);

        // TopUps
        _assertProxyAdmin(c.topUpGateway, agent);
        _assertSingleOZRoleHolder(c.topUpGateway, DEFAULT_ADMIN_ROLE, agent);
        _assertSingleOZRoleHolder(c.topUpGateway, TOP_UP_ROLE, c.topUpGatewayDepositor);

        // OracleReportSanityChecker
        _assertSingleOZRoleHolder(c.newOracleReportSanityChecker, DEFAULT_ADMIN_ROLE, agent);
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
            _assertZeroOZRoleHolders(c.newOracleReportSanityChecker, roles[i]);
        }
    }

    function _assertEasyTrackFactories(GlobalConfig memory g, CoreUpgradeConfig memory c) internal view {
        (EasyTrackNewFactories memory n, EasyTrackOldFactories memory o) = CONFIG.getEasyTrackConfig();
        IEasyTrack easyTrack = IEasyTrack(g.easyTrack);

        address[9] memory newFactories = [
            n.UpdateStakingModuleShareLimits,
            n.AllowConsolidationPair,
            n.SetMerkleGateTreeForCSM,
            n.ReportWithdrawalsForSlashedValidatorsForCSM,
            n.SettleGeneralDelayedPenaltyForCSM,
            n.SetMerkleGateTreeForCM,
            n.ReportWithdrawalsForSlashedValidatorsForCM,
            n.SettleGeneralDelayedPenaltyForCM,
            n.CreateOrUpdateOperatorGroup
        ];

        for (uint256 i = 0; i < newFactories.length; ++i) {
            if (!easyTrack.isEVMScriptFactory(newFactories[i])) {
                revert UnexpectedNewEasyTrackFactories();
            }
        }

        // address[2] memory oldFactories =
        //     [o.CSMSettleElStealingPenalty, o.CSMSetVettedGateTree];

        // for (uint256 i = 0; i < newFactories.length; ++i) {
        //     if (easyTrack.isEVMScriptFactory(newFactories[i])) {
        //         revert UnexpectedOldEasyTrackFactories();
        //     }
        // }
    }

    function _checkSRMigration(GlobalConfig memory g, CoreUpgradeConfig memory c) internal view {
        CuratedModuleConfig memory cm = UpgradeConfig(CONFIG).getCuratedModuleConfig();

        IStakingRouter sr = IStakingRouter(g.stakingRouter);
        bytes32 newWithdrawalCredentials = sr.getWithdrawalCredentials();
        if (newWithdrawalCredentials != initialWithdrawalCredentials) {
            revert SRMigrationIncorrectWithdrawalCredentials();
        }
        uint256[] memory moduleIds = sr.getStakingModuleIds();
        if (moduleIds.length != initialModulesCount + 1) {
            // 1 new module is added in this upgrade
            revert SRMigrationIncorrectModulesCount();
        }

        uint256 newModuleId = moduleIds[moduleIds.length - 1];
        // uint256 newModuleId = initialModulesCount; // the new module should be added
        ModuleStateConfig memory stateConfig = sr.getStakingModuleStateConfig(newModuleId);
        if (
            stateConfig.moduleAddress != cm.module || stateConfig.moduleFee != cm.stakingModuleFee
                || stateConfig.treasuryFee != cm.treasuryFee || stateConfig.stakeShareLimit != cm.stakeShareLimit
                || stateConfig.priorityExitShareThreshold != cm.priorityExitShareThreshold
                || stateConfig.status != StakingModuleStatus.Active || stateConfig.withdrawalCredentialsType != 0x02
        ) {
            revert SRMigrationIncorrectAddStakingModule();
        }
    }

    function _checkLidoMigration(GlobalConfig memory g, CoreUpgradeConfig memory c) internal view {
        uint256 bufferedEther = ILidoWithFinalizeUpgrade(g.lido).getBufferedEther();
        if (bufferedEther != initialBufferedEther) {
            revert LidoMigrationIncorrectBufferedEther();
        }

        (uint256 depositedValidators, uint256 clValidators, uint256 beaconBalance) =
            ILidoWithFinalizeUpgrade(g.lido).getBeaconStat();

        if (depositedValidators != initialDepositedValidators || clValidators != depositedValidators) {
            revert LidoMigrationIncorrectDepositedValidators();
        }

        (
            uint256 clValidatorsBalanceAtLastReport,
            uint256 clPendingBalanceAtLastReport,
            uint256 depositedSinceLastReport,
            uint256 depositedForCurrentReport
        ) = ILidoWithFinalizeUpgrade(g.lido).getBalanceStats();

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

    function _checkDSMMigration(GlobalConfig memory g, CoreUpgradeConfig memory c) internal view {
        IDepositSecurityModule dsm = IDepositSecurityModule(c.newDepositSecurityModule);
        IDepositSecurityModule oldDsm = IDepositSecurityModule(c.oldDepositSecurityModule);
        if (dsm.getOwner() != g.agent) {
            revert DSMMigrationIncorrectOwner();
        }

        address[] memory guardians = dsm.getGuardians();
        if (dsm.getGuardianQuorum() != oldDsm.getGuardianQuorum()) {
            revert DSMMigrationIncorrectGuardianQuorum();
        }
        for (uint256 i = 0; i < guardians.length; ++i) {
            if (!oldDsm.isGuardian(guardians[i])) {
                revert DSMMigrationIncorrectGuardians();
            }
        }
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

    function _assertAragonKernelImplementation(IAragonKernel _kernel, bytes32 appId, address _implementation)
        internal
        view
    {
        if (_kernel.getApp(_kernel.APP_BASES_NAMESPACE(), appId) != _implementation) {
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

    function _assertOracleConsensusVersion(address _oracle, uint256 _expectedVersion) internal view {
        if (IBaseOracle(_oracle).getConsensusVersion() != _expectedVersion) {
            revert InvalidOracleConsensusVersion(_oracle, _expectedVersion);
        }
    }

    function _assertVersionedContractVersion(address _versioned, uint256 _expectedVersion) internal view {
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
    error StartAndFinishMustBeInSameTx();
    error StartAlreadyCalledInThisTx();
    error Expired();
    error UpgradeAlreadyStarted();
    error UpgradeAlreadyFinished();

    error IncorrectProxyAdmin(address proxy);
    error IncorrectProxyImplementation(address proxy, address implementation);
    error InvalidContractVersion(address contractAddress, uint256 actualVersion);
    error InvalidOracleConsensusVersion(address oracle, uint256 actualVersion);
    error IncorrectOZAccessControlRoleHolders(address contractAddress, bytes32 role);
    error NonZeroRoleHolders(address contractAddress, bytes32 role);
    error IncorrectAragonKernelImplementation(address kernel, address implementation);

    error LidoMigrationIncorrectBufferedEther();
    error LidoMigrationIncorrectDepositedValidators();
    error LidoMigrationIncorrectBeaconBalance();
    error LidoMigrationIncorrectDepositedSinceLastReport();

    error SRMigrationIncorrectAddStakingModule();
    error SRMigrationIncorrectModulesCount();
    error SRMigrationIncorrectWithdrawalCredentials();

    error DSMMigrationIncorrectOwner();
    error DSMMigrationIncorrectGuardianQuorum();
    error DSMMigrationIncorrectGuardians();

    error UnexpectedNewEasyTrackFactories();
    error UnexpectedOldEasyTrackFactories();
}
