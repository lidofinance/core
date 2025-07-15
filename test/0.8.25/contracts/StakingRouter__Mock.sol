// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IStakingRouter} from "contracts/common/interfaces/IStakingRouter.sol";

contract StakingRouter__Mock is IStakingRouter {
    // An event to track when reportValidatorExitDelay is called
    event UnexitedValidatorReported(
        uint256 moduleId,
        uint256 nodeOperatorId,
        uint256 proofSlotTimestamp,
        bytes publicKey,
        uint256 secondsSinceEligibleExitRequest
    );

    // Empty implementations for all interface functions
    function MANAGE_WITHDRAWAL_CREDENTIALS_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }
    function STAKING_MODULE_MANAGE_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }
    function STAKING_MODULE_UNVETTING_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }
    function REPORT_EXITED_VALIDATORS_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }
    function REPORT_VALIDATOR_EXITING_STATUS_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }
    function REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }
    function UNSAFE_SET_EXITED_VALIDATORS_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }
    function REPORT_REWARDS_MINTED_ROLE() external pure returns (bytes32) {
        return bytes32(0);
    }

    function FEE_PRECISION_POINTS() external pure returns (uint256) {
        return 0;
    }
    function TOTAL_BASIS_POINTS() external pure returns (uint256) {
        return 0;
    }
    function MAX_STAKING_MODULES_COUNT() external pure returns (uint256) {
        return 0;
    }
    function MAX_STAKING_MODULE_NAME_LENGTH() external pure returns (uint256) {
        return 0;
    }

    function initialize(address _admin, address _lido, bytes32 _withdrawalCredentials) external {}
    function finalizeUpgrade_v3() external {}
    function getLido() external pure returns (address) {
        return address(0);
    }

    function addStakingModule(
        string calldata _name,
        address _stakingModuleAddress,
        uint256 _stakeShareLimit,
        uint256 _priorityExitShareThreshold,
        uint256 _stakingModuleFee,
        uint256 _treasuryFee,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance
    ) external {}

    function updateStakingModule(
        uint256 _stakingModuleId,
        uint256 _stakeShareLimit,
        uint256 _priorityExitShareThreshold,
        uint256 _stakingModuleFee,
        uint256 _treasuryFee,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance
    ) external {}

    function updateTargetValidatorsLimits(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        uint256 _targetLimitMode,
        uint256 _targetLimit
    ) external {}

    function reportRewardsMinted(uint256[] calldata _stakingModuleIds, uint256[] calldata _totalShares) external {}

    function updateExitedValidatorsCountByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _exitedValidatorsCounts
    ) external returns (uint256) {
        return 0;
    }

    function reportStakingModuleExitedValidatorsCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _exitedValidatorsCounts
    ) external {}

    function unsafeSetExitedValidatorsCount(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bool _triggerUpdateFinish,
        ValidatorsCountsCorrection memory _correction
    ) external {}

    function onValidatorsCountsByNodeOperatorReportingFinished() external {}

    function decreaseStakingModuleVettedKeysCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _vettedSigningKeysCounts
    ) external {}

    function getStakingModules() external pure returns (StakingModule[] memory res) {
        return new StakingModule[](0);
    }
    function getStakingModuleIds() external pure returns (uint256[] memory stakingModuleIds) {
        return new uint256[](0);
    }
    function getStakingModule(uint256 _stakingModuleId) external pure returns (StakingModule memory) {
        return StakingModule(0, address(0), 0, 0, 0, 0, "", 0, 0, 0, 0, 0, 0);
    }
    function getStakingModulesCount() external pure returns (uint256) {
        return 0;
    }
    function hasStakingModule(uint256 _stakingModuleId) external pure returns (bool) {
        return false;
    }
    function getStakingModuleStatus(uint256 _stakingModuleId) external pure returns (StakingModuleStatus) {
        return StakingModuleStatus.Active;
    }
    function getStakingModuleSummary(
        uint256 _stakingModuleId
    ) external pure returns (StakingModuleSummary memory summary) {
        return StakingModuleSummary(0, 0, 0);
    }
    function getNodeOperatorSummary(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId
    ) external pure returns (NodeOperatorSummary memory summary) {
        return NodeOperatorSummary(0, 0, 0, 0, 0, 0, 0, 0);
    }
    function getAllStakingModuleDigests() external pure returns (StakingModuleDigest[] memory) {
        return new StakingModuleDigest[](0);
    }
    function getStakingModuleDigests(
        uint256[] memory _stakingModuleIds
    ) external pure returns (StakingModuleDigest[] memory digests) {
        return new StakingModuleDigest[](0);
    }
    function getAllNodeOperatorDigests(uint256 _stakingModuleId) external pure returns (NodeOperatorDigest[] memory) {
        return new NodeOperatorDigest[](0);
    }
    function getNodeOperatorDigests(
        uint256 _stakingModuleId,
        uint256 _offset,
        uint256 _limit
    ) external pure returns (NodeOperatorDigest[] memory) {
        return new NodeOperatorDigest[](0);
    }
    function getNodeOperatorDigests(
        uint256 _stakingModuleId,
        uint256[] memory _nodeOperatorIds
    ) external pure returns (NodeOperatorDigest[] memory digests) {
        return new NodeOperatorDigest[](0);
    }
    function setStakingModuleStatus(uint256 _stakingModuleId, StakingModuleStatus _status) external {}
    function getStakingModuleIsStopped(uint256 _stakingModuleId) external pure returns (bool) {
        return false;
    }
    function getStakingModuleIsDepositsPaused(uint256 _stakingModuleId) external pure returns (bool) {
        return false;
    }
    function getStakingModuleIsActive(uint256 _stakingModuleId) external pure returns (bool) {
        return true;
    }
    function getStakingModuleNonce(uint256 _stakingModuleId) external pure returns (uint256) {
        return 0;
    }
    function getStakingModuleLastDepositBlock(uint256 _stakingModuleId) external pure returns (uint256) {
        return 0;
    }
    function getStakingModuleMinDepositBlockDistance(uint256 _stakingModuleId) external pure returns (uint256) {
        return 0;
    }
    function getStakingModuleMaxDepositsPerBlock(uint256 _stakingModuleId) external pure returns (uint256) {
        return 0;
    }
    function getStakingModuleActiveValidatorsCount(
        uint256 _stakingModuleId
    ) external pure returns (uint256 activeValidatorsCount) {
        return 0;
    }
    function getStakingModuleMaxDepositsCount(
        uint256 _stakingModuleId,
        uint256 _maxDepositsValue
    ) external pure returns (uint256) {
        return 0;
    }
    function getStakingFeeAggregateDistribution()
        external
        pure
        returns (uint96 modulesFee, uint96 treasuryFee, uint256 basePrecision)
    {
        return (0, 0, 0);
    }
    function getStakingRewardsDistribution()
        external
        pure
        returns (
            address[] memory recipients,
            uint256[] memory stakingModuleIds,
            uint96[] memory stakingModuleFees,
            uint96 totalFee,
            uint256 precisionPoints
        )
    {
        return (new address[](0), new uint256[](0), new uint96[](0), 0, 0);
    }
    function getTotalFeeE4Precision() external pure returns (uint16 totalFee) {
        return 0;
    }
    function getStakingFeeAggregateDistributionE4Precision()
        external
        pure
        returns (uint16 modulesFee, uint16 treasuryFee)
    {
        return (0, 0);
    }
    function getDepositsAllocation(
        uint256 _depositsCount
    ) external pure returns (uint256 allocated, uint256[] memory allocations) {
        return (0, new uint256[](0));
    }
    function deposit(
        uint256 _depositsCount,
        uint256 _stakingModuleId,
        bytes calldata _depositCalldata
    ) external payable {}
    function setWithdrawalCredentials(bytes32 _withdrawalCredentials) external {}
    function getWithdrawalCredentials() external pure returns (bytes32) {
        return bytes32(0);
    }

    function reportValidatorExitDelay(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes calldata _publicKey,
        uint256 _eligibleToExitInSec
    ) external {
        // Emit an event so that testing frameworks can detect this call
        emit UnexitedValidatorReported(
            _stakingModuleId,
            _nodeOperatorId,
            _proofSlotTimestamp,
            _publicKey,
            _eligibleToExitInSec
        );
    }

    function onValidatorExitTriggered(
        ValidatorExitData[] calldata validatorExitData,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) external {}
}
