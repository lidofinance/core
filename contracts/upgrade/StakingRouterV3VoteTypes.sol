// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";

// ============================
// Interfaces
// ============================

interface IOssifiableProxyV2 {
    function proxy__upgradeTo(address newImplementation_) external;
    function proxy__upgradeToAndCall(address newImplementation_, bytes calldata setupCalldata_) external;
}

interface ICSModuleV3 {
    function finalizeUpgradeV3() external;
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
    function MANAGE_GENERAL_PENALTIES_AND_CHARGES_ROLE() external view returns (bytes32);
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

// ============================
// Shared types
// ============================

struct ScriptCall {
    address to;
    bytes data;
}

struct VoteItem {
    string description;
    ScriptCall call;
}

struct GeneralConfig {
    address agent;
    address stakingRouter;
    address burner;
    address triggerableWithdrawalsGateway;
    address easyTrackEVMScriptExecutor;
    address resealManager;
    address identifiedCommunityStakersGateManager;
    address gateSeal;
    address gateSealV3;
    address generalDelayedPenaltyReporter;
    address penaltiesManager;
    uint256 hashConsensusInitialEpoch;
}

struct UpgradeConfig {
    address csm;
    address csmImpl;
    address parametersRegistry;
    address parametersRegistryImpl;
    address feeOracle;
    address feeOracleImpl;
    uint256 feeOracleConsensusVersion;
    address vettedGate;
    address vettedGateImpl;
    address accounting;
    address accountingImpl;
    address feeDistributor;
    address feeDistributorImpl;
    address exitPenalties;
    address exitPenaltiesImpl;
    address strikes;
    address strikesImpl;
    address oldPermissionlessGate;
    address verifier;
    address verifierV3;
    address permissionlessGate;
    address ejector;
}

struct CuratedModuleConfig {
    address module;
    address accounting;
    address ejector;
    address hashConsensus;
    string moduleName;
    uint256 stakeShareLimit;
    uint256 priorityExitShareThreshold;
    uint256 stakingModuleFee;
    uint256 treasuryFee;
    uint256 maxDepositsPerBlock;
    uint256 minDepositBlockDistance;
}

// ============================
// Internal helpers (inlined at call sites)
// ============================

library VoteScriptHelpers {
    function item(
        string memory description,
        address to,
        bytes memory data
    ) internal pure returns (VoteItem memory) {
        return VoteItem({description: description, call: ScriptCall({to: to, data: data})});
    }

    function item(string memory description, ScriptCall memory call) internal pure returns (VoteItem memory) {
        return VoteItem({description: description, call: call});
    }

    function grantRole(address target, bytes32 role, address account) internal pure returns (ScriptCall memory) {
        return ScriptCall({to: target, data: abi.encodeCall(IAccessControl.grantRole, (role, account))});
    }

    function revokeRole(address target, bytes32 role, address account) internal pure returns (ScriptCall memory) {
        return ScriptCall({to: target, data: abi.encodeCall(IAccessControl.revokeRole, (role, account))});
    }
}
