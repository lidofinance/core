// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {IStakingModule} from "contracts/0.8.9/interfaces/IStakingModule.sol";

contract StakingModule__MockForStakingRouter is IStakingModule {
    event Mock__TargetValidatorsLimitsUpdated(uint256 _nodeOperatorId, uint256 _targetLimitMode, uint256 _targetLimit);
    event Mock__RefundedValidatorsCountUpdated(uint256 _nodeOperatorId, uint256 _refundedValidatorsCount);
    event Mock__OnRewardsMinted(uint256 _totalShares);
    event Mock__ExitedValidatorsCountUpdated(bytes _nodeOperatorIds, bytes _stuckValidatorsCounts);

    event Mock__reportValidatorExitDelay(
        uint256 nodeOperatorId,
        uint256 proofSlotTimestamp,
        bytes publicKeys,
        uint256 eligibleToExitInSec
    );

    event Mock__onValidatorExitTriggered(
        uint256 _nodeOperatorId,
        bytes publicKeys,
        uint256 withdrawalRequestPaidFee,
        uint256 exitType
    );

    function getType() external view returns (bytes32) {
        return keccak256(abi.encodePacked("staking.module"));
    }

    uint256 private totalExitedValidators__mocked;
    uint256 private totalDepositedValidators__mocked;
    uint256 private depositableValidatorsCount__mocked;

    function getStakingModuleSummary()
        external
        view
        returns (uint256 totalExitedValidators, uint256 totalDepositedValidators, uint256 depositableValidatorsCount)
    {
        totalExitedValidators = totalExitedValidators__mocked;
        totalDepositedValidators = totalDepositedValidators__mocked;
        depositableValidatorsCount = depositableValidatorsCount__mocked;
    }

    function mock__getStakingModuleSummary(
        uint256 totalExitedValidators,
        uint256 totalDepositedValidators,
        uint256 depositableValidatorsCount
    ) external {
        totalExitedValidators__mocked = totalExitedValidators;
        totalDepositedValidators__mocked = totalDepositedValidators;
        depositableValidatorsCount__mocked = depositableValidatorsCount;
    }

    uint256 private nodeOperatorTargetLimitMode__mocked;
    uint256 private nodeOperatorTargetValidatorsCount__mocked;
    uint256 private nodeOperatorStuckValidatorsCount__mocked;
    uint256 private nodeOperatorRefundedValidatorsCount__mocked;
    uint256 private nodeOperatorStuckPenaltyEndTimestamp__mocked;
    uint256 private nodeOperatorNodeOperatorTotalExitedValidators__mocked;
    uint256 private nodeOperatorNodeOperatorTotalDepositedValidators__mocked;
    uint256 private nodeOperatorNodeOperatorDepositableValidatorsCount__mocked;

    function getNodeOperatorSummary(
        uint256
    )
        external
        view
        returns (
            uint256 targetLimitMode,
            uint256 targetValidatorsCount,
            uint256 stuckValidatorsCount,
            uint256 refundedValidatorsCount,
            uint256 stuckPenaltyEndTimestamp,
            uint256 totalExitedValidators,
            uint256 totalDepositedValidators,
            uint256 depositableValidatorsCount
        )
    {
        targetLimitMode = nodeOperatorTargetLimitMode__mocked;
        targetValidatorsCount = nodeOperatorTargetValidatorsCount__mocked;
        stuckValidatorsCount = nodeOperatorStuckValidatorsCount__mocked;
        refundedValidatorsCount = nodeOperatorRefundedValidatorsCount__mocked;
        stuckPenaltyEndTimestamp = nodeOperatorStuckPenaltyEndTimestamp__mocked;
        totalExitedValidators = nodeOperatorNodeOperatorTotalExitedValidators__mocked;
        totalDepositedValidators = nodeOperatorNodeOperatorTotalDepositedValidators__mocked;
        depositableValidatorsCount = nodeOperatorNodeOperatorDepositableValidatorsCount__mocked;
    }

    function mock__getNodeOperatorSummary(
        uint256 targetLimitMode,
        uint256 targetValidatorsCount,
        uint256 stuckValidatorsCount,
        uint256 refundedValidatorsCount,
        uint256 stuckPenaltyEndTimestamp,
        uint256 totalExitedValidators,
        uint256 totalDepositedValidators,
        uint256 depositableValidatorsCount
    ) external {
        nodeOperatorTargetLimitMode__mocked = targetLimitMode;
        nodeOperatorTargetValidatorsCount__mocked = targetValidatorsCount;
        nodeOperatorStuckValidatorsCount__mocked = stuckValidatorsCount;
        nodeOperatorRefundedValidatorsCount__mocked = refundedValidatorsCount;
        nodeOperatorStuckPenaltyEndTimestamp__mocked = stuckPenaltyEndTimestamp;
        nodeOperatorNodeOperatorTotalExitedValidators__mocked = totalExitedValidators;
        nodeOperatorNodeOperatorTotalDepositedValidators__mocked = totalDepositedValidators;
        nodeOperatorNodeOperatorDepositableValidatorsCount__mocked = depositableValidatorsCount;
    }

    uint256 private nonce;

    function getNonce() external view returns (uint256) {
        return nonce;
    }

    function mock__getNonce(uint256 newNonce) external {
        nonce = newNonce;
    }

    uint256 private nodeOperatorsCount__mocked;
    uint256 private activeNodeOperatorsCount__mocked;

    function getNodeOperatorsCount() external view returns (uint256) {
        return nodeOperatorsCount__mocked;
    }

    function getActiveNodeOperatorsCount() external view returns (uint256) {
        return activeNodeOperatorsCount__mocked;
    }

    function mock__nodeOperatorsCount(uint256 total, uint256 active) external {
        nodeOperatorsCount__mocked = total;
        activeNodeOperatorsCount__mocked = active;
    }

    function getNodeOperatorIsActive(uint256) external view returns (bool) {
        return true;
    }

    uint256[] private nodeOperatorsIds__mocked;

    function getNodeOperatorIds(uint256, uint256) external view returns (uint256[] memory nodeOperatorIds) {
        return nodeOperatorsIds__mocked;
    }

    function mock__getNodeOperatorIds(uint256[] calldata nodeOperatorsIds) external {
        nodeOperatorsIds__mocked = nodeOperatorsIds;
    }

    bool private onRewardsMintedShouldRevert = false;
    bool private onRewardsMintedShouldRunOutGas = false;

    function onRewardsMinted(uint256 _totalShares) external {
        require(!onRewardsMintedShouldRevert, "revert reason");

        if (onRewardsMintedShouldRunOutGas) {
            revert();
        }

        emit Mock__OnRewardsMinted(_totalShares);
    }

    function mock__revertOnRewardsMinted(bool shouldRevert, bool shouldRunOutOfGas) external {
        onRewardsMintedShouldRevert = shouldRevert;
        onRewardsMintedShouldRunOutGas = shouldRunOutOfGas;
    }

    event Mock__VettedSigningKeysCountDecreased(bytes _nodeOperatorIds, bytes _stuckValidatorsCounts);

    function decreaseVettedSigningKeysCount(
        bytes calldata _nodeOperatorIds,
        bytes calldata _vettedSigningKeysCounts
    ) external {
        emit Mock__VettedSigningKeysCountDecreased(_nodeOperatorIds, _vettedSigningKeysCounts);
    }

    event Mock__StuckValidatorsCountUpdated(bytes _nodeOperatorIds, bytes _stuckValidatorsCounts);

    function updateStuckValidatorsCount(
        bytes calldata _nodeOperatorIds,
        bytes calldata _stuckValidatorsCounts
    ) external {
        emit Mock__StuckValidatorsCountUpdated(_nodeOperatorIds, _stuckValidatorsCounts);
    }

    function updateExitedValidatorsCount(
        bytes calldata _nodeOperatorIds,
        bytes calldata _stuckValidatorsCounts
    ) external {
        emit Mock__ExitedValidatorsCountUpdated(_nodeOperatorIds, _stuckValidatorsCounts);
    }

    function updateRefundedValidatorsCount(uint256 _nodeOperatorId, uint256 _refundedValidatorsCount) external {
        emit Mock__RefundedValidatorsCountUpdated(_nodeOperatorId, _refundedValidatorsCount);
    }

    function updateTargetValidatorsLimits(
        uint256 _nodeOperatorId,
        uint256 _targetLimitMode,
        uint256 _targetLimit
    ) external {
        emit Mock__TargetValidatorsLimitsUpdated(_nodeOperatorId, _targetLimitMode, _targetLimit);
    }

    event Mock__ValidatorsCountUnsafelyUpdated(uint256 _nodeOperatorId, uint256 _exitedValidatorsCount);

    function unsafeUpdateValidatorsCount(uint256 _nodeOperatorId, uint256 _exitedValidatorsCount) external {
        emit Mock__ValidatorsCountUnsafelyUpdated(_nodeOperatorId, _exitedValidatorsCount);
    }

    function obtainDepositData(
        uint256 _depositsCount,
        bytes calldata
    ) external returns (bytes memory publicKeys, bytes memory signatures) {
        publicKeys = new bytes(48 * _depositsCount);
        signatures = new bytes(96 * _depositsCount);
    }

    event Mock__onExitedAndStuckValidatorsCountsUpdated();

    bool private onExitedAndStuckValidatorsCountsUpdatedShouldRevert = false;
    bool private onExitedAndStuckValidatorsCountsUpdatedShouldRunOutGas = false;

    function onExitedAndStuckValidatorsCountsUpdated() external {
        require(!onExitedAndStuckValidatorsCountsUpdatedShouldRevert, "revert reason");

        if (onExitedAndStuckValidatorsCountsUpdatedShouldRunOutGas) {
            revert();
        }

        emit Mock__onExitedAndStuckValidatorsCountsUpdated();
    }

    function mock__onExitedAndStuckValidatorsCountsUpdated(bool shouldRevert, bool shouldRunOutGas) external {
        onExitedAndStuckValidatorsCountsUpdatedShouldRevert = shouldRevert;
        onExitedAndStuckValidatorsCountsUpdatedShouldRunOutGas = shouldRunOutGas;
    }

    event Mock__WithdrawalCredentialsChanged();

    bool private onWithdrawalCredentialsChangedShouldRevert = false;
    bool private onWithdrawalCredentialsChangedShouldRunOutGas = false;

    function onWithdrawalCredentialsChanged() external {
        require(!onWithdrawalCredentialsChangedShouldRevert, "revert reason");

        if (onWithdrawalCredentialsChangedShouldRunOutGas) {
            revert();
        }

        emit Mock__WithdrawalCredentialsChanged();
    }

    function mock__onWithdrawalCredentialsChanged(bool shouldRevert, bool shouldRunOutGas) external {
        onWithdrawalCredentialsChangedShouldRevert = shouldRevert;
        onWithdrawalCredentialsChangedShouldRunOutGas = shouldRunOutGas;
    }

    bool private shouldBePenalized__mocked;

    function reportValidatorExitDelay(
        uint256 _nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes calldata _publicKeys,
        uint256 _eligibleToExitInSec
    ) external {
        emit Mock__reportValidatorExitDelay(_nodeOperatorId, _proofSlotTimestamp, _publicKeys, _eligibleToExitInSec);
    }

    function onValidatorExitTriggered(
        uint256 _nodeOperatorId,
        bytes calldata _publicKeys,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) external {
        emit Mock__onValidatorExitTriggered(_nodeOperatorId, _publicKeys, _withdrawalRequestPaidFee, _exitType);
    }

    function isValidatorExitDelayPenaltyApplicable(
        uint256 _nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes calldata _publicKey,
        uint256 _eligibleToExitInSec
    ) external view returns (bool) {
        return shouldBePenalized__mocked;
    }

    function mock__isValidatorExitDelayPenaltyApplicable(bool _shouldBePenalized) external {
        shouldBePenalized__mocked = _shouldBePenalized;
    }

    uint256 private exitDeadlineThreshold__mocked;

    function exitDeadlineThreshold(uint256 _nodeOperatorId) external view returns (uint256) {
        return exitDeadlineThreshold__mocked;
    }

    function mock__exitDeadlineThreshold(uint256 _threshold) external {
        exitDeadlineThreshold__mocked = _threshold;
    }
}
