// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {
    IUpgradeConfig,
    UpgradeParameters,
    EasyTrackNewFactories,
    EasyTrackOldFactories,
    CoreUpgradeParams,
    CSMUpgradeParams,
    CuratedModuleParams,
    GlobalConfig,
    CoreUpgradeConfig,
    CuratedModuleConfig,
    CSMUpgradeConfig,
    IAragonKernel,
    IAragonApp,
    IEasyTrack,
    IBaseModuleV3,
    ICuratedModule,
    IFeeOracleV3,
    IFeeDistributorV3,
    IValidatorStrikesV3
} from "./UpgradeTypes.sol";

/**
 * @title UpgradeConfig
 * @notice Stores immutable addresses and parameters required for the upgrade process.
 * This contract centralizes address/param management for UpgradeTemplate and UpgradeVoteScript.
 */
contract UpgradeConfig is IUpgradeConfig {
    //
    // -------- public fields --------
    //
    address public immutable LOCATOR;
    address public immutable AGENT;
    address public immutable VOTING;
    address public immutable DUAL_GOVERNANCE;
    address public immutable RESEAL_MANAGER;
    address public immutable BURNER;

    //
    // -------- Pre-upgrade old implementations --------
    //
    address internal immutable OLD_LOCATOR_IMPL;
    address internal immutable OLD_LIDO_IMPL;
    address internal immutable OLD_ACCOUNTING_IMPL;
    address internal immutable OLD_ACCOUNTING_ORACLE_IMPL;
    address internal immutable OLD_STAKING_ROUTER_IMPL;
    address internal immutable OLD_WITHDRAWAL_VAULT_IMPL;
    address internal immutable OLD_VALIDATORS_EXIT_BUS_ORACLE_IMPL;
    address internal immutable OLD_ORACLE_REPORT_SANITY_CHECKER;
    address internal immutable OLD_DEPOSIT_SECURITY_MODULE;

    //
    // -------- New implementations --------
    //
    address internal immutable NEW_LOCATOR_IMPL;
    address internal immutable NEW_LIDO_IMPL;
    address internal immutable NEW_ACCOUNTING_IMPL;
    address internal immutable NEW_ACCOUNTING_ORACLE_IMPL;
    address internal immutable NEW_STAKING_ROUTER_IMPL;
    address internal immutable NEW_WITHDRAWAL_VAULT_IMPL;
    address internal immutable NEW_VALIDATORS_EXIT_BUS_ORACLE_IMPL;
    address internal immutable NEW_ORACLE_REPORT_SANITY_CHECKER;
    address internal immutable NEW_DEPOSIT_SECURITY_MODULE;
    address internal immutable CONSOLIDATION_BUS_IMPL;
    address internal immutable CONSOLIDATION_MIGRATOR_IMPL;
    address internal immutable TOP_UP_GATEWAY_IMPL;

    //
    // -------- Upgraded contracts --------
    //
    address internal immutable LIDO;
    address internal immutable STAKING_ROUTER;
    address internal immutable ACCOUNTING_ORACLE;
    address internal immutable VALIDATORS_EXIT_BUS_ORACLE;
    address internal immutable WITHDRAWAL_VAULT;
    address internal immutable ACCOUNTING;
    address internal immutable TRIGGERABLE_WITHDRAWALS_GATEWAY;

    //
    // -------- New contracts --------
    //
    address internal immutable TOP_UP_GATEWAY;
    address internal immutable CONSOLIDATION_GATEWAY;
    address internal immutable CONSOLIDATION_BUS;
    address internal immutable CONSOLIDATION_MIGRATOR;
    address internal immutable ORACLE_REPORT_SANITY_CHECKER;
    address internal immutable DEPOSIT_SECURITY_MODULE;
    address internal immutable VALIDATOR_EXIT_DELAY_VERIFIER;

    //
    // -------- Upgrade parameters --------
    //
    uint256 internal immutable LIDO_DEPOSITS_RESERVE_TARGET;
    address internal immutable CONSOLIDATION_MANAGER_COMMITTEE;
    address internal immutable CONSOLIDATION_BUS_EXECUTOR;
    address internal immutable CONSOLIDATION_GATEWAY_GATE_SEAL;
    address internal immutable TOP_UP_GATEWAY_DEPOSITOR;

    // -------- EasyTrack addresses --------
    //
    address internal immutable EASY_TRACK;
    address internal immutable EASY_TRACK_EVM_SCRIPT_EXECUTOR;
    // ETF = EasyTrack Factory
    // SR Factories
    address internal immutable ETF_NEW_UPDATE_STAKING_MODULE_SHARE_LIMITS;
    address internal immutable ETF_NEW_ALLOW_CONSOLIDATION_PAIR;
    // CSM Factories
    address internal immutable ETF_NEW_ALLOWED_MERKLE_GATES_REGISTRY_FOR_CSM;
    address internal immutable ETF_NEW_SET_MERKLE_GATE_TREE_FOR_CSM;
    address internal immutable ETF_NEW_REPORT_WITHDRAWALS_FOR_SLASHED_VALIDATORS_FOR_CSM;
    address internal immutable ETF_NEW_SETTLE_GENERAL_DELAYED_PENALTY_FOR_CSM;
    // CM Factories
    address internal immutable ETF_NEW_ALLOWED_MERKLE_GATES_REGISTRY_FOR_CM;
    address internal immutable ETF_NEW_SET_MERKLE_GATE_TREE_FOR_CM;
    address internal immutable ETF_NEW_REPORT_WITHDRAWALS_FOR_SLASHED_VALIDATORS_FOR_CM;
    address internal immutable ETF_NEW_SETTLE_GENERAL_DELAYED_PENALTY_FOR_CM;
    address internal immutable ETF_NEW_CREATE_OR_UPDATE_OPERATOR_GROUP;
    // old factories
    address internal immutable ETF_OLD_SETTLE_EL_STEALING_PENALTY;
    address internal immutable ETF_OLD_CSM_SET_VETTED_GATE_TREE;

    //
    // ------- Misc -------
    //
    address internal immutable KERNEL;
    bytes32 internal immutable LIDO_APP_ID;
    address internal immutable ACL;

    // CSM
    address internal immutable CSM;
    address internal immutable CSM_IMPL;
    address internal immutable CSM_PARAMETERS_REGISTRY;
    address internal immutable CSM_PARAMETERS_REGISTRY_IMPL;
    address internal immutable CSM_FEE_ORACLE;
    address internal immutable CSM_FEE_ORACLE_IMPL;
    uint256 internal immutable CSM_FEE_ORACLE_CONSENSUS_VERSION;
    address internal immutable CSM_VETTED_GATE;
    address internal immutable CSM_VETTED_GATE_IMPL;
    address internal immutable CSM_ACCOUNTING;
    address internal immutable CSM_ACCOUNTING_IMPL;
    address internal immutable CSM_FEE_DISTRIBUTOR;
    address internal immutable CSM_FEE_DISTRIBUTOR_IMPL;
    address internal immutable CSM_EXIT_PENALTIES;
    address internal immutable CSM_EXIT_PENALTIES_IMPL;
    address internal immutable CSM_STRIKES;
    address internal immutable CSM_STRIKES_IMPL;
    address internal immutable CSM_OLD_PERMISSIONLESS_GATE;
    address internal immutable CSM_VERIFIER;
    address internal immutable CSM_VERIFIER_V3;
    address internal immutable CSM_PERMISSIONLESS_GATE;
    address internal immutable CSM_EJECTOR;
    address internal immutable CSM_IDENTIFIED_COMMUNITY_STAKERS_GATE_MANAGER;
    address internal immutable CSM_GATE_SEAL;
    address internal immutable CSM_GATE_SEAL_V3;
    address internal immutable CSM_GENERAL_DELAYED_PENALTY_REPORTER;
    address internal immutable CSM_PENALTIES_MANAGER;

    // CMv2
    address internal immutable CURATED_MODULE;
    address internal immutable CURATED_ACCOUNTING;
    address internal immutable CURATED_EJECTOR;
    address internal immutable CURATED_HASH_CONSENSUS;
    // save in storage
    string internal _curatedModuleName;
    uint256 internal immutable CURATED_STAKE_SHARE_LIMIT;
    uint256 internal immutable CURATED_PRIORITY_EXIT_SHARE_THRESHOLD;
    uint256 internal immutable CURATED_STAKING_MODULE_FEE;
    uint256 internal immutable CURATED_TREASURY_FEE;
    uint256 internal immutable CURATED_MAX_DEPOSITS_PER_BLOCK;
    uint256 internal immutable CURATED_MIN_DEPOSIT_BLOCK_DISTANCE;
    uint256 internal immutable CURATED_HASH_CONSENSUS_INITIAL_EPOCH;
    address internal immutable CURATED_META_REGISTRY;
    // Curated Merkle Gates
    address internal immutable CURATED_PROFESSIONAL_OPERATOR_GATE;
    address internal immutable CURATED_PROFESSIONAL_TRUSTED_OPERATOR_GATE;
    address internal immutable CURATED_PUBLIC_GOOD_OPERATOR_GATE;
    address internal immutable CURATED_DECENTRALIZATION_OPERATOR_GATE;
    address internal immutable CURATED_EXTRA_EFFORT_OPERATOR_GATE;
    address internal immutable CURATED_INTRA_OPERATOR_DVT_CLUSTER_GATE;

    // UpgradeParameters public upgradeParams;

    constructor(UpgradeParameters memory params) {
        // Core upgrade params
        CoreUpgradeParams memory coreUpgradeParams = params.coreUpgrade;

        if (coreUpgradeParams.newLocatorImpl == coreUpgradeParams.oldLocatorImpl) {
            revert NewAndOldLocatorImplementationsMustBeDifferent();
        }
        if (coreUpgradeParams.oldOracleReportSanityChecker == coreUpgradeParams.newOracleReportSanityChecker) {
            revert OldAndNewOracleReportSanityCheckerMustBeDifferent();
        }
        if (coreUpgradeParams.oldDepositSecurityModule == coreUpgradeParams.newDepositSecurityModule) {
            revert OldAndNewDepositSecurityModuleMustBeDifferent();
        }

        // Save passed parameters
        AGENT = params.agent;
        KERNEL = IAragonApp(AGENT).kernel();
        ACL = IAragonKernel(KERNEL).acl();

        VOTING = params.voting;
        DUAL_GOVERNANCE = params.dualGovernance;
        RESEAL_MANAGER = params.resealManager;

        EASY_TRACK = params.easyTrack;
        EASY_TRACK_EVM_SCRIPT_EXECUTOR = IEasyTrack(params.easyTrack).evmScriptExecutor();

        OLD_LOCATOR_IMPL = coreUpgradeParams.oldLocatorImpl;
        OLD_LIDO_IMPL = coreUpgradeParams.oldLidoImpl;
        OLD_ACCOUNTING_IMPL = coreUpgradeParams.oldAccountingImpl;
        OLD_ACCOUNTING_ORACLE_IMPL = coreUpgradeParams.oldAccountingOracleImpl;
        OLD_STAKING_ROUTER_IMPL = coreUpgradeParams.oldStakingRouterImpl;
        OLD_WITHDRAWAL_VAULT_IMPL = coreUpgradeParams.oldWithdrawalVaultImpl;
        OLD_VALIDATORS_EXIT_BUS_ORACLE_IMPL = coreUpgradeParams.oldValidatorsExitBusOracleImpl;
        OLD_ORACLE_REPORT_SANITY_CHECKER = coreUpgradeParams.oldOracleReportSanityChecker;
        OLD_DEPOSIT_SECURITY_MODULE = coreUpgradeParams.oldDepositSecurityModule;

        NEW_LOCATOR_IMPL = coreUpgradeParams.newLocatorImpl;
        NEW_LIDO_IMPL = coreUpgradeParams.newLidoImpl;
        NEW_ACCOUNTING_ORACLE_IMPL = coreUpgradeParams.newAccountingOracleImpl;
        NEW_STAKING_ROUTER_IMPL = coreUpgradeParams.newStakingRouterImpl;
        NEW_ACCOUNTING_IMPL = coreUpgradeParams.newAccountingImpl;
        NEW_WITHDRAWAL_VAULT_IMPL = coreUpgradeParams.newWithdrawalVaultImpl;
        NEW_VALIDATORS_EXIT_BUS_ORACLE_IMPL = coreUpgradeParams.newValidatorsExitBusOracleImpl;
        NEW_ORACLE_REPORT_SANITY_CHECKER = coreUpgradeParams.newOracleReportSanityChecker;
        NEW_DEPOSIT_SECURITY_MODULE = coreUpgradeParams.newDepositSecurityModule;
        CONSOLIDATION_BUS_IMPL = coreUpgradeParams.consolidationBusImpl;
        CONSOLIDATION_MIGRATOR_IMPL = coreUpgradeParams.consolidationMigratorImpl;
        TOP_UP_GATEWAY_IMPL = coreUpgradeParams.topUpGatewayImpl;

        CONSOLIDATION_BUS = coreUpgradeParams.consolidationBus;
        CONSOLIDATION_MIGRATOR = coreUpgradeParams.consolidationMigrator;

        LIDO_DEPOSITS_RESERVE_TARGET = coreUpgradeParams.lidoDepositsReserveTarget;
        CONSOLIDATION_MANAGER_COMMITTEE = coreUpgradeParams.consolidationManagerCommittee;
        CONSOLIDATION_BUS_EXECUTOR = coreUpgradeParams.consolidationBusExecutor;
        CONSOLIDATION_GATEWAY_GATE_SEAL = coreUpgradeParams.consolidationGatewayGateSeal;
        TOP_UP_GATEWAY_DEPOSITOR = coreUpgradeParams.topUpGatewayDepositor;

        // EasyTrack new factories
        EasyTrackNewFactories memory newFactories = params.newFactories;
        ETF_NEW_UPDATE_STAKING_MODULE_SHARE_LIMITS = newFactories.UpdateStakingModuleShareLimits;
        ETF_NEW_ALLOW_CONSOLIDATION_PAIR = newFactories.AllowConsolidationPair;
        ETF_NEW_ALLOWED_MERKLE_GATES_REGISTRY_FOR_CSM = newFactories.AllowedMerkleGatesRegistryForCSM;
        ETF_NEW_SET_MERKLE_GATE_TREE_FOR_CSM = newFactories.SetMerkleGateTreeForCSM;
        ETF_NEW_REPORT_WITHDRAWALS_FOR_SLASHED_VALIDATORS_FOR_CSM =
            newFactories.ReportWithdrawalsForSlashedValidatorsForCSM;
        ETF_NEW_SETTLE_GENERAL_DELAYED_PENALTY_FOR_CSM = newFactories.SettleGeneralDelayedPenaltyForCSM;
        ETF_NEW_ALLOWED_MERKLE_GATES_REGISTRY_FOR_CM = newFactories.AllowedMerkleGatesRegistryForCM;
        ETF_NEW_SET_MERKLE_GATE_TREE_FOR_CM = newFactories.SetMerkleGateTreeForCM;
        ETF_NEW_REPORT_WITHDRAWALS_FOR_SLASHED_VALIDATORS_FOR_CM =
            newFactories.ReportWithdrawalsForSlashedValidatorsForCM;
        ETF_NEW_SETTLE_GENERAL_DELAYED_PENALTY_FOR_CM = newFactories.SettleGeneralDelayedPenaltyForCM;
        ETF_NEW_CREATE_OR_UPDATE_OPERATOR_GROUP = newFactories.CreateOrUpdateOperatorGroup;

        // EasyTrack old factories
        EasyTrackOldFactories memory oldFactories = params.oldFactories;
        ETF_OLD_SETTLE_EL_STEALING_PENALTY = oldFactories.CSMSettleElStealingPenalty;
        ETF_OLD_CSM_SET_VETTED_GATE_TREE = oldFactories.CSMSetVettedGateTree;

        // Discover via locator
        LOCATOR = params.locator;
        ILidoLocator locator = ILidoLocator(coreUpgradeParams.newLocatorImpl);

        LIDO = locator.lido();
        LIDO_APP_ID = IAragonApp(LIDO).appId();

        ACCOUNTING_ORACLE = locator.accountingOracle();
        ORACLE_REPORT_SANITY_CHECKER = locator.oracleReportSanityChecker();
        ACCOUNTING = locator.accounting();
        STAKING_ROUTER = locator.stakingRouter();
        VALIDATORS_EXIT_BUS_ORACLE = locator.validatorsExitBusOracle();
        DEPOSIT_SECURITY_MODULE = locator.depositSecurityModule();
        WITHDRAWAL_VAULT = locator.withdrawalVault();
        TOP_UP_GATEWAY = locator.topUpGateway();
        BURNER = locator.burner();
        TRIGGERABLE_WITHDRAWALS_GATEWAY = locator.triggerableWithdrawalsGateway();
        VALIDATOR_EXIT_DELAY_VERIFIER = locator.validatorExitDelayVerifier();
        CONSOLIDATION_GATEWAY = locator.consolidationGateway();

        /// CSMv3
        CSMUpgradeParams memory csmUpgradeParams = params.csmUpgrade;

        CSM = csmUpgradeParams.csmProxy;
        CSM_IMPL = csmUpgradeParams.csmImpl;
        CSM_PARAMETERS_REGISTRY_IMPL = csmUpgradeParams.parametersRegistryImpl;
        CSM_FEE_ORACLE_IMPL = csmUpgradeParams.feeOracleImpl;
        CSM_FEE_ORACLE_CONSENSUS_VERSION = csmUpgradeParams.feeOracleConsensusVersion;
        CSM_VETTED_GATE = csmUpgradeParams.vettedGateProxy;
        CSM_VETTED_GATE_IMPL = csmUpgradeParams.vettedGateImpl;
        CSM_ACCOUNTING_IMPL = csmUpgradeParams.accountingImpl;
        CSM_FEE_DISTRIBUTOR_IMPL = csmUpgradeParams.feeDistributorImpl;
        CSM_EXIT_PENALTIES_IMPL = csmUpgradeParams.exitPenaltiesImpl;
        CSM_STRIKES_IMPL = csmUpgradeParams.strikesImpl;
        CSM_OLD_PERMISSIONLESS_GATE = csmUpgradeParams.oldPermissionlessGate;
        CSM_VERIFIER = csmUpgradeParams.verifier;
        CSM_VERIFIER_V3 = csmUpgradeParams.verifierV3;
        CSM_PERMISSIONLESS_GATE = csmUpgradeParams.permissionlessGate;
        CSM_EJECTOR = csmUpgradeParams.ejector;
        CSM_IDENTIFIED_COMMUNITY_STAKERS_GATE_MANAGER = csmUpgradeParams.identifiedCommunityStakersGateManager;
        CSM_GATE_SEAL = csmUpgradeParams.gateSeal;
        CSM_GATE_SEAL_V3 = csmUpgradeParams.gateSealV3;
        CSM_GENERAL_DELAYED_PENALTY_REPORTER = csmUpgradeParams.generalDelayedPenaltyReporter;
        CSM_PENALTIES_MANAGER = csmUpgradeParams.penaltiesManager;

        IBaseModuleV3 csm = IBaseModuleV3(CSM);
        CSM_PARAMETERS_REGISTRY = csm.PARAMETERS_REGISTRY();
        CSM_ACCOUNTING = csm.ACCOUNTING();
        CSM_EXIT_PENALTIES = csm.EXIT_PENALTIES();
        CSM_FEE_DISTRIBUTOR = csm.FEE_DISTRIBUTOR();
        CSM_FEE_ORACLE = IFeeDistributorV3(CSM_FEE_DISTRIBUTOR).ORACLE();
        CSM_STRIKES = IFeeOracleV3(CSM_FEE_ORACLE).STRIKES();

        // CMv2
        CuratedModuleParams memory curatedModuleParams = params.curatedModule;

        CURATED_MODULE = curatedModuleParams.module;
        /// @dev save in storage
        _curatedModuleName = curatedModuleParams.moduleName;
        CURATED_STAKE_SHARE_LIMIT = curatedModuleParams.stakeShareLimit;
        CURATED_PRIORITY_EXIT_SHARE_THRESHOLD = curatedModuleParams.priorityExitShareThreshold;
        CURATED_STAKING_MODULE_FEE = curatedModuleParams.stakingModuleFee;
        CURATED_TREASURY_FEE = curatedModuleParams.treasuryFee;
        CURATED_MAX_DEPOSITS_PER_BLOCK = curatedModuleParams.maxDepositsPerBlock;
        CURATED_MIN_DEPOSIT_BLOCK_DISTANCE = curatedModuleParams.minDepositBlockDistance;
        CURATED_HASH_CONSENSUS_INITIAL_EPOCH = curatedModuleParams.hashConsensusInitialEpoch;
        CURATED_PROFESSIONAL_OPERATOR_GATE = curatedModuleParams.professionalOperatorGate;
        CURATED_PROFESSIONAL_TRUSTED_OPERATOR_GATE = curatedModuleParams.professionalTrustedOperatorGate;
        CURATED_PUBLIC_GOOD_OPERATOR_GATE = curatedModuleParams.publicGoodOperatorGate;
        CURATED_DECENTRALIZATION_OPERATOR_GATE = curatedModuleParams.decentralizationOperatorGate;
        CURATED_EXTRA_EFFORT_OPERATOR_GATE = curatedModuleParams.extraEffortOperatorGate;
        CURATED_INTRA_OPERATOR_DVT_CLUSTER_GATE = curatedModuleParams.intraOperatorDVTClusterGate;

        ICuratedModule curatedModule = ICuratedModule(CURATED_MODULE);
        CURATED_META_REGISTRY = curatedModule.META_REGISTRY();
        CURATED_ACCOUNTING = curatedModule.ACCOUNTING();
        address curatedFeeDistributor = curatedModule.FEE_DISTRIBUTOR();
        address curatedFeeOracle = IFeeDistributorV3(curatedFeeDistributor).ORACLE();
        CURATED_HASH_CONSENSUS = IFeeOracleV3(curatedFeeOracle).getConsensusContract();
        address curatedStrikes = IFeeOracleV3(curatedFeeOracle).STRIKES();
        CURATED_EJECTOR = IValidatorStrikesV3(curatedStrikes).ejector();
    }

    function getGlobalConfig() external view returns (GlobalConfig memory) {
        return GlobalConfig({
            agent: AGENT,
            burner: BURNER,
            resealManager: RESEAL_MANAGER,
            easyTrack: EASY_TRACK,
            easyTrackEVMScriptExecutor: EASY_TRACK_EVM_SCRIPT_EXECUTOR,
            stakingRouter: STAKING_ROUTER,
            triggerableWithdrawalsGateway: TRIGGERABLE_WITHDRAWALS_GATEWAY
        });
    }

    function getEasyTrackConfig() external view returns (EasyTrackNewFactories memory, EasyTrackOldFactories memory) {
        return (
            EasyTrackNewFactories({
                UpdateStakingModuleShareLimits: ETF_NEW_UPDATE_STAKING_MODULE_SHARE_LIMITS,
                AllowConsolidationPair: ETF_NEW_ALLOW_CONSOLIDATION_PAIR,
                AllowedMerkleGatesRegistryForCSM: ETF_NEW_ALLOWED_MERKLE_GATES_REGISTRY_FOR_CSM,
                SetMerkleGateTreeForCSM: ETF_NEW_SET_MERKLE_GATE_TREE_FOR_CSM,
                ReportWithdrawalsForSlashedValidatorsForCSM: ETF_NEW_REPORT_WITHDRAWALS_FOR_SLASHED_VALIDATORS_FOR_CSM,
                SettleGeneralDelayedPenaltyForCSM: ETF_NEW_SETTLE_GENERAL_DELAYED_PENALTY_FOR_CSM,
                AllowedMerkleGatesRegistryForCM: ETF_NEW_ALLOWED_MERKLE_GATES_REGISTRY_FOR_CM,
                SetMerkleGateTreeForCM: ETF_NEW_SET_MERKLE_GATE_TREE_FOR_CM,
                ReportWithdrawalsForSlashedValidatorsForCM: ETF_NEW_REPORT_WITHDRAWALS_FOR_SLASHED_VALIDATORS_FOR_CM,
                SettleGeneralDelayedPenaltyForCM: ETF_NEW_SETTLE_GENERAL_DELAYED_PENALTY_FOR_CM,
                CreateOrUpdateOperatorGroup: ETF_NEW_CREATE_OR_UPDATE_OPERATOR_GROUP
            }),
            EasyTrackOldFactories({
                CSMSettleElStealingPenalty: ETF_OLD_SETTLE_EL_STEALING_PENALTY,
                CSMSetVettedGateTree: ETF_OLD_CSM_SET_VETTED_GATE_TREE
            })
        );
    }

    function getCoreUpgradeConfig() external view returns (CoreUpgradeConfig memory) {
        return CoreUpgradeConfig({
            kernel: KERNEL,
            acl: ACL,
            lidoAppId: LIDO_APP_ID,
            locator: LOCATOR,
            // old impl
            oldLocatorImpl: OLD_LOCATOR_IMPL,
            oldLidoImpl: OLD_LIDO_IMPL,
            oldAccountingImpl: OLD_ACCOUNTING_IMPL,
            oldAccountingOracleImpl: OLD_ACCOUNTING_ORACLE_IMPL,
            oldStakingRouterImpl: OLD_STAKING_ROUTER_IMPL,
            oldWithdrawalVaultImpl: OLD_WITHDRAWAL_VAULT_IMPL,
            oldValidatorsExitBusOracleImpl: OLD_VALIDATORS_EXIT_BUS_ORACLE_IMPL,
            oldOracleReportSanityChecker: OLD_ORACLE_REPORT_SANITY_CHECKER,
            oldDepositSecurityModule: OLD_DEPOSIT_SECURITY_MODULE,
            // new impl
            newLocatorImpl: NEW_LOCATOR_IMPL,
            newLidoImpl: NEW_LIDO_IMPL,
            newAccountingImpl: NEW_ACCOUNTING_IMPL,
            newAccountingOracleImpl: NEW_ACCOUNTING_ORACLE_IMPL,
            newStakingRouterImpl: NEW_STAKING_ROUTER_IMPL,
            newWithdrawalVaultImpl: NEW_WITHDRAWAL_VAULT_IMPL,
            newValidatorsExitBusOracleImpl: NEW_VALIDATORS_EXIT_BUS_ORACLE_IMPL,
            newOracleReportSanityChecker: NEW_ORACLE_REPORT_SANITY_CHECKER,
            newDepositSecurityModule: NEW_DEPOSIT_SECURITY_MODULE,
            consolidationBusImpl: CONSOLIDATION_BUS_IMPL,
            consolidationMigratorImpl: CONSOLIDATION_MIGRATOR_IMPL,
            topUpGatewayImpl: TOP_UP_GATEWAY_IMPL,
            // contracts
            accounting: ACCOUNTING,
            accountingOracle: ACCOUNTING_ORACLE,
            withdrawalVault: WITHDRAWAL_VAULT,
            consolidationGateway: CONSOLIDATION_GATEWAY,
            consolidationBus: CONSOLIDATION_BUS,
            consolidationMigrator: CONSOLIDATION_MIGRATOR,
            topUpGateway: TOP_UP_GATEWAY,
            // params
            lidoDepositsReserveTarget: LIDO_DEPOSITS_RESERVE_TARGET,
            consolidationGatewayGateSeal: CONSOLIDATION_GATEWAY_GATE_SEAL,
            consolidationBusExecutor: CONSOLIDATION_BUS_EXECUTOR,
            consolidationManagerCommittee: CONSOLIDATION_MANAGER_COMMITTEE,
            topUpGatewayDepositor: TOP_UP_GATEWAY_DEPOSITOR
        });
    }

    function getCSMUpgradeConfig() external view returns (CSMUpgradeConfig memory) {
        return CSMUpgradeConfig({
            csm: CSM,
            csmImpl: CSM_IMPL,
            parametersRegistry: CSM_PARAMETERS_REGISTRY,
            parametersRegistryImpl: CSM_PARAMETERS_REGISTRY_IMPL,
            feeOracle: CSM_FEE_ORACLE,
            feeOracleImpl: CSM_FEE_ORACLE_IMPL,
            feeOracleConsensusVersion: CSM_FEE_ORACLE_CONSENSUS_VERSION,
            vettedGate: CSM_VETTED_GATE,
            vettedGateImpl: CSM_VETTED_GATE_IMPL,
            accounting: CSM_ACCOUNTING,
            accountingImpl: CSM_ACCOUNTING_IMPL,
            feeDistributor: CSM_FEE_DISTRIBUTOR,
            feeDistributorImpl: CSM_FEE_DISTRIBUTOR_IMPL,
            exitPenalties: CSM_EXIT_PENALTIES,
            exitPenaltiesImpl: CSM_EXIT_PENALTIES_IMPL,
            strikes: CSM_STRIKES,
            strikesImpl: CSM_STRIKES_IMPL,
            oldPermissionlessGate: CSM_OLD_PERMISSIONLESS_GATE,
            verifier: CSM_VERIFIER,
            verifierV3: CSM_VERIFIER_V3,
            permissionlessGate: CSM_PERMISSIONLESS_GATE,
            ejector: CSM_EJECTOR,
            identifiedCommunityStakersGateManager: CSM_IDENTIFIED_COMMUNITY_STAKERS_GATE_MANAGER,
            gateSeal: CSM_GATE_SEAL,
            gateSealV3: CSM_GATE_SEAL_V3,
            generalDelayedPenaltyReporter: CSM_GENERAL_DELAYED_PENALTY_REPORTER,
            penaltiesManager: CSM_PENALTIES_MANAGER
        });
    }

    function getCuratedModuleConfig() external view returns (CuratedModuleConfig memory) {
        return CuratedModuleConfig({
            module: CURATED_MODULE,
            accounting: CURATED_ACCOUNTING,
            ejector: CURATED_EJECTOR,
            hashConsensus: CURATED_HASH_CONSENSUS,
            moduleName: _curatedModuleName,
            stakeShareLimit: CURATED_STAKE_SHARE_LIMIT,
            priorityExitShareThreshold: CURATED_PRIORITY_EXIT_SHARE_THRESHOLD,
            stakingModuleFee: CURATED_STAKING_MODULE_FEE,
            treasuryFee: CURATED_TREASURY_FEE,
            maxDepositsPerBlock: CURATED_MAX_DEPOSITS_PER_BLOCK,
            minDepositBlockDistance: CURATED_MIN_DEPOSIT_BLOCK_DISTANCE,
            hashConsensusInitialEpoch: CURATED_HASH_CONSENSUS_INITIAL_EPOCH,
            metaRegistry: CURATED_META_REGISTRY,
            professionalOperatorGate: CURATED_PROFESSIONAL_OPERATOR_GATE,
            professionalTrustedOperatorGate: CURATED_PROFESSIONAL_TRUSTED_OPERATOR_GATE,
            publicGoodOperatorGate: CURATED_PUBLIC_GOOD_OPERATOR_GATE,
            decentralizationOperatorGate: CURATED_DECENTRALIZATION_OPERATOR_GATE,
            extraEffortOperatorGate: CURATED_EXTRA_EFFORT_OPERATOR_GATE,
            intraOperatorDVTClusterGate: CURATED_INTRA_OPERATOR_DVT_CLUSTER_GATE
        });
    }

    error NewAndOldLocatorImplementationsMustBeDifferent();
    error OldAndNewOracleReportSanityCheckerMustBeDifferent();
    error OldAndNewDepositSecurityModuleMustBeDifferent();
    error StakingModuleNotFound(string moduleName);
}
