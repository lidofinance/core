// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";

import {IForwarder} from "./interfaces/IForwarder.sol";
import {CallsScriptBuilder} from "./utils/CallScriptBuilder.sol";

interface IOssifiableProxyV2 {
    function proxy__upgradeTo(address newImplementation_) external;
    function proxy__upgradeToAndCall(address newImplementation_, bytes calldata setupCalldata_) external;
}

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

interface ICSModuleV3 {
    function finalizeUpgradeV3() external;
    function REPORT_GENERAL_DELAYED_PENALTY_ROLE() external view returns (bytes32);
    function SETTLE_GENERAL_DELAYED_PENALTY_ROLE() external view returns (bytes32);
    function VERIFIER_ROLE() external view returns (bytes32);
    function REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE() external view returns (bytes32);
    function REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE() external view returns (bytes32);
    function CREATE_NODE_OPERATOR_ROLE() external view returns (bytes32);
    function PAUSE_ROLE() external view returns (bytes32);
    function RESUME_ROLE() external view returns (bytes32);
    function resume() external;
}

interface IParametersRegistryV3 {
    function finalizeUpgradeV3() external;
}

interface IFeeOracleV3 {
    function finalizeUpgradeV3(uint256 consensusVersion) external;
    function PAUSE_ROLE() external view returns (bytes32);
}

interface IAccountingV3 {
    function finalizeUpgradeV3() external;
    function PAUSE_ROLE() external view returns (bytes32);
}

interface IFeeDistributorV3 {
    function finalizeUpgradeV3() external;
}

interface IPausableWithResumeRoles {
    function PAUSE_ROLE() external view returns (bytes32);
    function RESUME_ROLE() external view returns (bytes32);
}

interface IPausableRole {
    function PAUSE_ROLE() external view returns (bytes32);
}

interface IValidatorStrikesV3 {
    function ejector() external view returns (address);
    function setEjector(address newEjector) external;
}

interface IBurner {
    function REQUEST_BURN_SHARES_ROLE() external view returns (bytes32);
    function REQUEST_BURN_MY_STETH_ROLE() external view returns (bytes32);
}

interface ITriggerableWithdrawalsGateway {
    function ADD_FULL_WITHDRAWAL_REQUEST_ROLE() external view returns (bytes32);
}

interface IHashConsensusV3 {
    function updateInitialEpoch(uint256 epoch) external;
}

interface IStakingRouter {
    function addStakingModule(
        string calldata _name,
        address _stakingModuleAddress,
        uint256 _stakeShareLimit,
        uint256 _priorityExitShareThreshold,
        uint256 _stakingModuleFee,
        uint256 _treasuryFee,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance
    ) external;
}

/// @title StakingRouterV3VoteScript
/// @notice Encodes the full CSM v2 -> v3 upgrade sequence and curated module addition
///         into one atomic Agent call script.
contract StakingRouterV3VoteScript {
    using CallsScriptBuilder for CallsScriptBuilder.Context;

    struct ScriptCall {
        address to;
        bytes data;
    }

    struct VoteItem {
        string description;
        ScriptCall call;
    }

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
        uint256 hashConsensusInitialEpoch;
        UpgradeConfigInput upgrade;
        CuratedModuleConfigInput curatedModule;
    }

    bytes32 public constant REPORT_EL_REWARDS_STEALING_PENALTY_ROLE =
        keccak256("REPORT_EL_REWARDS_STEALING_PENALTY_ROLE");
    bytes32 public constant SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE =
        keccak256("SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE");
    bytes32 public constant REPORT_GENERAL_DELAYED_PENALTY_ROLE =
        keccak256("REPORT_GENERAL_DELAYED_PENALTY_ROLE");
    bytes32 public constant SETTLE_GENERAL_DELAYED_PENALTY_ROLE =
        keccak256("SETTLE_GENERAL_DELAYED_PENALTY_ROLE");
    bytes32 public constant REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE =
        keccak256("REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE");
    bytes32 public constant REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE =
        keccak256("REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE");
    bytes32 public constant START_REFERRAL_SEASON_ROLE = keccak256("START_REFERRAL_SEASON_ROLE");
    bytes32 public constant END_REFERRAL_SEASON_ROLE = keccak256("END_REFERRAL_SEASON_ROLE");

    uint256 public constant ITEMS_COUNT = 46;

    address public immutable AGENT;
    address public immutable STAKING_ROUTER;
    address public immutable BURNER;
    address public immutable TRIGGERABLE_WITHDRAWALS_GATEWAY;
    address public immutable EASY_TRACK_EVM_SCRIPT_EXECUTOR;
    address public immutable RESEAL_MANAGER;
    address public immutable IDENTIFIED_COMMUNITY_STAKERS_GATE_MANAGER;
    address public immutable GATE_SEAL;
    address public immutable GATE_SEAL_V3;
    address public immutable GENERAL_DELAYED_PENALTY_REPORTER;
    uint256 public immutable HASH_CONSENSUS_INITIAL_EPOCH;

    address public immutable CSM;
    address public immutable CSM_IMPL;
    address public immutable PARAMETERS_REGISTRY;
    address public immutable PARAMETERS_REGISTRY_IMPL;
    address public immutable FEE_ORACLE;
    address public immutable FEE_ORACLE_IMPL;
    uint256 public immutable FEE_ORACLE_CONSENSUS_VERSION;
    address public immutable VETTED_GATE;
    address public immutable VETTED_GATE_IMPL;
    address public immutable ACCOUNTING;
    address public immutable ACCOUNTING_IMPL;
    address public immutable FEE_DISTRIBUTOR;
    address public immutable FEE_DISTRIBUTOR_IMPL;
    address public immutable EXIT_PENALTIES;
    address public immutable EXIT_PENALTIES_IMPL;
    address public immutable STRIKES;
    address public immutable STRIKES_IMPL;
    address public immutable OLD_PERMISSIONLESS_GATE;
    address public immutable VERIFIER;
    address public immutable VERIFIER_V3;
    address public immutable PERMISSIONLESS_GATE;
    address public immutable EJECTOR;

    address public immutable CURATED_MODULE;
    address public immutable CURATED_ACCOUNTING;
    address public immutable CURATED_EJECTOR;
    address public immutable CURATED_HASH_CONSENSUS;
    string public CURATED_MODULE_NAME;
    uint256 public immutable CURATED_STAKE_SHARE_LIMIT;
    uint256 public immutable CURATED_PRIORITY_EXIT_SHARE_THRESHOLD;
    uint256 public immutable CURATED_STAKING_MODULE_FEE;
    uint256 public immutable CURATED_TREASURY_FEE;
    uint256 public immutable CURATED_MAX_DEPOSITS_PER_BLOCK;
    uint256 public immutable CURATED_MIN_DEPOSIT_BLOCK_DISTANCE;

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
        CURATED_MODULE_NAME = curatedInput.moduleName;
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

    function getVoteItems() public view returns (VoteItem[] memory voteItems) {
        voteItems = new VoteItem[](ITEMS_COUNT);

        address oldPermissionlessGate = OLD_PERMISSIONLESS_GATE;

        address oldEjector = IValidatorStrikesV3(STRIKES).ejector();

        uint256 index = 0;

        voteItems[index++] = _item({
            description: "1. Upgrade and finalize CSM v3",
            to: CSM,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (CSM_IMPL, abi.encodeCall(ICSModuleV3.finalizeUpgradeV3, ()))
            )
        });

        voteItems[index++] = _item({
            description: "2. Upgrade and finalize ParametersRegistry v3",
            to: PARAMETERS_REGISTRY,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (
                    PARAMETERS_REGISTRY_IMPL,
                    abi.encodeCall(IParametersRegistryV3.finalizeUpgradeV3, ())
                )
            )
        });

        voteItems[index++] = _item({
            description: "3. Upgrade and finalize FeeOracle v3",
            to: FEE_ORACLE,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (
                    FEE_ORACLE_IMPL,
                    abi.encodeCall(IFeeOracleV3.finalizeUpgradeV3, (FEE_ORACLE_CONSENSUS_VERSION))
                )
            )
        });

        voteItems[index++] = _item({
            description: "4. Upgrade VettedGate implementation",
            to: VETTED_GATE,
            data: abi.encodeCall(IOssifiableProxyV2.proxy__upgradeTo, (VETTED_GATE_IMPL))
        });

        voteItems[index++] = _item({
            description: "5. Upgrade and finalize Accounting v3",
            to: ACCOUNTING,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (ACCOUNTING_IMPL, abi.encodeCall(IAccountingV3.finalizeUpgradeV3, ()))
            )
        });

        voteItems[index++] = _item({
            description: "6. Upgrade and finalize FeeDistributor v3",
            to: FEE_DISTRIBUTOR,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (FEE_DISTRIBUTOR_IMPL, abi.encodeCall(IFeeDistributorV3.finalizeUpgradeV3, ()))
            )
        });

        voteItems[index++] = _item({
            description: "7. Upgrade ExitPenalties implementation",
            to: EXIT_PENALTIES,
            data: abi.encodeCall(IOssifiableProxyV2.proxy__upgradeTo, (EXIT_PENALTIES_IMPL))
        });

        voteItems[index++] = _item({
            description: "8. Upgrade ValidatorStrikes implementation",
            to: STRIKES,
            data: abi.encodeCall(IOssifiableProxyV2.proxy__upgradeTo, (STRIKES_IMPL))
        });

        voteItems[index++] = _item({
            description: "9. Point ValidatorStrikes to the new Ejector",
            to: STRIKES,
            data: abi.encodeCall(IValidatorStrikesV3.setEjector, (EJECTOR))
        });

        voteItems[index++] = _item({
            description: "10. Grant REPORT_GENERAL_DELAYED_PENALTY_ROLE",
            call: _grantRole(
                CSM,
                REPORT_GENERAL_DELAYED_PENALTY_ROLE,
                GENERAL_DELAYED_PENALTY_REPORTER
            )
        });

        voteItems[index++] = _item({
            description: "11. Grant SETTLE_GENERAL_DELAYED_PENALTY_ROLE",
            call: _grantRole(
                CSM,
                SETTLE_GENERAL_DELAYED_PENALTY_ROLE,
                EASY_TRACK_EVM_SCRIPT_EXECUTOR
            )
        });

        voteItems[index++] = _item({
            description: "12. Revoke REPORT_EL_REWARDS_STEALING_PENALTY_ROLE",
            call: _revokeRole(
                CSM,
                REPORT_EL_REWARDS_STEALING_PENALTY_ROLE,
                GENERAL_DELAYED_PENALTY_REPORTER
            )
        });

        voteItems[index++] = _item({
            description: "13. Revoke SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE",
            call: _revokeRole(
                CSM,
                SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE,
                EASY_TRACK_EVM_SCRIPT_EXECUTOR
            )
        });

        voteItems[index++] = _item({
            description: "14. Revoke VERIFIER_ROLE from old verifier",
            call: _revokeRole(
                CSM,
                ICSModuleV3(CSM).VERIFIER_ROLE(),
                VERIFIER
            )
        });

        voteItems[index++] = _item({
            description: "15. Grant VERIFIER_ROLE to VerifierV3",
            call: _grantRole(
                CSM,
                ICSModuleV3(CSM).VERIFIER_ROLE(),
                VERIFIER_V3
            )
        });

        voteItems[index++] = _item({
            description: "16. Grant REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE to VerifierV3",
            call: _grantRole(
                CSM,
                REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE,
                VERIFIER_V3
            )
        });

        voteItems[index++] = _item({
            description: "17. Grant REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE to Easy Track",
            call: _grantRole(
                CSM,
                REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE,
                EASY_TRACK_EVM_SCRIPT_EXECUTOR
            )
        });

        voteItems[index++] = _item({
            description: "18. Revoke CREATE_NODE_OPERATOR_ROLE from old PermissionlessGate",
            call: _revokeRole(
                CSM,
                ICSModuleV3(CSM).CREATE_NODE_OPERATOR_ROLE(),
                oldPermissionlessGate
            )
        });

        voteItems[index++] = _item({
            description: "19. Grant CREATE_NODE_OPERATOR_ROLE to new PermissionlessGate",
            call: _grantRole(
                CSM,
                ICSModuleV3(CSM).CREATE_NODE_OPERATOR_ROLE(),
                PERMISSIONLESS_GATE
            )
        });

        voteItems[index++] = _item({
            description: "20. Revoke PAUSE_ROLE from old gate seal on CSModule",
            call: _revokeRole(CSM, ICSModuleV3(CSM).PAUSE_ROLE(), GATE_SEAL)
        });

        voteItems[index++] = _item({
            description: "21. Revoke PAUSE_ROLE from old gate seal on Accounting",
            call: _revokeRole(
                ACCOUNTING,
                IAccountingV3(ACCOUNTING).PAUSE_ROLE(),
                GATE_SEAL
            )
        });

        voteItems[index++] = _item({
            description: "22. Revoke PAUSE_ROLE from old gate seal on FeeOracle",
            call: _revokeRole(
                FEE_ORACLE,
                IFeeOracleV3(FEE_ORACLE).PAUSE_ROLE(),
                GATE_SEAL
            )
        });

        voteItems[index++] = _item({
            description: "23. Revoke PAUSE_ROLE from old gate seal on VettedGate",
            call: _revokeRole(
                VETTED_GATE,
                IPausableRole(VETTED_GATE).PAUSE_ROLE(),
                GATE_SEAL
            )
        });

        voteItems[index++] = _item({
            description: "24. Revoke PAUSE_ROLE from old gate seal on old Verifier",
            call: _revokeRole(VERIFIER, IPausableRole(VERIFIER).PAUSE_ROLE(), GATE_SEAL)
        });

        voteItems[index++] = _item({
            description: "25. Revoke PAUSE_ROLE from old gate seal on old Ejector",
            call: _revokeRole(oldEjector, IPausableWithResumeRoles(oldEjector).PAUSE_ROLE(), GATE_SEAL)
        });

        voteItems[index++] = _item({
            description: "26. Revoke PAUSE_ROLE from reseal manager on old Verifier",
            call: _revokeRole(
                VERIFIER,
                IPausableWithResumeRoles(VERIFIER).PAUSE_ROLE(),
                RESEAL_MANAGER
            )
        });

        voteItems[index++] = _item({
            description: "27. Revoke RESUME_ROLE from reseal manager on old Verifier",
            call: _revokeRole(
                VERIFIER,
                IPausableWithResumeRoles(VERIFIER).RESUME_ROLE(),
                RESEAL_MANAGER
            )
        });

        voteItems[index++] = _item({
            description: "28. Revoke PAUSE_ROLE from reseal manager on old Ejector",
            call: _revokeRole(
                oldEjector,
                IPausableWithResumeRoles(oldEjector).PAUSE_ROLE(),
                RESEAL_MANAGER
            )
        });

        voteItems[index++] = _item({
            description: "29. Revoke RESUME_ROLE from reseal manager on old Ejector",
            call: _revokeRole(
                oldEjector,
                IPausableWithResumeRoles(oldEjector).RESUME_ROLE(),
                RESEAL_MANAGER
            )
        });

        voteItems[index++] = _item({
            description: "30. Revoke START_REFERRAL_SEASON_ROLE",
            call: _revokeRole(VETTED_GATE, START_REFERRAL_SEASON_ROLE, AGENT)
        });

        voteItems[index++] = _item({
            description: "31. Revoke END_REFERRAL_SEASON_ROLE",
            call: _revokeRole(
                VETTED_GATE,
                END_REFERRAL_SEASON_ROLE,
                IDENTIFIED_COMMUNITY_STAKERS_GATE_MANAGER
            )
        });

        voteItems[index++] = _item({
            description: "32. Grant PAUSE_ROLE to GateSealV3 on CSModule",
            call: _grantRole(CSM, ICSModuleV3(CSM).PAUSE_ROLE(), GATE_SEAL_V3)
        });

        voteItems[index++] = _item({
            description: "33. Grant PAUSE_ROLE to GateSealV3 on Accounting",
            call: _grantRole(
                ACCOUNTING,
                IAccountingV3(ACCOUNTING).PAUSE_ROLE(),
                GATE_SEAL_V3
            )
        });

        voteItems[index++] = _item({
            description: "34. Grant PAUSE_ROLE to GateSealV3 on FeeOracle",
            call: _grantRole(
                FEE_ORACLE,
                IFeeOracleV3(FEE_ORACLE).PAUSE_ROLE(),
                GATE_SEAL_V3
            )
        });

        voteItems[index++] = _item({
            description: "35. Grant PAUSE_ROLE to GateSealV3 on VettedGate",
            call: _grantRole(
                VETTED_GATE,
                IPausableRole(VETTED_GATE).PAUSE_ROLE(),
                GATE_SEAL_V3
            )
        });

        voteItems[index++] = _item({
            description: "36. Revoke REQUEST_BURN_SHARES_ROLE from CSM Accounting",
            call: _revokeRole(
                BURNER,
                IBurner(BURNER).REQUEST_BURN_SHARES_ROLE(),
                ACCOUNTING
            )
        });

        voteItems[index++] = _item({
            description: "37. Grant REQUEST_BURN_MY_STETH_ROLE to CSM Accounting",
            call: _grantRole(
                BURNER,
                IBurner(BURNER).REQUEST_BURN_MY_STETH_ROLE(),
                ACCOUNTING
            )
        });

        voteItems[index++] = _item({
            description: "38. Revoke TWG full-withdrawal role from old Ejector",
            call: _revokeRole(
                TRIGGERABLE_WITHDRAWALS_GATEWAY,
                ITriggerableWithdrawalsGateway(TRIGGERABLE_WITHDRAWALS_GATEWAY)
                    .ADD_FULL_WITHDRAWAL_REQUEST_ROLE(),
                oldEjector
            )
        });

        voteItems[index++] = _item({
            description: "39. Grant TWG full-withdrawal role to new Ejector",
            call: _grantRole(
                TRIGGERABLE_WITHDRAWALS_GATEWAY,
                ITriggerableWithdrawalsGateway(TRIGGERABLE_WITHDRAWALS_GATEWAY)
                    .ADD_FULL_WITHDRAWAL_REQUEST_ROLE(),
                EJECTOR
            )
        });

        voteItems[index++] = _item({
            description: "40. Add Curated module to StakingRouter",
            to: STAKING_ROUTER,
            data: abi.encodeCall(
                IStakingRouter.addStakingModule,
                (
                    CURATED_MODULE_NAME,
                    CURATED_MODULE,
                    CURATED_STAKE_SHARE_LIMIT,
                    CURATED_PRIORITY_EXIT_SHARE_THRESHOLD,
                    CURATED_STAKING_MODULE_FEE,
                    CURATED_TREASURY_FEE,
                    CURATED_MAX_DEPOSITS_PER_BLOCK,
                    CURATED_MIN_DEPOSIT_BLOCK_DISTANCE
                )
            )
        });

        voteItems[index++] = _item({
            description: "41. Grant REQUEST_BURN_MY_STETH_ROLE to Curated Accounting",
            call: _grantRole(
                BURNER,
                IBurner(BURNER).REQUEST_BURN_MY_STETH_ROLE(),
                CURATED_ACCOUNTING
            )
        });

        voteItems[index++] = _item({
            description: "42. Grant TWG full-withdrawal role to Curated Ejector",
            call: _grantRole(
                TRIGGERABLE_WITHDRAWALS_GATEWAY,
                ITriggerableWithdrawalsGateway(TRIGGERABLE_WITHDRAWALS_GATEWAY)
                    .ADD_FULL_WITHDRAWAL_REQUEST_ROLE(),
                CURATED_EJECTOR
            )
        });

        voteItems[index++] = _item({
            description: "43. Grant RESUME_ROLE to agent on Curated module",
            call: _grantRole(
                CURATED_MODULE,
                ICSModuleV3(CURATED_MODULE).RESUME_ROLE(),
                AGENT
            )
        });

        voteItems[index++] = _item({
            description: "44. Resume Curated module",
            to: CURATED_MODULE,
            data: abi.encodeCall(ICSModuleV3.resume, ())
        });

        voteItems[index++] = _item({
            description: "45. Revoke RESUME_ROLE from agent on Curated module",
            call: _revokeRole(
                CURATED_MODULE,
                ICSModuleV3(CURATED_MODULE).RESUME_ROLE(),
                AGENT
            )
        });

        voteItems[index++] = _item({
            description: "46. Update Curated HashConsensus initial epoch",
            to: CURATED_HASH_CONSENSUS,
            data: abi.encodeCall(IHashConsensusV3.updateInitialEpoch, (HASH_CONSENSUS_INITIAL_EPOCH))
        });

        assert(index == ITEMS_COUNT);
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

    function _item(
        string memory description,
        address to,
        bytes memory data
    ) private pure returns (VoteItem memory) {
        return VoteItem({description: description, call: ScriptCall({to: to, data: data})});
    }

    function _item(string memory description, ScriptCall memory call) private pure returns (VoteItem memory) {
        return VoteItem({description: description, call: call});
    }

    function _grantRole(address target, bytes32 role, address account) private pure returns (ScriptCall memory) {
        return ScriptCall({to: target, data: abi.encodeCall(IAccessControl.grantRole, (role, account))});
    }

    function _revokeRole(address target, bytes32 role, address account) private pure returns (ScriptCall memory) {
        return ScriptCall({to: target, data: abi.encodeCall(IAccessControl.revokeRole, (role, account))});
    }
}
