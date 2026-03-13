// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {
    IUpgradeConfig,
    UpgradeParameters,
    CoreUpgradeParams,
    CSMUpgradeParams,
    CuratedModuleParams,
    GeneralConfig,
    CoreUpgradeConfig,
    CuratedModuleConfig,
    CSMUpgradeConfig,
    IKernel,
    IAragonApp,
    ILidoLocatorV3,
    IEasyTrack,
    IBaseModuleV3,
    IFeeOracleV3,
    IFeeDistributorV3,
    IValidatorStrikesV3,
    IAccountingV3
} from "./UpgradeTypes.sol";

/**
 * @title UpgradeConfig
 * @notice Stores immutable addresses and parameters required for the upgrade process.
 * This contract centralizes address/param management for UpgradeTemplate and UpgradeVoteScript.
 */
contract UpgradeConfig is IUpgradeConfig {
    // Role constants for CSM
    bytes32 public constant REPORT_EL_REWARDS_STEALING_PENALTY_ROLE =
        keccak256("REPORT_EL_REWARDS_STEALING_PENALTY_ROLE");
    bytes32 public constant SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE =
        keccak256("SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE");
    bytes32 public constant START_REFERRAL_SEASON_ROLE = keccak256("START_REFERRAL_SEASON_ROLE");
    bytes32 public constant END_REFERRAL_SEASON_ROLE = keccak256("END_REFERRAL_SEASON_ROLE");

    // string public constant CURATED_MODULE_NAME = "curated-onchain-v1";
    // string public constant SIMPLE_DVT_MODULE_NAME = "SimpleDVT";
    // string public constant CSM_MODULE_NAME = "Community Staking";

    //
    // -------- public fields --------
    //
    address public immutable LOCATOR;
    address public immutable AGENT;
    address public immutable VOTING;
    address public immutable DUAL_GOVERNANCE;

    //
    // -------- Pre-upgrade old contracts --------
    //
    address internal immutable OLD_LOCATOR_IMPL;
    address internal immutable OLD_LIDO_IMPL;
    address internal immutable OLD_ACCOUNTING_ORACLE_IMPL;
    address internal immutable OLD_STAKING_ROUTER_IMPL;
    address internal immutable OLD_ORACLE_REPORT_SANITY_CHECKER;
    address internal immutable OLD_DEPOSIT_SECURITY_MODULE;
    address internal immutable OLD_VALIDATORS_EXIT_BUS_ORACLE_IMPL;
    address internal immutable OLD_ACCOUNTING_IMPL;
    address internal immutable OLD_WITHDRAWAL_VAULT;

    //
    // -------- Upgraded contracts --------
    //
    address internal immutable NEW_LOCATOR_IMPL;
    address internal immutable NEW_LIDO_IMPL;
    address internal immutable NEW_STAKING_ROUTER_IMPL;
    address internal immutable NEW_ACCOUNTING_ORACLE_IMPL;
    address internal immutable NEW_ORACLE_REPORT_SANITY_CHECKER;
    address internal immutable NEW_DEPOSIT_SECURITY_MODULE;
    address internal immutable NEW_VALIDATORS_EXIT_BUS_ORACLE_IMPL;
    address internal immutable NEW_WITHDRAWAL_VAULT_IMPL;
    address internal immutable NEW_ACCOUNTING_IMPL;

    address internal immutable TOP_UP_GATEWAY_IMPL;
    // address internal immutable CONSOLIDATION_GATEWAY_IMPL;

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
    address internal immutable VALIDATOR_EXIT_DELAY_VERIFIER;
    address internal immutable ORACLE_REPORT_SANITY_CHECKER;
    address internal immutable DEPOSIT_SECURITY_MODULE;
    // todo

    //
    // -------- EasyTrack addresses --------
    //

    address internal immutable EASY_TRACK;
    address internal immutable EASY_TRACK_EVM_SCRIPT_EXECUTOR;
    // ETF = EasyTrack Factory
    address internal immutable ETF_UPDATE_STAKING_MODULE_SHARE_LIMITS;
    /// ...

    //
    // -------- Unchanged contracts --------
    //
    address internal immutable RESEAL_MANAGER;
    address internal immutable BURNER;

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

    // UpgradeParameters public upgradeParams;

    constructor(UpgradeParameters memory params) {
        // Core upgrade params
        CoreUpgradeParams memory coreUpgradeParams = params.coreUpgrade;

        if (coreUpgradeParams.newLocatorImpl == coreUpgradeParams.oldLocatorImpl) {
            revert NewAndOldLocatorImplementationsMustBeDifferent();
        }
        // todo
        // if (coreUpgradeParams.oldOracleReportSanityChecker == coreUpgradeParams.newOracleReportSanityChecker) {
        //     revert OldAndNewOracleReportSanityCheckerMustBeDifferent();
        // }
        // if (coreUpgradeParams.oldDepositSecurityModule == coreUpgradeParams.newDepositSecurityModule) {
        //     revert OldAndNewDepositSecurityModuleMustBeDifferent();
        // }

        // Save passed parameters
        AGENT = params.agent;
        KERNEL = IAragonApp(AGENT).kernel();
        ACL = IKernel(KERNEL).acl();

        VOTING = params.voting;
        DUAL_GOVERNANCE = params.dualGovernance;
        RESEAL_MANAGER = params.resealManager;

        EASY_TRACK = params.easyTrack;
        EASY_TRACK_EVM_SCRIPT_EXECUTOR = IEasyTrack(params.easyTrack).evmScriptExecutor();

        OLD_LOCATOR_IMPL = coreUpgradeParams.oldLocatorImpl;
        OLD_LIDO_IMPL = coreUpgradeParams.oldLidoImpl;
        OLD_ACCOUNTING_ORACLE_IMPL = coreUpgradeParams.oldAccountingOracleImpl;
        OLD_STAKING_ROUTER_IMPL = coreUpgradeParams.oldStakingRouterImpl;

        NEW_LOCATOR_IMPL = coreUpgradeParams.newLocatorImpl;
        NEW_LIDO_IMPL = coreUpgradeParams.newLidoImpl;
        NEW_ACCOUNTING_ORACLE_IMPL = coreUpgradeParams.newAccountingOracleImpl;
        NEW_STAKING_ROUTER_IMPL = coreUpgradeParams.newStakingRouterImpl;

        ETF_UPDATE_STAKING_MODULE_SHARE_LIMITS = coreUpgradeParams.etfUpdateStakingModuleShareLimits;

        // todo add CSM etf

        // Discover via locator
        LOCATOR = params.locator;
        ILidoLocatorV3 locator = ILidoLocatorV3(coreUpgradeParams.newLocatorImpl);

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
        // function validatorExitDelayVerifier() external view returns (address);
        // function consolidationGateway() external view returns (address);

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
        CURATED_HASH_CONSENSUS = curatedModuleParams.hashConsensus;
        /// @dev save in storage
        _curatedModuleName = curatedModuleParams.moduleName;
        CURATED_STAKE_SHARE_LIMIT = curatedModuleParams.stakeShareLimit;
        CURATED_PRIORITY_EXIT_SHARE_THRESHOLD = curatedModuleParams.priorityExitShareThreshold;
        CURATED_STAKING_MODULE_FEE = curatedModuleParams.stakingModuleFee;
        CURATED_TREASURY_FEE = curatedModuleParams.treasuryFee;
        CURATED_MAX_DEPOSITS_PER_BLOCK = curatedModuleParams.maxDepositsPerBlock;
        CURATED_MIN_DEPOSIT_BLOCK_DISTANCE = curatedModuleParams.minDepositBlockDistance;
        CURATED_HASH_CONSENSUS_INITIAL_EPOCH = curatedModuleParams.hashConsensusInitialEpoch;

        CURATED_ACCOUNTING = IBaseModuleV3(CURATED_MODULE).ACCOUNTING();
        address curatedFeeDistributor = IAccountingV3(CURATED_ACCOUNTING).FEE_DISTRIBUTOR();
        address curatedFeeOracle = IFeeDistributorV3(curatedFeeDistributor).ORACLE();
        address curatedStrikes = IFeeOracleV3(curatedFeeOracle).STRIKES();
        CURATED_EJECTOR = IValidatorStrikesV3(curatedStrikes).ejector();
    }

    function getGeneralConfig() external view returns (GeneralConfig memory) {
        return _getGeneralConfig();
    }

    function getCoreUpgradeConfig() external view returns (CoreUpgradeConfig memory) {
        return _getCoreUpgradeConfig();
    }

    function getCSMUpgradeConfig() external view returns (CSMUpgradeConfig memory) {
        return _getCSMUpgradeConfig();
    }

    function getCuratedModuleConfig() external view returns (CuratedModuleConfig memory) {
        return _getCuratedModuleConfig();
    }

    function _getGeneralConfig() internal view returns (GeneralConfig memory) {
        return GeneralConfig({
            agent: AGENT,
            burner: BURNER,
            resealManager: RESEAL_MANAGER,
            easyTrack: EASY_TRACK,
            easyTrackEVMScriptExecutor: EASY_TRACK_EVM_SCRIPT_EXECUTOR,
            stakingRouter: STAKING_ROUTER,
            triggerableWithdrawalsGateway: TRIGGERABLE_WITHDRAWALS_GATEWAY,
            accountingOracle: ACCOUNTING_ORACLE
        });
    }

    function _getCoreUpgradeConfig() internal view returns (CoreUpgradeConfig memory) {
        return CoreUpgradeConfig({
            kernel: KERNEL,
            acl: ACL,
            lidoAppId: LIDO_APP_ID,
            locator: LOCATOR,
            oldLocatorImpl: OLD_LOCATOR_IMPL,
            oldLidoImpl: OLD_LIDO_IMPL,
            oldAccountingOracleImpl: OLD_ACCOUNTING_ORACLE_IMPL,
            oldStakingRouterImpl: OLD_STAKING_ROUTER_IMPL,
            oldOracleReportSanityChecker: OLD_ORACLE_REPORT_SANITY_CHECKER,
            oldDepositSecurityModule: OLD_DEPOSIT_SECURITY_MODULE,
            //todo Accounting
            // ConsolidationMigrator.sol
            // ConsolidationBus.sol
            // todo libs BeaconChainDepositor.sol, SRLib.sol ?
            newLocatorImpl: NEW_LOCATOR_IMPL,
            newLidoImpl: NEW_LIDO_IMPL,
            newAccountingOracleImpl: NEW_ACCOUNTING_ORACLE_IMPL,
            newStakingRouterImpl: NEW_STAKING_ROUTER_IMPL,
            newOracleReportSanityChecker: NEW_ORACLE_REPORT_SANITY_CHECKER,
            newDepositSecurityModule: NEW_DEPOSIT_SECURITY_MODULE,
            topUpGatewayImpl: TOP_UP_GATEWAY_IMPL,
            etfUpdateStakingModuleShareLimits: ETF_UPDATE_STAKING_MODULE_SHARE_LIMITS
        });
    }

    function _getCSMUpgradeConfig() internal view returns (CSMUpgradeConfig memory) {
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

    function _getCuratedModuleConfig() internal view returns (CuratedModuleConfig memory) {
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
            hashConsensusInitialEpoch: CURATED_HASH_CONSENSUS_INITIAL_EPOCH
        });
    }

    error NewAndOldLocatorImplementationsMustBeDifferent();
    error OldAndNewOracleReportSanityCheckerMustBeDifferent();
    error OldAndNewDepositSecurityModuleMustBeDifferent();
    error StakingModuleNotFound(string moduleName);
}
