// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {Bytes32String} from "contracts/common/lib/Bytes32String.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IUpgradeConfig} from "./interfaces/IUpgradeConfig.sol";
import {IDualGovernance} from "./interfaces/IDualGovernance.sol";
import {
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
    address public immutable CIRCUIT_BREAKER;
    address public immutable CIRCUIT_BREAKER_COMMITTEE;
    address public immutable BURNER;

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

    //
    // -------- Upgrade parameters --------
    //
    uint256 internal immutable LIDO_DEPOSITS_RESERVE_TARGET;
    address internal immutable CONSOLIDATION_COMMITTEE;
    address internal immutable TOP_UP_GATEWAY_DEPOSITOR;
    uint256 internal immutable TW_MAX_EXIT_REQUESTS_LIMIT;
    uint256 internal immutable TW_EXITS_PER_FRAME;
    uint256 internal immutable TW_FRAME_DURATION_IN_SEC;
    uint256 internal immutable AO_CONSENSUS_VERSION;
    uint256 internal immutable VEBO_MAX_VALIDATORS_PER_REPORT;
    uint256 internal immutable VEBO_MAX_EXIT_BALANCE_ETH;
    uint256 internal immutable VEBO_BALANCE_PER_FRAME_ETH;
    uint256 internal immutable VEBO_FRAME_DURATION_IN_SEC;
    uint256 internal immutable VEBO_CONSENSUS_VERSION;
    uint256 internal immutable MAX_TOP_UP_PER_BLOCK_GWEI;

    // -------- EasyTrack addresses --------
    //
    address internal immutable EASY_TRACK;
    address internal immutable EASY_TRACK_EVM_SCRIPT_EXECUTOR;
    // ETF = EasyTrack Factory
    // SR Factories
    address internal immutable ETF_NEW_UPDATE_STAKING_MODULE_SHARE_LIMITS;
    address internal immutable ETF_NEW_ALLOW_CONSOLIDATION_PAIR;
    // CSM Factories
    address internal immutable ETF_NEW_SET_MERKLE_GATE_TREE_FOR_CSM;
    address internal immutable ETF_NEW_REPORT_WITHDRAWALS_FOR_SLASHED_VALIDATORS_FOR_CSM;
    address internal immutable ETF_NEW_SETTLE_GENERAL_DELAYED_PENALTY_FOR_CSM;
    // CM Factories
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
    address internal immutable CSM_IDENTIFIED_DVT_CLUSTER_GATE;
    address internal immutable CSM_IDENTIFIED_DVT_CLUSTER_CURVE_SETUP;
    uint256 internal immutable CSM_IDENTIFIED_DVT_CLUSTER_BOND_CURVE_ID;
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
    address internal immutable CSM_OLD_VERIFIER;
    address internal immutable CSM_NEW_VERIFIER;
    address internal immutable CSM_NEW_PERMISSIONLESS_GATE;
    address internal immutable CSM_OLD_EJECTOR;
    address internal immutable CSM_EJECTOR;
    address internal immutable CSM_COMMITTEE;

    // CMv2
    address internal immutable CURATED_MODULE;
    address[] internal CURATED_GATES;
    address internal immutable CURATED_PARAMETERS_REGISTRY;
    address internal immutable CURATED_ACCOUNTING;
    address internal immutable CURATED_VERIFIER;
    address internal immutable CURATED_CIRCUIT_BREAKER_PAUSER;
    address internal immutable CURATED_FEE_DISTRIBUTOR;
    address internal immutable CURATED_FEE_ORACLE;
    address internal immutable CURATED_STRIKES;
    address internal immutable CURATED_EJECTOR;
    address internal immutable CURATED_HASH_CONSENSUS;
    bytes32 internal immutable CURATED_MODULE_NAME;
    uint256 internal immutable CURATED_STAKE_SHARE_LIMIT;
    uint256 internal immutable CURATED_PRIORITY_EXIT_SHARE_THRESHOLD;
    uint256 internal immutable CURATED_STAKING_MODULE_FEE;
    uint256 internal immutable CURATED_TREASURY_FEE;
    uint256 internal immutable CURATED_MAX_DEPOSITS_PER_BLOCK;
    uint256 internal immutable CURATED_MIN_DEPOSIT_BLOCK_DISTANCE;
    uint256 internal immutable CURATED_FEE_ORACLE_CONSENSUS_VERSION;
    uint256 internal immutable CURATED_HASH_CONSENSUS_INITIAL_EPOCH;
    address internal immutable CURATED_META_REGISTRY;

    constructor(UpgradeParameters memory params) {
        // Core upgrade params
        CoreUpgradeParams memory coreUpgradeParams = params.coreUpgrade;

        // Save passed parameters
        AGENT = _nonZeroAddress(params.agent);
        KERNEL = _nonZeroAddress(IAragonApp(AGENT).kernel());
        ACL = _nonZeroAddress(IAragonKernel(KERNEL).acl());

        VOTING = _nonZeroAddress(params.voting);
        DUAL_GOVERNANCE = _nonZeroAddress(params.dualGovernance);
        RESEAL_MANAGER = _nonZeroAddress(IDualGovernance(DUAL_GOVERNANCE).getResealManager());
        CIRCUIT_BREAKER = _nonZeroAddress(params.circuitBreaker);
        CIRCUIT_BREAKER_COMMITTEE = _nonZeroAddress(params.circuitBreakerCommittee);

        EASY_TRACK = _nonZeroAddress(params.easyTrack);
        EASY_TRACK_EVM_SCRIPT_EXECUTOR = _nonZeroAddress(IEasyTrack(params.easyTrack).evmScriptExecutor());

        NEW_LOCATOR_IMPL = _nonZeroAddress(coreUpgradeParams.newLocatorImpl);
        NEW_LIDO_IMPL = _nonZeroAddress(coreUpgradeParams.newLidoImpl);
        NEW_ACCOUNTING_ORACLE_IMPL = _nonZeroAddress(coreUpgradeParams.newAccountingOracleImpl);
        NEW_STAKING_ROUTER_IMPL = _nonZeroAddress(coreUpgradeParams.newStakingRouterImpl);
        NEW_ACCOUNTING_IMPL = _nonZeroAddress(coreUpgradeParams.newAccountingImpl);
        NEW_WITHDRAWAL_VAULT_IMPL = _nonZeroAddress(coreUpgradeParams.newWithdrawalVaultImpl);
        NEW_VALIDATORS_EXIT_BUS_ORACLE_IMPL = _nonZeroAddress(coreUpgradeParams.newValidatorsExitBusOracleImpl);
        CONSOLIDATION_BUS_IMPL = _nonZeroAddress(coreUpgradeParams.consolidationBusImpl);
        CONSOLIDATION_MIGRATOR_IMPL = _nonZeroAddress(coreUpgradeParams.consolidationMigratorImpl);
        TOP_UP_GATEWAY_IMPL = _nonZeroAddress(coreUpgradeParams.topUpGatewayImpl);

        CONSOLIDATION_BUS = _nonZeroAddress(coreUpgradeParams.consolidationBus);
        CONSOLIDATION_MIGRATOR = _nonZeroAddress(coreUpgradeParams.consolidationMigrator);

        LIDO_DEPOSITS_RESERVE_TARGET = coreUpgradeParams.lidoDepositsReserveTarget;
        CONSOLIDATION_COMMITTEE = _nonZeroAddress(coreUpgradeParams.consolidationCommittee);
        TOP_UP_GATEWAY_DEPOSITOR = _nonZeroAddress(coreUpgradeParams.topUpGatewayDepositor);
        TW_MAX_EXIT_REQUESTS_LIMIT = coreUpgradeParams.twMaxExitRequestsLimit;
        TW_EXITS_PER_FRAME = coreUpgradeParams.twExitsPerFrame;
        TW_FRAME_DURATION_IN_SEC = coreUpgradeParams.twFrameDurationInSec;

        AO_CONSENSUS_VERSION = coreUpgradeParams.aoConsensusVersion;
        VEBO_MAX_VALIDATORS_PER_REPORT = coreUpgradeParams.veboMaxValidatorsPerReport;
        VEBO_MAX_EXIT_BALANCE_ETH = coreUpgradeParams.veboMaxExitBalanceEth;
        VEBO_BALANCE_PER_FRAME_ETH = coreUpgradeParams.veboBalancePerFrameEth;
        VEBO_FRAME_DURATION_IN_SEC = coreUpgradeParams.veboFrameDurationInSec;
        VEBO_CONSENSUS_VERSION = coreUpgradeParams.veboConsensusVersion;
        MAX_TOP_UP_PER_BLOCK_GWEI = coreUpgradeParams.maxTopUpPerBlockGwei;

        // EasyTrack new factories
        EasyTrackNewFactories memory newFactories = params.newFactories;
        ETF_NEW_UPDATE_STAKING_MODULE_SHARE_LIMITS = _nonZeroAddress(newFactories.UpdateStakingModuleShareLimits);
        ETF_NEW_ALLOW_CONSOLIDATION_PAIR = _nonZeroAddress(newFactories.AllowConsolidationPair);
        ETF_NEW_SET_MERKLE_GATE_TREE_FOR_CSM = _nonZeroAddress(newFactories.SetMerkleGateTreeForCSM);
        ETF_NEW_REPORT_WITHDRAWALS_FOR_SLASHED_VALIDATORS_FOR_CSM =
            _nonZeroAddress(newFactories.ReportWithdrawalsForSlashedValidatorsForCSM);
        ETF_NEW_SETTLE_GENERAL_DELAYED_PENALTY_FOR_CSM = _nonZeroAddress(newFactories.SettleGeneralDelayedPenaltyForCSM);
        ETF_NEW_SET_MERKLE_GATE_TREE_FOR_CM = _nonZeroAddress(newFactories.SetMerkleGateTreeForCM);
        ETF_NEW_REPORT_WITHDRAWALS_FOR_SLASHED_VALIDATORS_FOR_CM =
            _nonZeroAddress(newFactories.ReportWithdrawalsForSlashedValidatorsForCM);
        ETF_NEW_SETTLE_GENERAL_DELAYED_PENALTY_FOR_CM = _nonZeroAddress(newFactories.SettleGeneralDelayedPenaltyForCM);
        ETF_NEW_CREATE_OR_UPDATE_OPERATOR_GROUP = _nonZeroAddress(newFactories.CreateOrUpdateOperatorGroupForCM);

        // EasyTrack old factories
        EasyTrackOldFactories memory oldFactories = params.oldFactories;
        ETF_OLD_SETTLE_EL_STEALING_PENALTY = _nonZeroAddress(oldFactories.CSMSettleElStealingPenalty);
        ETF_OLD_CSM_SET_VETTED_GATE_TREE = _nonZeroAddress(oldFactories.CSMSetVettedGateTree);

        // Discover via locator
        LOCATOR = _nonZeroAddress(params.locator);
        ILidoLocator oldLocator = ILidoLocator(params.locator);
        OLD_DEPOSIT_SECURITY_MODULE = _nonZeroAddress(oldLocator.depositSecurityModule());

        ILidoLocator locator = ILidoLocator(coreUpgradeParams.newLocatorImpl);
        LIDO = _nonZeroAddress(locator.lido());
        LIDO_APP_ID = IAragonApp(LIDO).appId();

        ACCOUNTING_ORACLE = _nonZeroAddress(locator.accountingOracle());
        ACCOUNTING = _nonZeroAddress(locator.accounting());
        STAKING_ROUTER = _nonZeroAddress(locator.stakingRouter());
        VALIDATORS_EXIT_BUS_ORACLE = _nonZeroAddress(locator.validatorsExitBusOracle());
        WITHDRAWAL_VAULT = _nonZeroAddress(locator.withdrawalVault());
        TOP_UP_GATEWAY = _nonZeroAddress(locator.topUpGateway());
        BURNER = _nonZeroAddress(locator.burner());
        TRIGGERABLE_WITHDRAWALS_GATEWAY = _nonZeroAddress(locator.triggerableWithdrawalsGateway());
        CONSOLIDATION_GATEWAY = _nonZeroAddress(locator.consolidationGateway());
        NEW_ORACLE_REPORT_SANITY_CHECKER = _nonZeroAddress(locator.oracleReportSanityChecker());
        NEW_DEPOSIT_SECURITY_MODULE = _nonZeroAddress(locator.depositSecurityModule());

        /// CSMv3
        CSMUpgradeParams memory csmUpgradeParams = params.csmUpgrade;

        CSM = _nonZeroAddress(csmUpgradeParams.csmProxy);
        CSM_IMPL = _nonZeroAddress(csmUpgradeParams.csmImpl);
        CSM_PARAMETERS_REGISTRY_IMPL = _nonZeroAddress(csmUpgradeParams.parametersRegistryImpl);
        CSM_FEE_ORACLE_IMPL = _nonZeroAddress(csmUpgradeParams.feeOracleImpl);
        CSM_FEE_ORACLE_CONSENSUS_VERSION = csmUpgradeParams.feeOracleConsensusVersion;
        CSM_VETTED_GATE = _nonZeroAddress(csmUpgradeParams.vettedGateProxy);
        CSM_IDENTIFIED_DVT_CLUSTER_GATE = _nonZeroAddress(csmUpgradeParams.identifiedDVTClusterGate);
        CSM_IDENTIFIED_DVT_CLUSTER_CURVE_SETUP = _nonZeroAddress(csmUpgradeParams.identifiedDVTClusterCurveSetup);
        CSM_IDENTIFIED_DVT_CLUSTER_BOND_CURVE_ID = csmUpgradeParams.identifiedDVTClusterBondCurveId;
        CSM_VETTED_GATE_IMPL = _nonZeroAddress(csmUpgradeParams.vettedGateImpl);
        CSM_ACCOUNTING_IMPL = _nonZeroAddress(csmUpgradeParams.accountingImpl);
        CSM_FEE_DISTRIBUTOR_IMPL = _nonZeroAddress(csmUpgradeParams.feeDistributorImpl);
        CSM_EXIT_PENALTIES_IMPL = _nonZeroAddress(csmUpgradeParams.exitPenaltiesImpl);
        CSM_STRIKES_IMPL = _nonZeroAddress(csmUpgradeParams.strikesImpl);
        CSM_OLD_PERMISSIONLESS_GATE = _nonZeroAddress(csmUpgradeParams.oldPermissionlessGate);
        CSM_OLD_VERIFIER = _nonZeroAddress(csmUpgradeParams.oldVerifier);
        CSM_NEW_VERIFIER = _nonZeroAddress(csmUpgradeParams.newVerifier);
        CSM_NEW_PERMISSIONLESS_GATE = _nonZeroAddress(csmUpgradeParams.newPermissionlessGate);
        CSM_EJECTOR = _nonZeroAddress(csmUpgradeParams.newEjector);
        CSM_COMMITTEE = _nonZeroAddress(csmUpgradeParams.csmCommittee);

        IBaseModuleV3 csm = IBaseModuleV3(CSM);
        CSM_PARAMETERS_REGISTRY = _nonZeroAddress(csm.PARAMETERS_REGISTRY());
        CSM_ACCOUNTING = _nonZeroAddress(csm.ACCOUNTING());
        CSM_EXIT_PENALTIES = _nonZeroAddress(csm.EXIT_PENALTIES());
        CSM_FEE_DISTRIBUTOR = _nonZeroAddress(csm.FEE_DISTRIBUTOR());
        CSM_FEE_ORACLE = _nonZeroAddress(IFeeDistributorV3(CSM_FEE_DISTRIBUTOR).ORACLE());
        CSM_STRIKES = _nonZeroAddress(IFeeOracleV3(CSM_FEE_ORACLE).STRIKES());
        CSM_OLD_EJECTOR = _nonZeroAddress(IValidatorStrikesV3(CSM_STRIKES).ejector());

        // CMv2
        CuratedModuleParams memory curatedModuleParams = params.curatedModule;

        CURATED_MODULE = _nonZeroAddress(curatedModuleParams.module);
        for (uint256 i = 0; i < curatedModuleParams.curatedGates.length; ++i) {
            CURATED_GATES.push(_nonZeroAddress(curatedModuleParams.curatedGates[i]));
        }
        CURATED_MODULE_NAME = Bytes32String.toBytes32(curatedModuleParams.moduleName);
        CURATED_STAKE_SHARE_LIMIT = curatedModuleParams.stakeShareLimit;
        CURATED_PRIORITY_EXIT_SHARE_THRESHOLD = curatedModuleParams.priorityExitShareThreshold;
        CURATED_STAKING_MODULE_FEE = curatedModuleParams.stakingModuleFee;
        CURATED_TREASURY_FEE = curatedModuleParams.treasuryFee;
        CURATED_MAX_DEPOSITS_PER_BLOCK = curatedModuleParams.maxDepositsPerBlock;
        CURATED_MIN_DEPOSIT_BLOCK_DISTANCE = curatedModuleParams.minDepositBlockDistance;
        CURATED_FEE_ORACLE_CONSENSUS_VERSION = curatedModuleParams.feeOracleConsensusVersion;
        CURATED_HASH_CONSENSUS_INITIAL_EPOCH = curatedModuleParams.hashConsensusInitialEpoch;
        CURATED_VERIFIER = _nonZeroAddress(curatedModuleParams.verifier);
        CURATED_CIRCUIT_BREAKER_PAUSER = _nonZeroAddress(curatedModuleParams.circuitBreakerPauser);

        ICuratedModule curatedModule = ICuratedModule(CURATED_MODULE);
        CURATED_META_REGISTRY = _nonZeroAddress(curatedModule.META_REGISTRY());
        CURATED_PARAMETERS_REGISTRY = _nonZeroAddress(curatedModule.PARAMETERS_REGISTRY());
        CURATED_ACCOUNTING = _nonZeroAddress(curatedModule.ACCOUNTING());
        CURATED_FEE_DISTRIBUTOR = _nonZeroAddress(curatedModule.FEE_DISTRIBUTOR());
        CURATED_FEE_ORACLE = _nonZeroAddress(IFeeDistributorV3(CURATED_FEE_DISTRIBUTOR).ORACLE());
        CURATED_HASH_CONSENSUS = _nonZeroAddress(IFeeOracleV3(CURATED_FEE_ORACLE).getConsensusContract());
        CURATED_STRIKES = _nonZeroAddress(IFeeOracleV3(CURATED_FEE_ORACLE).STRIKES());
        CURATED_EJECTOR = _nonZeroAddress(IValidatorStrikesV3(CURATED_STRIKES).ejector());
    }

    /**
     * @notice Reverts with {ZeroAddress} if `addr` is the zero address, otherwise returns it unchanged.
     * @dev Helper used to validate every address assigned in the constructor.
     */
    function _nonZeroAddress(address addr) internal pure returns (address) {
        if (addr == address(0)) revert ZeroAddress();
        return addr;
    }

    function getGlobalConfig() external view returns (GlobalConfig memory) {
        return GlobalConfig({
            agent: AGENT,
            lido: LIDO,
            burner: BURNER,
            resealManager: RESEAL_MANAGER,
            circuitBreaker: CIRCUIT_BREAKER,
            circuitBreakerCommittee: CIRCUIT_BREAKER_COMMITTEE,
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
                SetMerkleGateTreeForCSM: ETF_NEW_SET_MERKLE_GATE_TREE_FOR_CSM,
                ReportWithdrawalsForSlashedValidatorsForCSM: ETF_NEW_REPORT_WITHDRAWALS_FOR_SLASHED_VALIDATORS_FOR_CSM,
                SettleGeneralDelayedPenaltyForCSM: ETF_NEW_SETTLE_GENERAL_DELAYED_PENALTY_FOR_CSM,
                SetMerkleGateTreeForCM: ETF_NEW_SET_MERKLE_GATE_TREE_FOR_CM,
                ReportWithdrawalsForSlashedValidatorsForCM: ETF_NEW_REPORT_WITHDRAWALS_FOR_SLASHED_VALIDATORS_FOR_CM,
                SettleGeneralDelayedPenaltyForCM: ETF_NEW_SETTLE_GENERAL_DELAYED_PENALTY_FOR_CM,
                CreateOrUpdateOperatorGroupForCM: ETF_NEW_CREATE_OR_UPDATE_OPERATOR_GROUP
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
            validatorsExitBusOracle: VALIDATORS_EXIT_BUS_ORACLE,
            withdrawalVault: WITHDRAWAL_VAULT,
            consolidationGateway: CONSOLIDATION_GATEWAY,
            consolidationBus: CONSOLIDATION_BUS,
            consolidationMigrator: CONSOLIDATION_MIGRATOR,
            topUpGateway: TOP_UP_GATEWAY,
            // params
            lidoDepositsReserveTarget: LIDO_DEPOSITS_RESERVE_TARGET,
            consolidationCommittee: CONSOLIDATION_COMMITTEE,
            topUpGatewayDepositor: TOP_UP_GATEWAY_DEPOSITOR,
            // twGateway limits
            twMaxExitRequestsLimit: TW_MAX_EXIT_REQUESTS_LIMIT,
            twExitsPerFrame: TW_EXITS_PER_FRAME,
            twFrameDurationInSec: TW_FRAME_DURATION_IN_SEC,
            // oracles parameters
            aoConsensusVersion: AO_CONSENSUS_VERSION,
            veboMaxValidatorsPerReport: VEBO_MAX_VALIDATORS_PER_REPORT,
            veboMaxExitBalanceEth: VEBO_MAX_EXIT_BALANCE_ETH,
            veboBalancePerFrameEth: VEBO_BALANCE_PER_FRAME_ETH,
            veboFrameDurationInSec: VEBO_FRAME_DURATION_IN_SEC,
            veboConsensusVersion: VEBO_CONSENSUS_VERSION,
            maxTopUpPerBlockGwei: MAX_TOP_UP_PER_BLOCK_GWEI
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
            identifiedDVTClusterGate: CSM_IDENTIFIED_DVT_CLUSTER_GATE,
            identifiedDVTClusterCurveSetup: CSM_IDENTIFIED_DVT_CLUSTER_CURVE_SETUP,
            identifiedDVTClusterBondCurveId: CSM_IDENTIFIED_DVT_CLUSTER_BOND_CURVE_ID,
            accounting: CSM_ACCOUNTING,
            accountingImpl: CSM_ACCOUNTING_IMPL,
            feeDistributor: CSM_FEE_DISTRIBUTOR,
            feeDistributorImpl: CSM_FEE_DISTRIBUTOR_IMPL,
            exitPenalties: CSM_EXIT_PENALTIES,
            exitPenaltiesImpl: CSM_EXIT_PENALTIES_IMPL,
            strikes: CSM_STRIKES,
            strikesImpl: CSM_STRIKES_IMPL,
            oldPermissionlessGate: CSM_OLD_PERMISSIONLESS_GATE,
            newPermissionlessGate: CSM_NEW_PERMISSIONLESS_GATE,
            oldVerifier: CSM_OLD_VERIFIER,
            newVerifier: CSM_NEW_VERIFIER,
            oldEjector: CSM_OLD_EJECTOR,
            newEjector: CSM_EJECTOR,
            csmCommittee: CSM_COMMITTEE
        });
    }

    function getCuratedModuleConfig() external view returns (CuratedModuleConfig memory) {
        return CuratedModuleConfig({
            module: CURATED_MODULE,
            curatedGates: CURATED_GATES,
            parametersRegistry: CURATED_PARAMETERS_REGISTRY,
            accounting: CURATED_ACCOUNTING,
            ejector: CURATED_EJECTOR,
            verifier: CURATED_VERIFIER,
            circuitBreakerPauser: CURATED_CIRCUIT_BREAKER_PAUSER,
            feeDistributor: CURATED_FEE_DISTRIBUTOR,
            feeOracle: CURATED_FEE_ORACLE,
            hashConsensus: CURATED_HASH_CONSENSUS,
            strikes: CURATED_STRIKES,
            moduleName: Bytes32String.toString(CURATED_MODULE_NAME),
            stakeShareLimit: CURATED_STAKE_SHARE_LIMIT,
            priorityExitShareThreshold: CURATED_PRIORITY_EXIT_SHARE_THRESHOLD,
            stakingModuleFee: CURATED_STAKING_MODULE_FEE,
            treasuryFee: CURATED_TREASURY_FEE,
            maxDepositsPerBlock: CURATED_MAX_DEPOSITS_PER_BLOCK,
            minDepositBlockDistance: CURATED_MIN_DEPOSIT_BLOCK_DISTANCE,
            feeOracleConsensusVersion: CURATED_FEE_ORACLE_CONSENSUS_VERSION,
            hashConsensusInitialEpoch: CURATED_HASH_CONSENSUS_INITIAL_EPOCH,
            metaRegistry: CURATED_META_REGISTRY
        });
    }

    error ZeroAddress();
}
