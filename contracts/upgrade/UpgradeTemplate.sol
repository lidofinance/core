// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {
    IAccessControl,
    IAccessControlEnumerable
} from "@openzeppelin/contracts-v5.2/access/extensions/IAccessControlEnumerable.sol";

import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";
import {IPausableUntil} from "contracts/common/interfaces/IPausableUntil.sol";
import {ICircuitBreaker} from "contracts/common/interfaces/ICircuitBreaker.sol";
import {ModuleStateConfig, StakingModuleStatus} from "contracts/0.8.25/sr/SRTypes.sol";
import {IUpgradeTemplate} from "./interfaces/IUpgradeTemplate.sol";
import {
    UpgradeParameters,
    GlobalConfig,
    CoreUpgradeConfig,
    CSMUpgradeConfig,
    CuratedModuleConfig,
    ILidoUpgrade,
    IBaseOracle,
    IWithdrawalsManagerProxy,
    IAragonKernel,
    IAragonACL,
    IVersioned,
    IWithdrawalsManagerProxy,
    IStakingRouterUpgrade,
    IDepositSecurityModule,
    IInitializedVersionView,
    IMerkleGate,
    IOneShotCurveSetup
} from "./UpgradeTypes.sol";

import {UpgradeConfig} from "./UpgradeConfig.sol";

/**
 * @title Lido Upgrade Template
 *
 * @dev Must be used by means of two calls:
 *   - `startUpgrade()` before upgrading LidoLocator and before everything else
 *   - `finishUpgrade()` as the last step of the upgrade
 */
contract UpgradeTemplate is IUpgradeTemplate {
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
    bytes32 internal constant MANAGE_ROLE = keccak256("MANAGE_ROLE");
    // csm roles
    bytes32 internal constant REPORT_EL_REWARDS_STEALING_PENALTY_ROLE =
        keccak256("REPORT_EL_REWARDS_STEALING_PENALTY_ROLE");
    bytes32 internal constant SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE =
        keccak256("SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE");
    bytes32 internal constant REPORT_GENERAL_DELAYED_PENALTY_ROLE = keccak256("REPORT_GENERAL_DELAYED_PENALTY_ROLE");
    bytes32 internal constant SETTLE_GENERAL_DELAYED_PENALTY_ROLE = keccak256("SETTLE_GENERAL_DELAYED_PENALTY_ROLE");
    bytes32 internal constant REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE =
        keccak256("REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE");
    bytes32 internal constant REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE =
        keccak256("REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE");
    bytes32 internal constant START_REFERRAL_SEASON_ROLE = keccak256("START_REFERRAL_SEASON_ROLE");
    bytes32 internal constant END_REFERRAL_SEASON_ROLE = keccak256("END_REFERRAL_SEASON_ROLE");
    bytes32 internal constant ADD_FULL_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_FULL_WITHDRAWAL_REQUEST_ROLE");
    bytes32 internal constant CREATE_NODE_OPERATOR_ROLE = keccak256("CREATE_NODE_OPERATOR_ROLE");
    bytes32 internal constant SET_BOND_CURVE_ROLE = keccak256("SET_BOND_CURVE_ROLE");
    bytes32 internal constant MANAGE_BOND_CURVES_ROLE = keccak256("MANAGE_BOND_CURVES_ROLE");
    bytes32 internal constant MANAGE_CURVE_PARAMETERS_ROLE = keccak256("MANAGE_CURVE_PARAMETERS_ROLE");
    bytes32 internal constant MANAGE_GENERAL_PENALTIES_AND_CHARGES_ROLE =
        keccak256("MANAGE_GENERAL_PENALTIES_AND_CHARGES_ROLE");
    bytes32 internal constant REQUEST_BURN_MY_STETH_ROLE = keccak256("REQUEST_BURN_MY_STETH_ROLE");
    bytes32 internal constant REQUEST_BURN_SHARES_ROLE = keccak256("REQUEST_BURN_SHARES_ROLE");
    bytes32 internal constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

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
    bytes32 internal constant BUFFER_RESERVE_MANAGER_ROLE = keccak256("BUFFER_RESERVE_MANAGER_ROLE");

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
    uint256 public constant EXPECTED_FINAL_COMMUNITY_FEE_ORACLE_VERSION = 3;

    uint64 public constant EXPECTED_FINAL_CSM_MODULE_INITIALIZED_VERSION = 3;
    uint64 public constant EXPECTED_FINAL_CSM_PARAMETERS_REGISTRY_INITIALIZED_VERSION = 3;
    uint64 public constant EXPECTED_FINAL_CSM_ACCOUNTING_INITIALIZED_VERSION = 3;
    uint64 public constant EXPECTED_FINAL_CSM_FEE_DISTRIBUTOR_INITIALIZED_VERSION = 3;
    uint64 public constant EXPECTED_FINAL_CSM_VALIDATOR_STRIKES_INITIALIZED_VERSION = 1;
    uint64 public constant EXPECTED_FINAL_CSM_VETTED_GATE_INITIALIZED_VERSION = 1;

    uint64 public constant EXPECTED_FINAL_CM_MODULE_INITIALIZED_VERSION = 1;
    uint64 public constant EXPECTED_FINAL_CM_PARAMETERS_REGISTRY_INITIALIZED_VERSION = 3;
    uint64 public constant EXPECTED_FINAL_CM_ACCOUNTING_INITIALIZED_VERSION = 3;
    uint64 public constant EXPECTED_FINAL_CM_FEE_DISTRIBUTOR_INITIALIZED_VERSION = 3;
    uint64 public constant EXPECTED_FINAL_CM_VALIDATOR_STRIKES_INITIALIZED_VERSION = 1;

    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    // Hoodi currently has a legacy dev EOA with STAKING_MODULE_MANAGE_ROLE in pre-upgrade state.
    address internal constant HOODI_LEGACY_STAKING_MODULE_MANAGER = 0xE28f573b732632fdE03BD5507A7d475383e8512E;

    // Initial value of upgradeBlockNumber storage variable
    uint256 internal constant UPGRADE_NOT_STARTED = 0;
    uint256 internal constant INFINITE_ALLOWANCE = type(uint256).max;

    // Upgrade config (self deployed internal contract)
    address public immutable CONFIG;
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

    uint256 internal initialBufferedEther;
    uint256 internal initialDepositedValidators;
    uint256 internal initialBeaconValidators;
    uint256 internal initialBeaconBalance;
    bytes32 internal initialWithdrawalCredentials;
    uint256 internal initialModulesCount;

    //
    // Slots for transient storage
    //

    // Slot for the upgrade started flag
    // / keccak256("UpgradeTemplate.upgradeStartedFlag");
    bytes32 public constant UPGRADE_STARTED_SLOT = 0x35b46117eef044799338cc40f60a0c4c38c26772e3f81f535801c8d814ecc33d;

    /// @param _params Params required to initialize the addresses contract
    /// @param _expireSinceInclusive Unix timestamp after which upgrade actions revert
    constructor(UpgradeParameters memory _params, uint256 _expireSinceInclusive) {
        UpgradeConfig config = new UpgradeConfig(_params);
        CONFIG = address(config);
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

        initialBufferedEther = ILidoUpgrade(g.lido).getBufferedEther();
        (initialDepositedValidators, initialBeaconValidators, initialBeaconBalance) =
            ILidoUpgrade(g.lido).getBeaconStat();

        IStakingRouterUpgrade sr = IStakingRouterUpgrade(g.stakingRouter);
        initialWithdrawalCredentials = sr.getWithdrawalCredentials();
        initialModulesCount = sr.getStakingModulesCount();

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

        // todo check added module id === migrator target module id
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

        _assertFinalACL(g, c);
        _assertCSMFinalState(g);
        _assertCMFinalState(g);

        _checkSRMigration(g, c);
        _checkLidoMigration(g, c);
        _checkDSMMigration(g, c);
    }

    function _assertFinalACL(GlobalConfig memory g, CoreUpgradeConfig memory c) internal view {
        address agent = g.agent;
        // address resealManager = g.resealManager;
        address stakingRouter = g.stakingRouter;
        // StakingRouter (only critical roles))
        _assertProxyAdmin(stakingRouter, agent);
        _assertSingleOZRoleHolder(stakingRouter, DEFAULT_ADMIN_ROLE, agent);
        _assertTwoOZRoleHolders(
            stakingRouter, STAKING_MODULE_MANAGE_ROLE, agent, HOODI_LEGACY_STAKING_MODULE_MANAGER
        );
        _assertSingleOZRoleHolder(stakingRouter, STAKING_MODULE_UNVETTING_ROLE, c.newDepositSecurityModule);
        _assertSingleOZRoleHolder(stakingRouter, STAKING_MODULE_SHARE_MANAGE_ROLE, g.easyTrackEVMScriptExecutor);
        _assertZeroOZRoleHolders(stakingRouter, MANAGE_WITHDRAWAL_CREDENTIALS_ROLE);

        // Accounting
        _assertProxyAdmin(c.accounting, agent);

        // AccountingOracle
        _assertProxyAdmin(c.accountingOracle, agent);
        _assertSingleOZRoleHolder(c.accountingOracle, DEFAULT_ADMIN_ROLE, agent);

        // ValidatorsExitBusOracle
        _assertProxyAdmin(c.validatorsExitBusOracle, agent);
        _assertSingleOZRoleHolder(c.validatorsExitBusOracle, DEFAULT_ADMIN_ROLE, agent);

        // WithdrawalVault
        _assertWithdrawalsManagerProxyAdmin(c.withdrawalVault, agent);

        // Lido
        _assertAragonPermissionManager(c.acl, g.lido, BUFFER_RESERVE_MANAGER_ROLE, agent);
        _assertHasAragonPermission(c.acl, g.lido, BUFFER_RESERVE_MANAGER_ROLE, agent);

        // Consolidation rollout
        _assertSingleOZRoleHolder(c.consolidationGateway, DEFAULT_ADMIN_ROLE, agent);
        _assertTwoOZRoleHolders(c.consolidationGateway, PAUSE_ROLE, g.circuitBreaker, g.resealManager);
        _assertSingleOZRoleHolder(c.consolidationGateway, RESUME_ROLE, g.resealManager);

        _assertSingleOZRoleHolder(c.consolidationGateway, ADD_CONSOLIDATION_REQUEST_ROLE, c.consolidationBus);

        _assertProxyAdmin(c.consolidationBus, agent);
        _assertSingleOZRoleHolder(c.consolidationBus, DEFAULT_ADMIN_ROLE, agent);
        _assertSingleOZRoleHolder(c.consolidationBus, PUBLISH_ROLE, c.consolidationMigrator);
        _assertZeroOZRoleHolders(c.consolidationBus, MANAGE_ROLE);
        _assertZeroOZRoleHolders(c.consolidationBus, REMOVE_ROLE);

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

    function _assertCSMFinalState(GlobalConfig memory g) internal view {
        CSMUpgradeConfig memory csm = UpgradeConfig(CONFIG).getCSMUpgradeConfig();

        _assertProxyImplementation(csm.csm, csm.csmImpl);
        _assertProxyImplementation(csm.parametersRegistry, csm.parametersRegistryImpl);
        _assertProxyImplementation(csm.feeOracle, csm.feeOracleImpl);
        _assertProxyImplementation(csm.vettedGate, csm.vettedGateImpl);
        _assertProxyImplementation(csm.accounting, csm.accountingImpl);
        _assertProxyImplementation(csm.feeDistributor, csm.feeDistributorImpl);
        _assertProxyImplementation(csm.exitPenalties, csm.exitPenaltiesImpl);
        _assertProxyImplementation(csm.strikes, csm.strikesImpl);

        _assertProxyAdmin(csm.csm, g.agent);
        _assertProxyAdmin(csm.parametersRegistry, g.agent);
        _assertProxyAdmin(csm.feeOracle, g.agent);
        _assertProxyAdmin(csm.vettedGate, g.agent);
        _assertProxyAdmin(csm.accounting, g.agent);
        _assertProxyAdmin(csm.feeDistributor, g.agent);
        _assertProxyAdmin(csm.exitPenalties, g.agent);
        _assertProxyAdmin(csm.strikes, g.agent);

        _assertInitializedContractVersion(csm.csm, EXPECTED_FINAL_CSM_MODULE_INITIALIZED_VERSION);
        _assertInitializedContractVersion(
            csm.parametersRegistry, EXPECTED_FINAL_CSM_PARAMETERS_REGISTRY_INITIALIZED_VERSION
        );
        _assertInitializedContractVersion(csm.vettedGate, EXPECTED_FINAL_CSM_VETTED_GATE_INITIALIZED_VERSION);
        _assertInitializedContractVersion(csm.accounting, EXPECTED_FINAL_CSM_ACCOUNTING_INITIALIZED_VERSION);
        _assertInitializedContractVersion(csm.feeDistributor, EXPECTED_FINAL_CSM_FEE_DISTRIBUTOR_INITIALIZED_VERSION);
        _assertInitializedContractVersion(csm.strikes, EXPECTED_FINAL_CSM_VALIDATOR_STRIKES_INITIALIZED_VERSION);
        _assertContractVersion(csm.feeOracle, EXPECTED_FINAL_COMMUNITY_FEE_ORACLE_VERSION);
        _assertOracleConsensusVersion(csm.feeOracle, csm.feeOracleConsensusVersion);

        _assertZeroOZRoleHolders(csm.csm, REPORT_EL_REWARDS_STEALING_PENALTY_ROLE);
        _assertZeroOZRoleHolders(csm.csm, SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE);
        _assertSingleOZRoleHolder(csm.csm, REPORT_GENERAL_DELAYED_PENALTY_ROLE, csm.csmCommittee);
        _assertSingleOZRoleHolder(csm.csm, SETTLE_GENERAL_DELAYED_PENALTY_ROLE, g.easyTrackEVMScriptExecutor);
        _assertSingleOZRoleHolder(csm.csm, VERIFIER_ROLE, csm.newVerifier);
        _assertSingleOZRoleHolder(csm.csm, REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE, csm.newVerifier);
        _assertSingleOZRoleHolder(csm.csm, REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE, g.easyTrackEVMScriptExecutor);
        _assertTwoOZRoleHolders(csm.csm, PAUSE_ROLE, g.circuitBreaker, g.resealManager);
        _assertThreeOZRoleHolders(
            csm.csm, CREATE_NODE_OPERATOR_ROLE, csm.vettedGate, csm.newPermissionlessGate, csm.identifiedDVTClusterGate
        );

        _assertTwoOZRoleHolders(csm.accounting, PAUSE_ROLE, g.circuitBreaker, g.resealManager);
        _assertTwoOZRoleHolders(csm.feeOracle, PAUSE_ROLE, g.circuitBreaker, g.resealManager);
        _assertTwoOZRoleHolders(csm.vettedGate, PAUSE_ROLE, g.circuitBreaker, g.resealManager);
        _assertTwoOZRoleHolders(csm.identifiedDVTClusterGate, PAUSE_ROLE, g.circuitBreaker, g.resealManager);
        _assertTwoOZRoleHolders(csm.newVerifier, PAUSE_ROLE, g.circuitBreaker, g.resealManager);
        _assertTwoOZRoleHolders(csm.ejector, PAUSE_ROLE, g.circuitBreaker, g.resealManager);

        _assertCircuitBreakerPauser(g.circuitBreaker, csm.identifiedDVTClusterGate, csm.csmCommittee);
        _assertCircuitBreakerPauser(g.circuitBreaker, csm.newVerifier, csm.csmCommittee);
        _assertCircuitBreakerPauser(g.circuitBreaker, csm.ejector, csm.csmCommittee);

        _assertNotOZRoleHolder(csm.vettedGate, START_REFERRAL_SEASON_ROLE, g.agent);
        _assertNotOZRoleHolder(csm.vettedGate, END_REFERRAL_SEASON_ROLE, csm.csmCommittee);

        _assertHasOZRole(csm.accounting, SET_BOND_CURVE_ROLE, csm.identifiedDVTClusterGate);

        _assertNotOZRoleHolder(csm.accounting, MANAGE_BOND_CURVES_ROLE, csm.identifiedDVTClusterCurveSetup);
        _assertNotOZRoleHolder(
            csm.parametersRegistry, MANAGE_CURVE_PARAMETERS_ROLE, csm.identifiedDVTClusterCurveSetup
        );
        _assertIdentifiedDVTClusterCurve(csm);

        _assertSingleOZRoleHolder(
            csm.parametersRegistry, MANAGE_GENERAL_PENALTIES_AND_CHARGES_ROLE, csm.csmCommittee
        );

        _assertNotOZRoleHolder(g.burner, REQUEST_BURN_SHARES_ROLE, csm.accounting);
        _assertHasOZRole(g.burner, REQUEST_BURN_MY_STETH_ROLE, csm.accounting);

        _assertNotOZRoleHolder(g.triggerableWithdrawalsGateway, ADD_FULL_WITHDRAWAL_REQUEST_ROLE, csm.oldEjector);
        _assertHasOZRole(g.triggerableWithdrawalsGateway, ADD_FULL_WITHDRAWAL_REQUEST_ROLE, csm.ejector);
    }

    function _assertCMFinalState(GlobalConfig memory g) internal view {
        CuratedModuleConfig memory cm = UpgradeConfig(CONFIG).getCuratedModuleConfig();

        _assertInitializedContractVersion(cm.module, EXPECTED_FINAL_CM_MODULE_INITIALIZED_VERSION);
        _assertInitializedContractVersion(
            cm.parametersRegistry, EXPECTED_FINAL_CM_PARAMETERS_REGISTRY_INITIALIZED_VERSION
        );
        _assertInitializedContractVersion(cm.accounting, EXPECTED_FINAL_CM_ACCOUNTING_INITIALIZED_VERSION);
        _assertInitializedContractVersion(cm.feeDistributor, EXPECTED_FINAL_CM_FEE_DISTRIBUTOR_INITIALIZED_VERSION);
        _assertInitializedContractVersion(cm.strikes, EXPECTED_FINAL_CM_VALIDATOR_STRIKES_INITIALIZED_VERSION);
        _assertContractVersion(cm.feeOracle, EXPECTED_FINAL_COMMUNITY_FEE_ORACLE_VERSION);
        _assertOracleConsensusVersion(cm.feeOracle, cm.feeOracleConsensusVersion);

        _assertHasOZRole(g.burner, REQUEST_BURN_MY_STETH_ROLE, cm.accounting);
        _assertHasOZRole(g.triggerableWithdrawalsGateway, ADD_FULL_WITHDRAWAL_REQUEST_ROLE, cm.ejector);

        _assertTwoOZRoleHolders(cm.module, PAUSE_ROLE, g.circuitBreaker, g.resealManager);
        _assertTwoOZRoleHolders(cm.accounting, PAUSE_ROLE, g.circuitBreaker, g.resealManager);
        _assertTwoOZRoleHolders(cm.feeOracle, PAUSE_ROLE, g.circuitBreaker, g.resealManager);
        _assertTwoOZRoleHolders(cm.verifier, PAUSE_ROLE, g.circuitBreaker, g.resealManager);
        _assertTwoOZRoleHolders(cm.ejector, PAUSE_ROLE, g.circuitBreaker, g.resealManager);

        _assertCircuitBreakerPauser(g.circuitBreaker, cm.module, cm.circuitBreakerPauser);
        _assertCircuitBreakerPauser(g.circuitBreaker, cm.accounting, cm.circuitBreakerPauser);
        _assertCircuitBreakerPauser(g.circuitBreaker, cm.feeOracle, cm.circuitBreakerPauser);
        _assertCircuitBreakerPauser(g.circuitBreaker, cm.verifier, cm.circuitBreakerPauser);
        _assertCircuitBreakerPauser(g.circuitBreaker, cm.ejector, cm.circuitBreakerPauser);

        _assertNotOZRoleHolder(cm.module, RESUME_ROLE, g.agent);
        if (IPausableUntil(cm.module).isPaused()) {
            revert CMModuleIsPaused(cm.module);
        }

        // slither-disable-next-line unused-return
        (uint256 initialEpoch,) = IHashConsensus(cm.hashConsensus).getFrameConfig();
        if (initialEpoch != cm.hashConsensusInitialEpoch) {
            revert InvalidHashConsensusInitialEpoch(cm.hashConsensus, initialEpoch, cm.hashConsensusInitialEpoch);
        }
    }

    function _checkSRMigration(GlobalConfig memory g, CoreUpgradeConfig memory) internal view {
        CuratedModuleConfig memory cm = UpgradeConfig(CONFIG).getCuratedModuleConfig();

        IStakingRouterUpgrade sr = IStakingRouterUpgrade(g.stakingRouter);
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

    function _checkLidoMigration(GlobalConfig memory g, CoreUpgradeConfig memory) internal view {
        uint256 bufferedEther = ILidoUpgrade(g.lido).getBufferedEther();
        if (bufferedEther != initialBufferedEther) {
            revert LidoMigrationIncorrectBufferedEther();
        }

        // slither-disable-next-line unused-return
        (uint256 depositedValidators, uint256 clValidators,) = ILidoUpgrade(g.lido).getBeaconStat();

        if (depositedValidators != initialDepositedValidators || clValidators != depositedValidators) {
            revert LidoMigrationIncorrectDepositedValidators();
        }

        (
            uint256 clValidatorsBalanceAtLastReport,
            uint256 clPendingBalanceAtLastReport,
            uint256 depositedSinceLastReport,
            uint256 depositedForCurrentReport
        ) = ILidoUpgrade(g.lido).getBalanceStats();

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

    function _assertHasAragonPermission(address _acl, address _accessControlled, bytes32 _role, address _holder)
        internal
        view
    {
        if (!IAragonACL(_acl).hasPermission(_holder, _accessControlled, _role)) {
            revert MissingAragonPermissionHolder(_accessControlled, _role, _holder);
        }
    }

    function _assertAragonPermissionManager(address _acl, address _accessControlled, bytes32 _role, address _holder)
        internal
        view
    {
        address permissionManager = IAragonACL(_acl).getPermissionManager(_accessControlled, _role);
        if (permissionManager != _holder) {
            revert UnexpectedAragonPermissionManager(_accessControlled, _role, permissionManager, _holder);
        }
    }

    function _assertZeroOZRoleHolders(address _accessControlled, bytes32 _role) internal view {
        if (_getRoleMemberCount(_accessControlled, _role) != 0) {
            revert NonZeroRoleHolders(_accessControlled, _role);
        }
    }

    function _assertSingleOZRoleHolder(address _accessControlled, bytes32 _role, address _holder) internal view {
        if (
            _getRoleMemberCount(_accessControlled, _role) != 1 || _getRoleMember(_accessControlled, _role, 0) != _holder
        ) {
            revert IncorrectOZAccessControlRoleHolders(_accessControlled, _role);
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

    function _assertThreeOZRoleHolders(
        address _accessControlled,
        bytes32 _role,
        address _holder1,
        address _holder2,
        address _holder3
    ) internal view {
        address[] memory holders = new address[](3);
        holders[0] = _holder1;
        holders[1] = _holder2;
        holders[2] = _holder3;
        _assertOZRoleHolders(_accessControlled, _role, holders);
    }

    function _assertOZRoleHolders(address _accessControlled, bytes32 _role, address[] memory _holders) internal view {
        if (_getRoleMemberCount(_accessControlled, _role) != _holders.length) {
            revert IncorrectOZAccessControlRoleHolders(_accessControlled, _role);
        }
        for (uint256 i = 0; i < _holders.length; i++) {
            if (!_hasRole(_accessControlled, _role, _holders[i])) {
                revert IncorrectOZAccessControlRoleHolders(_accessControlled, _role);
            }
        }
    }

    function _assertHasOZRole(address _accessControlled, bytes32 _role, address _holder) internal view {
        if (!_hasRole(_accessControlled, _role, _holder)) {
            revert MissingOZAccessControlRoleHolder(_accessControlled, _role, _holder);
        }
    }

    function _assertNotOZRoleHolder(address _accessControlled, bytes32 _role, address _holder) internal view {
        if (_hasRole(_accessControlled, _role, _holder)) {
            revert UnexpectedOZAccessControlRoleHolder(_accessControlled, _role, _holder);
        }
    }

    function _assertCircuitBreakerPauser(address _circuitBreaker, address _pausable, address _expectedPauser)
        internal
        view
    {
        address actualPauser = ICircuitBreaker(_circuitBreaker).getPauser(_pausable);
        if (actualPauser != _expectedPauser) {
            revert InvalidCircuitBreakerPauser(_pausable, actualPauser, _expectedPauser);
        }
    }

    function _assertIdentifiedDVTClusterCurve(CSMUpgradeConfig memory _csm) internal view {
        IOneShotCurveSetup curveSetup = IOneShotCurveSetup(_csm.identifiedDVTClusterCurveSetup);
        if (!curveSetup.executed()) {
            revert IdentifiedDVTClusterCurveSetupNotExecuted(_csm.identifiedDVTClusterCurveSetup);
        }

        uint256 expectedCurveId = _csm.identifiedDVTClusterBondCurveId;
        uint256 actualSetupCurveId = curveSetup.deployedCurveId();
        if (actualSetupCurveId != expectedCurveId) {
            revert InvalidIdentifiedDVTClusterCurveId(
                _csm.identifiedDVTClusterCurveSetup, actualSetupCurveId, expectedCurveId
            );
        }

        uint256 actualGateCurveId = IMerkleGate(_csm.identifiedDVTClusterGate).curveId();
        if (actualGateCurveId != expectedCurveId) {
            revert InvalidIdentifiedDVTClusterCurveId(_csm.identifiedDVTClusterGate, actualGateCurveId, expectedCurveId);
        }
    }

    function _assertInitializedContractVersion(address _versioned, uint64 _expectedVersion) internal view {
        uint64 actualVersion = IInitializedVersionView(_versioned).getInitializedVersion();
        if (actualVersion != _expectedVersion) {
            revert InvalidInitializedContractVersion(_versioned, actualVersion, _expectedVersion);
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

    // OZ IAccessControlEnumerable wrappers
    function _hasRole(address _accessControlled, bytes32 _role, address _account) internal view returns (bool) {
        return IAccessControl(_accessControlled).hasRole(_role, _account);
    }

    function _getRoleMemberCount(address _accessControlled, bytes32 _role) internal view returns (uint256) {
        return IAccessControlEnumerable(_accessControlled).getRoleMemberCount(_role);
    }

    function _getRoleMember(address _accessControlled, bytes32 _role, uint256 _index) internal view returns (address) {
        return IAccessControlEnumerable(_accessControlled).getRoleMember(_role, _index);
    }

    function _isStartCalledInThisTx() internal view returns (bool isStartCalledInThisTx) {
        assembly {
            isStartCalledInThisTx := tload(UPGRADE_STARTED_SLOT)
        }
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
    error MissingAragonPermissionHolder(address contractAddress, bytes32 role, address holder);
    error UnexpectedAragonPermissionManager(
        address contractAddress, bytes32 role, address actualManager, address expectedManager
    );
    error IncorrectOZAccessControlRoleHolders(address contractAddress, bytes32 role);
    error MissingOZAccessControlRoleHolder(address contractAddress, bytes32 role, address holder);
    error UnexpectedOZAccessControlRoleHolder(address contractAddress, bytes32 role, address holder);
    error NonZeroRoleHolders(address contractAddress, bytes32 role);
    error IncorrectAragonKernelImplementation(address kernel, address implementation);
    error IncorrectLinkedContractAddress(address contractAddress, address actualAddress, address expectedAddress);
    error InvalidHashConsensusInitialEpoch(address consensus, uint256 actualEpoch, uint256 expectedEpoch);
    error CMModuleIsPaused(address module);
    error InvalidInitializedContractVersion(address contractAddress, uint64 actualVersion, uint64 expectedVersion);
    error InvalidCircuitBreakerPauser(address pausable, address actualPauser, address expectedPauser);
    error IdentifiedDVTClusterCurveSetupNotExecuted(address curveSetup);
    error InvalidIdentifiedDVTClusterCurveId(address contractAddress, uint256 actualCurveId, uint256 expectedCurveId);

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
}
