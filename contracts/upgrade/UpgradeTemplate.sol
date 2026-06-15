// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {
    IAccessControl,
    IAccessControlEnumerable
} from "@openzeppelin/contracts-v5.2/access/extensions/IAccessControlEnumerable.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";
import {IPausableUntil} from "contracts/common/interfaces/IPausableUntil.sol";
import {ICircuitBreaker} from "contracts/common/interfaces/ICircuitBreaker.sol";
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
    IStakingRouterUpgrade,
    IDepositSecurityModule,
    IConsolidationMigrator,
    IInitializedVersionView,
    IMerkleGate,
    IOneShotCurveSetup,
    IOracleReportSanityCheckerUpgrade,
    IWithdrawalVaultUpgrade,
    IConsolidationBus,
    IConsolidationMigrator
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
    bytes32 internal constant TW_EXIT_LIMIT_MANAGER_ROLE = keccak256("TW_EXIT_LIMIT_MANAGER_ROLE");

    //sanitychecker roles
    bytes32 internal constant ALL_LIMITS_MANAGER_ROLE = keccak256("ALL_LIMITS_MANAGER_ROLE");
    bytes32 internal constant ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE =
        keccak256("ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE");
    bytes32 internal constant SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE =
        keccak256("SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE");
    bytes32 internal constant MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE =
        keccak256("MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE");
    bytes32 internal constant MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE =
        keccak256("MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE");
    bytes32 internal constant REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE =
        keccak256("REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE");
    bytes32 internal constant MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE =
        keccak256("MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE");
    bytes32 internal constant SECOND_OPINION_MANAGER_ROLE = keccak256("SECOND_OPINION_MANAGER_ROLE");

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

    // Initial value of upgradeBlockNumber storage variable
    uint256 internal constant UPGRADE_NOT_STARTED = 0;
    // TODO: Unused. Remove
    uint256 internal constant INFINITE_ALLOWANCE = type(uint256).max;

    // Upgrade config (self deployed internal contract)
    address public immutable CONFIG;

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
    bytes32 internal constant UPGRADE_STARTED_SLOT = 0x35b46117eef044799338cc40f60a0c4c38c26772e3f81f535801c8d814ecc33d;

    /// @param _params Params required to initialize the addresses contract
    /// @param _expireSinceInclusive Unix timestamp after which upgrade actions revert
    constructor(UpgradeParameters memory _params, uint256 _expireSinceInclusive) {
        UpgradeConfig config = new UpgradeConfig(_params);
        CONFIG = address(config);
        EXPIRE_SINCE_INCLUSIVE = _expireSinceInclusive;
    }

    /// @notice Must be called before LidoLocator is upgraded
    function startUpgrade() external {
        UpgradeConfig config = UpgradeConfig(CONFIG);
        GlobalConfig memory g = config.getGlobalConfig();
        {
            if (msg.sender != g.agent) revert OnlyAgentCanUpgrade();
            if (block.timestamp >= EXPIRE_SINCE_INCLUSIVE) revert Expired();
            if (isUpgradeFinished) revert UpgradeAlreadyFinished();
            if (_isStartCalledInThisTx()) revert StartAlreadyCalledInThisTx();
            if (upgradeBlockNumber != UPGRADE_NOT_STARTED) revert UpgradeAlreadyStarted();

            assembly { tstore(UPGRADE_STARTED_SLOT, 1) }
            upgradeBlockNumber = block.number;
        }

        //
        // PreUpgrade steps
        //
        CoreUpgradeConfig memory c = UpgradeConfig(CONFIG).getCoreUpgradeConfig();

        ILidoUpgrade lido = ILidoUpgrade(g.lido);
        initialBufferedEther = lido.getBufferedEther();
        (initialDepositedValidators, initialBeaconValidators, initialBeaconBalance) = lido.getBeaconStat();

        IStakingRouterUpgrade sr = IStakingRouterUpgrade(g.stakingRouter);
        initialWithdrawalCredentials = sr.getWithdrawalCredentials();
        initialModulesCount = sr.getStakingModulesCount();

        // TODO: Either extend to all proxies, or remove at all.
        // Check initial implementations of the proxies to be upgraded
        _assertAragonKernelImplementation(IAragonKernel(c.kernel), c.lidoAppId, c.oldLidoImpl);

        _assertProxyImplementation(c.locator, c.oldLocatorImpl);
        _assertProxyImplementation(c.accounting, c.oldAccountingImpl);
        _assertProxyImplementation(c.accountingOracle, c.oldAccountingOracleImpl);
        _assertProxyImplementation(g.stakingRouter, c.oldStakingRouterImpl);
        _assertProxyImplementation(c.validatorsExitBusOracle, c.oldValidatorsExitBusOracleImpl);

        _assertWithdrawalsManagerProxyImplementation(c.withdrawalVault, c.oldWithdrawalVaultImpl);

        emit UpgradeStarted();
    }

    function finishUpgrade() external {
        UpgradeConfig config = UpgradeConfig(CONFIG);
        GlobalConfig memory g = config.getGlobalConfig();
        {
            if (msg.sender != g.agent) revert OnlyAgentCanUpgrade();
            if (isUpgradeFinished) revert UpgradeAlreadyFinished();
            if (!_isStartCalledInThisTx()) revert StartAndFinishMustBeInSameTx();

            isUpgradeFinished = true;
        }
        //
        // PostUpgrade steps
        //
        CoreUpgradeConfig memory c = UpgradeConfig(CONFIG).getCoreUpgradeConfig();

        // OracleReportSanityChecker final migration
        IOracleReportSanityCheckerUpgrade(c.newOracleReportSanityChecker).migrateBaselineSnapshot();

        _assertCoreFinalState(g, c);
        _assertCSMFinalState(g);
        _assertCMFinalState(g);

        _checkSRMFinalState(g, c);
        _checkLidoMigration(g, c);
        _checkDSMMigration(g, c);

        emit UpgradeFinished();
    }

    //
    // Assertions
    //

    function _assertCoreFinalState(GlobalConfig memory g, CoreUpgradeConfig memory c) internal view {
        address agent = g.agent;

        // Locator
        ILidoLocator locator = ILidoLocator(c.locator);
        _assertProxyImplementation(address(locator), c.newLocatorImpl);
        _assertLocatorAddress(locator.depositSecurityModule(), c.newDepositSecurityModule);

        // Lido
        _assertAragonKernelImplementation(IAragonKernel(c.kernel), c.lidoAppId, c.newLidoImpl);
        _assertContractVersion(g.lido, EXPECTED_FINAL_LIDO_VERSION);
        _assertAragonPermissionManager(c.acl, g.lido, BUFFER_RESERVE_MANAGER_ROLE, agent);
        _assertHasAragonPermission(c.acl, g.lido, BUFFER_RESERVE_MANAGER_ROLE, agent);

        // Accounting
        _assertProxyImplementation(c.accounting, c.newAccountingImpl);
        _assertProxyAdmin(c.accounting, agent);

        // Accounting Oracle
        {
            address ao = c.accountingOracle;
            _assertProxyImplementation(ao, c.newAccountingOracleImpl);
            _assertProxyAdmin(ao, agent);
            _assertContractVersion(ao, EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION);
            _assertOracleConsensusVersion(ao, EXPECTED_FINAL_ACCOUNTING_ORACLE_CONSENSUS_VERSION);
            _assertSingleOZRoleHolder(ao, DEFAULT_ADMIN_ROLE, agent);
        }

        // ValidatorsExitBusOracle
        {
            address vebo = c.validatorsExitBusOracle;
            _assertProxyImplementation(vebo, c.newValidatorsExitBusOracleImpl);
            _assertContractVersion(vebo, EXPECTED_FINAL_VALIDATORS_EXIT_BUS_ORACLE_VERSION);
            _assertOracleConsensusVersion(vebo, EXPECTED_FINAL_VALIDATORS_EXIT_BUS_ORACLE_CONSENSUS_VERSION);
            _assertProxyAdmin(vebo, agent);
            _assertSingleOZRoleHolder(vebo, DEFAULT_ADMIN_ROLE, agent);
        }

        // WithdrawalVault
        {
            address wv = c.withdrawalVault;
            _assertWithdrawalsManagerProxyImplementation(wv, c.newWithdrawalVaultImpl);
            _assertWithdrawalsManagerProxyAdmin(wv, agent);
            _assertContractVersion(wv, EXPECTED_FINAL_WITHDRAWAL_VAULT_VERSION);

            if (IWithdrawalVaultUpgrade(wv).CONSOLIDATION_GATEWAY() != c.consolidationGateway) {
                revert InvalidConsolidationGatewayAddressInWithdrawalVault();
            }
            if (IWithdrawalVaultUpgrade(wv).TRIGGERABLE_WITHDRAWALS_GATEWAY() != g.triggerableWithdrawalsGateway) {
                revert InvalidTriggerableWithdrawalsGatewayInWithdrawalVault();
            }
        }

        // SR
        {
            address sr = g.stakingRouter;
            _assertProxyImplementation(sr, c.newStakingRouterImpl);
            _assertProxyAdmin(sr, agent);
            _assertContractVersion(sr, EXPECTED_FINAL_STAKING_ROUTER_VERSION);
            _assertSingleOZRoleHolder(sr, DEFAULT_ADMIN_ROLE, agent);
            /// @dev _assertSingleOZRoleHolder not works on hoodi!
            _assertHasOZRole(sr, STAKING_MODULE_MANAGE_ROLE, agent);
            _assertSingleOZRoleHolder(sr, STAKING_MODULE_UNVETTING_ROLE, c.newDepositSecurityModule);
            _assertSingleOZRoleHolder(sr, STAKING_MODULE_SHARE_MANAGE_ROLE, g.easyTrackEVMScriptExecutor);
            _assertZeroOZRoleHolders(sr, MANAGE_WITHDRAWAL_CREDENTIALS_ROLE);
        }

        {
            address resealManager = g.resealManager;
            address resealCommittee = g.resealCommittee;
            address cb = g.circuitBreaker;

            // Consolidation
            address consGw = c.consolidationGateway;
            address consBus = c.consolidationBus;
            address consMigrator = c.consolidationMigrator;

            _assertProxyImplementation(consBus, c.consolidationBusImpl);
            _assertProxyAdmin(consBus, agent);
            _assertSingleOZRoleHolder(consBus, DEFAULT_ADMIN_ROLE, agent);
            _assertSingleOZRoleHolder(consBus, PUBLISH_ROLE, consMigrator);
            _assertZeroOZRoleHolders(consBus, MANAGE_ROLE);
            _assertSingleOZRoleHolder(consBus, REMOVE_ROLE, c.consolidationCommittee);

            if (IConsolidationBus(consBus).getConsolidationGateway() != consGw) {
                revert InvalidConsolidationGatewayAddressInConsolidationBus();
            }

            _assertProxyImplementation(consMigrator, c.consolidationMigratorImpl);
            _assertProxyAdmin(consMigrator, agent);
            _assertSingleOZRoleHolder(consMigrator, DEFAULT_ADMIN_ROLE, agent);
            _assertSingleOZRoleHolder(consMigrator, ALLOW_PAIR_ROLE, g.easyTrackEVMScriptExecutor);
            _assertSingleOZRoleHolder(consMigrator, DISALLOW_PAIR_ROLE, c.consolidationCommittee);
            if (IConsolidationMigrator(consMigrator).getConsolidationBus() != consBus) {
                revert InvalidConsolidationBusAddressInConsolidationMigrator();
            }
            /// @note correctness of TARGET_MODULE_ID is checked inside the SR migration checks

            _assertLocatorAddress(locator.consolidationGateway(), consGw);
            _assertSingleOZRoleHolder(consGw, DEFAULT_ADMIN_ROLE, agent);
            _assertTwoOZRoleHolders(consGw, PAUSE_ROLE, cb, resealManager);
            _assertSingleOZRoleHolder(consGw, RESUME_ROLE, resealManager);
            _assertSingleOZRoleHolder(consGw, ADD_CONSOLIDATION_REQUEST_ROLE, consBus);

            _assertCircuitBreakerPauser(cb, consGw, resealCommittee);

            // TopUps
            address tuGw = c.topUpGateway;
            _assertProxyImplementation(tuGw, c.topUpGatewayImpl);
            _assertProxyAdmin(tuGw, agent);
            _assertLocatorAddress(locator.topUpGateway(), tuGw);

            _assertSingleOZRoleHolder(tuGw, DEFAULT_ADMIN_ROLE, agent);
            _assertTwoOZRoleHolders(tuGw, PAUSE_ROLE, cb, resealManager);
            _assertSingleOZRoleHolder(tuGw, RESUME_ROLE, resealManager);
            _assertSingleOZRoleHolder(tuGw, TOP_UP_ROLE, c.topUpGatewayDepositor);

            _assertCircuitBreakerPauser(cb, tuGw, resealCommittee);
        }

        // TW
        {
            _assertSingleOZRoleHolder(g.triggerableWithdrawalsGateway, TW_EXIT_LIMIT_MANAGER_ROLE, agent);
        }

        {
            // OracleReportSanityChecker
            address checker = c.newOracleReportSanityChecker;
            _assertLocatorAddress(locator.oracleReportSanityChecker(), checker);
            _assertSingleOZRoleHolder(checker, DEFAULT_ADMIN_ROLE, agent);
            bytes32[8] memory roles = [
                ALL_LIMITS_MANAGER_ROLE,
                ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE,
                SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE,
                MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE,
                MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE,
                REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE,
                MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE,
                SECOND_OPINION_MANAGER_ROLE
            ];
            for (uint256 i = 0; i < roles.length; ++i) {
                _assertZeroOZRoleHolders(checker, roles[i]);
            }
        }
    }

    function _assertCSMFinalState(GlobalConfig memory g) internal view {
        CSMUpgradeConfig memory csm = UpgradeConfig(CONFIG).getCSMUpgradeConfig();
        address agent = g.agent;
        address resealManager = g.resealManager;
        address cb = g.circuitBreaker;
        address csModule = csm.csm;
        address csmCommittee = csm.csmCommittee;
        address newVerifier = csm.newVerifier;
        address vettedGate = csm.vettedGate;
        address accounting = csm.accounting;

        _assertProxyImplementation(csModule, csm.csmImpl);
        _assertProxyImplementation(csm.parametersRegistry, csm.parametersRegistryImpl);
        _assertProxyImplementation(csm.feeOracle, csm.feeOracleImpl);
        _assertProxyImplementation(vettedGate, csm.vettedGateImpl);
        _assertProxyImplementation(accounting, csm.accountingImpl);
        _assertProxyImplementation(csm.feeDistributor, csm.feeDistributorImpl);
        _assertProxyImplementation(csm.exitPenalties, csm.exitPenaltiesImpl);
        _assertProxyImplementation(csm.strikes, csm.strikesImpl);

        _assertProxyAdmin(csModule, agent);
        _assertProxyAdmin(csm.parametersRegistry, agent);
        _assertProxyAdmin(csm.feeOracle, agent);
        _assertProxyAdmin(vettedGate, agent);
        _assertProxyAdmin(accounting, agent);
        _assertProxyAdmin(csm.feeDistributor, agent);
        _assertProxyAdmin(csm.exitPenalties, agent);
        _assertProxyAdmin(csm.strikes, agent);

        _assertInitializedContractVersion(csModule, EXPECTED_FINAL_CSM_MODULE_INITIALIZED_VERSION);
        _assertInitializedContractVersion(
            csm.parametersRegistry, EXPECTED_FINAL_CSM_PARAMETERS_REGISTRY_INITIALIZED_VERSION
        );
        _assertInitializedContractVersion(vettedGate, EXPECTED_FINAL_CSM_VETTED_GATE_INITIALIZED_VERSION);
        _assertInitializedContractVersion(accounting, EXPECTED_FINAL_CSM_ACCOUNTING_INITIALIZED_VERSION);
        _assertInitializedContractVersion(csm.feeDistributor, EXPECTED_FINAL_CSM_FEE_DISTRIBUTOR_INITIALIZED_VERSION);
        _assertInitializedContractVersion(csm.strikes, EXPECTED_FINAL_CSM_VALIDATOR_STRIKES_INITIALIZED_VERSION);
        _assertContractVersion(csm.feeOracle, EXPECTED_FINAL_COMMUNITY_FEE_ORACLE_VERSION);
        _assertOracleConsensusVersion(csm.feeOracle, csm.feeOracleConsensusVersion);

        _assertZeroOZRoleHolders(csModule, REPORT_EL_REWARDS_STEALING_PENALTY_ROLE);
        _assertZeroOZRoleHolders(csModule, SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE);
        _assertSingleOZRoleHolder(csModule, REPORT_GENERAL_DELAYED_PENALTY_ROLE, csmCommittee);
        _assertSingleOZRoleHolder(csModule, SETTLE_GENERAL_DELAYED_PENALTY_ROLE, g.easyTrackEVMScriptExecutor);

        _assertSingleOZRoleHolder(csModule, VERIFIER_ROLE, newVerifier);
        _assertSingleOZRoleHolder(csModule, REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE, newVerifier);
        _assertSingleOZRoleHolder(csModule, REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE, g.easyTrackEVMScriptExecutor);
        _assertTwoOZRoleHolders(csModule, PAUSE_ROLE, cb, resealManager);
        _assertThreeOZRoleHolders(
            csModule, CREATE_NODE_OPERATOR_ROLE, vettedGate, csm.newPermissionlessGate, csm.identifiedDVTClusterGate
        );

        _assertTwoOZRoleHolders(accounting, PAUSE_ROLE, cb, resealManager);
        _assertTwoOZRoleHolders(csm.feeOracle, PAUSE_ROLE, cb, resealManager);
        _assertTwoOZRoleHolders(vettedGate, PAUSE_ROLE, cb, resealManager);
        _assertTwoOZRoleHolders(csm.identifiedDVTClusterGate, PAUSE_ROLE, cb, resealManager);
        _assertTwoOZRoleHolders(newVerifier, PAUSE_ROLE, cb, resealManager);
        _assertTwoOZRoleHolders(csm.ejector, PAUSE_ROLE, cb, resealManager);

        _assertCircuitBreakerPauser(cb, csm.identifiedDVTClusterGate, csmCommittee);
        _assertCircuitBreakerPauser(cb, newVerifier, csmCommittee);
        _assertCircuitBreakerPauser(cb, csm.ejector, csmCommittee);

        _assertNotOZRoleHolder(vettedGate, START_REFERRAL_SEASON_ROLE, agent);
        _assertNotOZRoleHolder(vettedGate, END_REFERRAL_SEASON_ROLE, csmCommittee);

        _assertHasOZRole(accounting, SET_BOND_CURVE_ROLE, csm.identifiedDVTClusterGate);

        _assertNotOZRoleHolder(accounting, MANAGE_BOND_CURVES_ROLE, csm.identifiedDVTClusterCurveSetup);
        _assertNotOZRoleHolder(csm.parametersRegistry, MANAGE_CURVE_PARAMETERS_ROLE, csm.identifiedDVTClusterCurveSetup);
        _assertIdentifiedDVTClusterCurve(csm);

        _assertSingleOZRoleHolder(csm.parametersRegistry, MANAGE_GENERAL_PENALTIES_AND_CHARGES_ROLE, csmCommittee);

        _assertNotOZRoleHolder(g.burner, REQUEST_BURN_SHARES_ROLE, accounting);
        _assertHasOZRole(g.burner, REQUEST_BURN_MY_STETH_ROLE, accounting);

        _assertNotOZRoleHolder(g.triggerableWithdrawalsGateway, ADD_FULL_WITHDRAWAL_REQUEST_ROLE, csm.oldEjector);
        _assertHasOZRole(g.triggerableWithdrawalsGateway, ADD_FULL_WITHDRAWAL_REQUEST_ROLE, csm.ejector);
    }

    function _assertCMFinalState(GlobalConfig memory g) internal view {
        CuratedModuleConfig memory cm = UpgradeConfig(CONFIG).getCuratedModuleConfig();
        address agent = g.agent;
        address resealManager = g.resealManager;
        address cb = g.circuitBreaker;
        address cModule = cm.module;
        address cbPauser = cm.circuitBreakerPauser;

        _assertInitializedContractVersion(cModule, EXPECTED_FINAL_CM_MODULE_INITIALIZED_VERSION);
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

        _assertTwoOZRoleHolders(cModule, PAUSE_ROLE, cb, resealManager);
        _assertTwoOZRoleHolders(cm.accounting, PAUSE_ROLE, cb, resealManager);
        _assertTwoOZRoleHolders(cm.feeOracle, PAUSE_ROLE, cb, resealManager);
        _assertTwoOZRoleHolders(cm.verifier, PAUSE_ROLE, cb, resealManager);
        _assertTwoOZRoleHolders(cm.ejector, PAUSE_ROLE, cb, resealManager);

        _assertCircuitBreakerPauser(cb, cModule, cbPauser);
        _assertCircuitBreakerPauser(cb, cm.accounting, cbPauser);
        _assertCircuitBreakerPauser(cb, cm.feeOracle, cbPauser);
        _assertCircuitBreakerPauser(cb, cm.verifier, cbPauser);
        _assertCircuitBreakerPauser(cb, cm.ejector, cbPauser);

        _assertNotOZRoleHolder(cModule, RESUME_ROLE, agent);
        if (IPausableUntil(cModule).isPaused()) {
            revert CMModuleIsPaused();
        }

        // slither-disable-next-line unused-return
        (uint256 initialEpoch,) = IHashConsensus(cm.hashConsensus).getFrameConfig();
        if (initialEpoch != cm.hashConsensusInitialEpoch) {
            revert InvalidHashConsensusInitialEpoch(cm.hashConsensus, initialEpoch, cm.hashConsensusInitialEpoch);
        }
    }

    function _checkSRMFinalState(GlobalConfig memory g, CoreUpgradeConfig memory c) internal view {
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

        {
            uint256 targetModuleId = IConsolidationMigrator(c.consolidationMigrator).targetModuleId();
            if (newModuleId != targetModuleId) {
                revert SRMigrationIncorrectConsolidationMigratorTargetModuleId(newModuleId, targetModuleId);
            }
        }

        if (sr.getStakingModuleStateConfig(newModuleId).moduleAddress != cm.module) {
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

        if (dsm.getGuardianQuorum() != oldDsm.getGuardianQuorum()) {
            revert DSMMigrationIncorrectGuardianQuorum();
        }

        address[] memory guardians = dsm.getGuardians();
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
        _assertOZRoleMembersCount(_accessControlled, _role, 0);
    }

    function _assertSingleOZRoleHolder(address _accessControlled, bytes32 _role, address _holder) internal view {
        _assertOZRoleMembersCount(_accessControlled, _role, 1);
        _assertHasOZRole(_accessControlled, _role, _holder);
    }

    function _assertTwoOZRoleHolders(address _accessControlled, bytes32 _role, address _holder1, address _holder2)
        internal
        view
    {
        _assertOZRoleMembersCount(_accessControlled, _role, 2);
        _assertHasOZRole(_accessControlled, _role, _holder1);
        _assertHasOZRole(_accessControlled, _role, _holder2);
    }

    function _assertThreeOZRoleHolders(
        address _accessControlled,
        bytes32 _role,
        address _holder1,
        address _holder2,
        address _holder3
    ) internal view {
        _assertOZRoleMembersCount(_accessControlled, _role, 3);
        _assertHasOZRole(_accessControlled, _role, _holder1);
        _assertHasOZRole(_accessControlled, _role, _holder2);
        _assertHasOZRole(_accessControlled, _role, _holder3);
    }

    function _assertOZRoleMembersCount(address _accessControlled, bytes32 _role, uint256 _count) internal view {
        if (_getRoleMemberCount(_accessControlled, _role) != _count) {
            revert IncorrectOZAccessControlRoleHolders(_accessControlled, _role);
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

    function _assertLocatorAddress(address _locatorAddress, address _appAddress) internal pure {
        if (_locatorAddress != _appAddress) {
            revert InvalidLocatorAppAddress(_locatorAddress, _appAddress);
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
    error InvalidLocatorAppAddress(address locatorAddress, address appAddress);
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
    error CMModuleIsPaused();
    error InvalidInitializedContractVersion(address contractAddress, uint64 actualVersion, uint64 expectedVersion);
    error InvalidCircuitBreakerPauser(address pausable, address actualPauser, address expectedPauser);
    error IdentifiedDVTClusterCurveSetupNotExecuted(address curveSetup);
    error InvalidIdentifiedDVTClusterCurveId(address contractAddress, uint256 actualCurveId, uint256 expectedCurveId);

    error InvalidConsolidationBusAddressInConsolidationMigrator();
    error InvalidConsolidationGatewayAddressInConsolidationBus();
    error InvalidConsolidationGatewayAddressInWithdrawalVault();
    error InvalidTriggerableWithdrawalsGatewayInWithdrawalVault();

    error LidoMigrationIncorrectBufferedEther();
    error LidoMigrationIncorrectDepositedValidators();
    error LidoMigrationIncorrectBeaconBalance();
    error LidoMigrationIncorrectDepositedSinceLastReport();

    error SRMigrationIncorrectAddStakingModule();
    error SRMigrationIncorrectModulesCount();
    error SRMigrationIncorrectWithdrawalCredentials();
    error SRMigrationIncorrectConsolidationMigratorTargetModuleId(uint256 newModuleId, uint256 targetModuleId);

    error DSMMigrationIncorrectOwner();
    error DSMMigrationIncorrectGuardianQuorum();
    error DSMMigrationIncorrectGuardians();
}
