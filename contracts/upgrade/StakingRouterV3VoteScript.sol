// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IForwarder} from "./interfaces/IForwarder.sol";
import {CallsScriptBuilder} from "./utils/CallScriptBuilder.sol";

import {
    VoteItem,
    GeneralConfig,
    UpgradeConfig,
    CuratedModuleConfig,
    IValidatorStrikesV3
} from "./StakingRouterV3VoteTypes.sol";
import {CSMUpgradeSteps} from "./CSMUpgradeSteps.sol";
import {CuratedModuleSteps} from "./CuratedModuleSteps.sol";

interface ILidoLocatorV3 {
    function burner() external view returns (address);
    function stakingRouter() external view returns (address);
    function triggerableWithdrawalsGateway() external view returns (address);
}

interface IBaseModuleV3 {
    function LIDO_LOCATOR() external view returns (address);
    function PARAMETERS_REGISTRY() external view returns (address);
    function ACCOUNTING() external view returns (address);
    function EXIT_PENALTIES() external view returns (address);
    function FEE_DISTRIBUTOR() external view returns (address);
}

interface IAccountingV3View {
    function FEE_DISTRIBUTOR() external view returns (address);
}

interface IFeeDistributorV3View {
    function ORACLE() external view returns (address);
}

interface IFeeOracleV3View {
    function STRIKES() external view returns (address);
}

/// @title StakingRouterV3VoteScript
/// @notice Encodes the full CSM v2 -> v3 upgrade sequence and curated module addition
///         into one atomic Agent call script.
contract StakingRouterV3VoteScript {
    using CallsScriptBuilder for CallsScriptBuilder.Context;

    struct UpgradeConfigInput {
        address csmProxy;
        address csmImpl;
        address vettedGateProxy;
        address parametersRegistryImpl;
        address feeOracleImpl;
        uint256 feeOracleConsensusVersion;
        address vettedGateImpl;
        address accountingImpl;
        address feeDistributorImpl;
        address exitPenaltiesImpl;
        address strikesImpl;
        address oldPermissionlessGate;
        address verifier;
        address verifierV3;
        address permissionlessGate;
        address ejector;
    }

    struct CuratedModuleConfigInput {
        address module;
        address hashConsensus;
        string moduleName;
        uint256 stakeShareLimit;
        uint256 priorityExitShareThreshold;
        uint256 stakingModuleFee;
        uint256 treasuryFee;
        uint256 maxDepositsPerBlock;
        uint256 minDepositBlockDistance;
    }

    struct ScriptParamsInput {
        address agent;
        address easyTrackEVMScriptExecutor;
        address resealManager;
        address identifiedCommunityStakersGateManager;
        address gateSeal;
        address gateSealV3;
        address generalDelayedPenaltyReporter;
        address penaltiesManager;
        uint256 hashConsensusInitialEpoch;
        UpgradeConfigInput upgrade;
        CuratedModuleConfigInput curatedModule;
    }

    uint256 public constant ITEMS_COUNT = CSMUpgradeSteps.COUNT + CuratedModuleSteps.COUNT;

    address internal immutable AGENT;
    address internal immutable STAKING_ROUTER;
    address internal immutable BURNER;
    address internal immutable TRIGGERABLE_WITHDRAWALS_GATEWAY;
    address internal immutable EASY_TRACK_EVM_SCRIPT_EXECUTOR;
    address internal immutable RESEAL_MANAGER;
    address internal immutable IDENTIFIED_COMMUNITY_STAKERS_GATE_MANAGER;
    address internal immutable GATE_SEAL;
    address internal immutable GATE_SEAL_V3;
    address internal immutable GENERAL_DELAYED_PENALTY_REPORTER;
    address internal immutable PENALTIES_MANAGER;
    uint256 internal immutable HASH_CONSENSUS_INITIAL_EPOCH;

    address internal immutable CSM;
    address internal immutable CSM_IMPL;
    address internal immutable PARAMETERS_REGISTRY;
    address internal immutable PARAMETERS_REGISTRY_IMPL;
    address internal immutable FEE_ORACLE;
    address internal immutable FEE_ORACLE_IMPL;
    uint256 internal immutable FEE_ORACLE_CONSENSUS_VERSION;
    address internal immutable VETTED_GATE;
    address internal immutable VETTED_GATE_IMPL;
    address internal immutable ACCOUNTING;
    address internal immutable ACCOUNTING_IMPL;
    address internal immutable FEE_DISTRIBUTOR;
    address internal immutable FEE_DISTRIBUTOR_IMPL;
    address internal immutable EXIT_PENALTIES;
    address internal immutable EXIT_PENALTIES_IMPL;
    address internal immutable STRIKES;
    address internal immutable STRIKES_IMPL;
    address internal immutable OLD_PERMISSIONLESS_GATE;
    address internal immutable VERIFIER;
    address internal immutable VERIFIER_V3;
    address internal immutable PERMISSIONLESS_GATE;
    address internal immutable EJECTOR;

    address internal immutable CURATED_MODULE;
    address internal immutable CURATED_ACCOUNTING;
    address internal immutable CURATED_EJECTOR;
    address internal immutable CURATED_HASH_CONSENSUS;
    string internal _curatedModuleName;
    uint256 internal immutable CURATED_STAKE_SHARE_LIMIT;
    uint256 internal immutable CURATED_PRIORITY_EXIT_SHARE_THRESHOLD;
    uint256 internal immutable CURATED_STAKING_MODULE_FEE;
    uint256 internal immutable CURATED_TREASURY_FEE;
    uint256 internal immutable CURATED_MAX_DEPOSITS_PER_BLOCK;
    uint256 internal immutable CURATED_MIN_DEPOSIT_BLOCK_DISTANCE;

    constructor(ScriptParamsInput memory _paramsInput) {
        UpgradeConfigInput memory upgradeInput = _paramsInput.upgrade;
        CuratedModuleConfigInput memory curatedInput = _paramsInput.curatedModule;

        AGENT = _paramsInput.agent;
        EASY_TRACK_EVM_SCRIPT_EXECUTOR = _paramsInput.easyTrackEVMScriptExecutor;
        RESEAL_MANAGER = _paramsInput.resealManager;
        IDENTIFIED_COMMUNITY_STAKERS_GATE_MANAGER = _paramsInput.identifiedCommunityStakersGateManager;
        GATE_SEAL = _paramsInput.gateSeal;
        GATE_SEAL_V3 = _paramsInput.gateSealV3;
        GENERAL_DELAYED_PENALTY_REPORTER = _paramsInput.generalDelayedPenaltyReporter;
        PENALTIES_MANAGER = _paramsInput.penaltiesManager;
        HASH_CONSENSUS_INITIAL_EPOCH = _paramsInput.hashConsensusInitialEpoch;

        CSM = upgradeInput.csmProxy;
        CSM_IMPL = upgradeInput.csmImpl;
        PARAMETERS_REGISTRY_IMPL = upgradeInput.parametersRegistryImpl;
        FEE_ORACLE_IMPL = upgradeInput.feeOracleImpl;
        FEE_ORACLE_CONSENSUS_VERSION = upgradeInput.feeOracleConsensusVersion;
        VETTED_GATE = upgradeInput.vettedGateProxy;
        VETTED_GATE_IMPL = upgradeInput.vettedGateImpl;
        ACCOUNTING_IMPL = upgradeInput.accountingImpl;
        FEE_DISTRIBUTOR_IMPL = upgradeInput.feeDistributorImpl;
        EXIT_PENALTIES_IMPL = upgradeInput.exitPenaltiesImpl;
        STRIKES_IMPL = upgradeInput.strikesImpl;
        OLD_PERMISSIONLESS_GATE = upgradeInput.oldPermissionlessGate;
        VERIFIER = upgradeInput.verifier;
        VERIFIER_V3 = upgradeInput.verifierV3;
        PERMISSIONLESS_GATE = upgradeInput.permissionlessGate;
        EJECTOR = upgradeInput.ejector;

        IBaseModuleV3 csm = IBaseModuleV3(CSM);
        PARAMETERS_REGISTRY = csm.PARAMETERS_REGISTRY();
        ACCOUNTING = csm.ACCOUNTING();
        EXIT_PENALTIES = csm.EXIT_PENALTIES();
        FEE_DISTRIBUTOR = csm.FEE_DISTRIBUTOR();
        FEE_ORACLE = IFeeDistributorV3View(FEE_DISTRIBUTOR).ORACLE();
        STRIKES = IFeeOracleV3View(FEE_ORACLE).STRIKES();

        ILidoLocatorV3 locator = ILidoLocatorV3(csm.LIDO_LOCATOR());
        STAKING_ROUTER = locator.stakingRouter();
        BURNER = locator.burner();
        TRIGGERABLE_WITHDRAWALS_GATEWAY = locator.triggerableWithdrawalsGateway();

        CURATED_MODULE = curatedInput.module;
        CURATED_HASH_CONSENSUS = curatedInput.hashConsensus;
        _curatedModuleName = curatedInput.moduleName;
        CURATED_STAKE_SHARE_LIMIT = curatedInput.stakeShareLimit;
        CURATED_PRIORITY_EXIT_SHARE_THRESHOLD = curatedInput.priorityExitShareThreshold;
        CURATED_STAKING_MODULE_FEE = curatedInput.stakingModuleFee;
        CURATED_TREASURY_FEE = curatedInput.treasuryFee;
        CURATED_MAX_DEPOSITS_PER_BLOCK = curatedInput.maxDepositsPerBlock;
        CURATED_MIN_DEPOSIT_BLOCK_DISTANCE = curatedInput.minDepositBlockDistance;

        CURATED_ACCOUNTING = IBaseModuleV3(CURATED_MODULE).ACCOUNTING();
        address curatedFeeDistributor = IAccountingV3View(CURATED_ACCOUNTING).FEE_DISTRIBUTOR();
        address curatedFeeOracle = IFeeDistributorV3View(curatedFeeDistributor).ORACLE();
        address curatedStrikes = IFeeOracleV3View(curatedFeeOracle).STRIKES();
        CURATED_EJECTOR = IValidatorStrikesV3(curatedStrikes).ejector();
    }

    function getGeneralConfig() external view returns (GeneralConfig memory) {
        return _getGeneralConfig();
    }

    function getUpgradeConfig() external view returns (UpgradeConfig memory) {
        return _getUpgradeConfig();
    }

    function getCuratedModuleConfig() external view returns (CuratedModuleConfig memory) {
        return _getCuratedModuleConfig();
    }

    function getVoteItems() public view returns (VoteItem[] memory voteItems) {
        VoteItem[] memory csmItems = CSMUpgradeSteps.getItems(_getGeneralConfig(), _getUpgradeConfig());
        VoteItem[] memory curatedItems = CuratedModuleSteps.getItems(_getGeneralConfig(), _getCuratedModuleConfig());

        voteItems = new VoteItem[](csmItems.length + curatedItems.length);
        for (uint256 i = 0; i < csmItems.length; ++i) {
            voteItems[i] = csmItems[i];
        }
        for (uint256 i = 0; i < curatedItems.length; ++i) {
            voteItems[csmItems.length + i] = curatedItems[i];
        }
    }

    function getAgentEVMScript() public view returns (bytes memory) {
        VoteItem[] memory voteItems = getVoteItems();
        CallsScriptBuilder.Context memory scriptBuilder = CallsScriptBuilder.create();
        for (uint256 i = 0; i < voteItems.length; ++i) {
            scriptBuilder.addCall(voteItems[i].call.to, voteItems[i].call.data);
        }
        return scriptBuilder.getResult();
    }

    function getAgentForwardCalldata() external view returns (bytes memory) {
        return abi.encodeCall(IForwarder.forward, (getAgentEVMScript()));
    }

    function _getGeneralConfig() internal view returns (GeneralConfig memory) {
        return GeneralConfig({
            agent: AGENT,
            stakingRouter: STAKING_ROUTER,
            burner: BURNER,
            triggerableWithdrawalsGateway: TRIGGERABLE_WITHDRAWALS_GATEWAY,
            easyTrackEVMScriptExecutor: EASY_TRACK_EVM_SCRIPT_EXECUTOR,
            resealManager: RESEAL_MANAGER,
            identifiedCommunityStakersGateManager: IDENTIFIED_COMMUNITY_STAKERS_GATE_MANAGER,
            gateSeal: GATE_SEAL,
            gateSealV3: GATE_SEAL_V3,
            generalDelayedPenaltyReporter: GENERAL_DELAYED_PENALTY_REPORTER,
            penaltiesManager: PENALTIES_MANAGER,
            hashConsensusInitialEpoch: HASH_CONSENSUS_INITIAL_EPOCH
        });
    }

    function _getUpgradeConfig() internal view returns (UpgradeConfig memory) {
        return UpgradeConfig({
            csm: CSM,
            csmImpl: CSM_IMPL,
            parametersRegistry: PARAMETERS_REGISTRY,
            parametersRegistryImpl: PARAMETERS_REGISTRY_IMPL,
            feeOracle: FEE_ORACLE,
            feeOracleImpl: FEE_ORACLE_IMPL,
            feeOracleConsensusVersion: FEE_ORACLE_CONSENSUS_VERSION,
            vettedGate: VETTED_GATE,
            vettedGateImpl: VETTED_GATE_IMPL,
            accounting: ACCOUNTING,
            accountingImpl: ACCOUNTING_IMPL,
            feeDistributor: FEE_DISTRIBUTOR,
            feeDistributorImpl: FEE_DISTRIBUTOR_IMPL,
            exitPenalties: EXIT_PENALTIES,
            exitPenaltiesImpl: EXIT_PENALTIES_IMPL,
            strikes: STRIKES,
            strikesImpl: STRIKES_IMPL,
            oldPermissionlessGate: OLD_PERMISSIONLESS_GATE,
            verifier: VERIFIER,
            verifierV3: VERIFIER_V3,
            permissionlessGate: PERMISSIONLESS_GATE,
            ejector: EJECTOR
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
            minDepositBlockDistance: CURATED_MIN_DEPOSIT_BLOCK_DISTANCE
        });
    }
}
