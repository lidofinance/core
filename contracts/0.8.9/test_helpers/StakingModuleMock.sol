// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {Math256} from "../../common/lib/Math256.sol";
import {IStakingModule} from "../interfaces/IStakingModule.sol";

contract StakingModuleMock is IStakingModule {
    uint256 internal _exitedValidatorsCount;
    uint256 private _activeValidatorsCount;
    uint256 private _availableValidatorsCount;
    uint256 private _nonce;
    uint256 private nodeOperatorsCount;

    function getActiveValidatorsCount() public view returns (uint256) {
        return _activeValidatorsCount;
    }

    function getAvailableValidatorsCount() public view returns (uint256) {
        return _availableValidatorsCount;
    }

    function getType() external view returns (bytes32) {}

    function getStakingModuleSummary() external view returns (
        uint256 totalExitedValidators,
        uint256 totalDepositedValidators,
        uint256 depositableValidatorsCount
    ) {
        totalExitedValidators = _exitedValidatorsCount;
        totalDepositedValidators = _exitedValidatorsCount + _activeValidatorsCount;
        depositableValidatorsCount = _availableValidatorsCount;
    }

    struct NodeOperatorSummary {
        bool isTargetLimitActive;
        uint256 targetValidatorsCount;
        uint256 stuckValidatorsCount;
        uint256 refundedValidatorsCount;
        uint256 stuckPenaltyEndTimestamp;
        uint256 totalExitedValidators;
        uint256 totalDepositedValidators;
        uint256 depositableValidatorsCount;
    }
    mapping(uint256 => NodeOperatorSummary) internal nodeOperatorsSummary;
    function getNodeOperatorSummary(uint256 _nodeOperatorId) external view returns (
        bool isTargetLimitActive,
        uint256 targetValidatorsCount,
        uint256 stuckValidatorsCount,
        uint256 refundedValidatorsCount,
        uint256 stuckPenaltyEndTimestamp,
        uint256 totalExitedValidators,
        uint256 totalDepositedValidators,
        uint256 depositableValidatorsCount
    ) {
        NodeOperatorSummary storage _summary = nodeOperatorsSummary[_nodeOperatorId];
        isTargetLimitActive = _summary.isTargetLimitActive;
        targetValidatorsCount = _summary.targetValidatorsCount;
        stuckValidatorsCount = _summary.stuckValidatorsCount;
        refundedValidatorsCount = _summary.refundedValidatorsCount;
        stuckPenaltyEndTimestamp = _summary.stuckPenaltyEndTimestamp;
        totalExitedValidators = _summary.totalExitedValidators;
        totalDepositedValidators = _summary.totalDepositedValidators;
        depositableValidatorsCount = _summary.depositableValidatorsCount;
    }
    function setNodeOperatorSummary(uint256 _nodeOperatorId, NodeOperatorSummary memory _summary) external {
        NodeOperatorSummary storage summary = nodeOperatorsSummary[_nodeOperatorId];
        summary.isTargetLimitActive = _summary.isTargetLimitActive;
        summary.targetValidatorsCount = _summary.targetValidatorsCount;
        summary.stuckValidatorsCount = _summary.stuckValidatorsCount;
        summary.refundedValidatorsCount = _summary.refundedValidatorsCount;
        summary.stuckPenaltyEndTimestamp = _summary.stuckPenaltyEndTimestamp;
        summary.totalExitedValidators = _summary.totalExitedValidators;
        summary.totalDepositedValidators = _summary.totalDepositedValidators;
        summary.depositableValidatorsCount = _summary.depositableValidatorsCount;
    }

    function getNonce() external view returns (uint256) {
        return _nonce;
    }

    function setNonce(uint256 _newNonce) external {
        _nonce = _newNonce;
    }

    function getNodeOperatorsCount() public view returns (uint256) { return nodeOperatorsCount; }

    function testing_setNodeOperatorsCount(uint256 _count) external {
        nodeOperatorsCount = _count;
    }

    function getActiveNodeOperatorsCount() external view returns (uint256) {}

    function getNodeOperatorIsActive(uint256 _nodeOperatorId) external view returns (bool) {}

    function getNodeOperatorIds(uint256 _offset, uint256 _limit)
        external
        view
        returns (uint256[] memory nodeOperatorIds) {
        uint256 nodeOperatorsCount = getNodeOperatorsCount();
        if (_offset < nodeOperatorsCount && _limit != 0) {
            nodeOperatorIds = new uint256[](Math256.min(_limit, nodeOperatorsCount - _offset));
            for (uint256 i = 0; i < nodeOperatorIds.length; ++i) {
                nodeOperatorIds[i] = _offset + i;
            }
        }

    }

    /// @dev onRewardsMinted mock
    // solhint-disable-next-line
    struct Call_onRewardsMinted {
        uint256 callCount;
        uint256 totalShares;
    }
    Call_onRewardsMinted public lastCall_onRewardsMinted;
    function onRewardsMinted(uint256 _totalShares) external {
        lastCall_onRewardsMinted.totalShares += _totalShares;
        ++lastCall_onRewardsMinted.callCount;
    }

    // solhint-disable-next-line
    struct Call_updateValidatorsCount {
        bytes nodeOperatorIds;
        bytes validatorsCounts;
        uint256 callCount;
    }

    Call_updateValidatorsCount public lastCall_updateStuckValidatorsCount;
    Call_updateValidatorsCount public lastCall_updateExitedValidatorsCount;

    function updateStuckValidatorsCount(
        bytes calldata _nodeOperatorIds,
        bytes calldata _stuckValidatorsCounts
    ) external {
        lastCall_updateStuckValidatorsCount.nodeOperatorIds = _nodeOperatorIds;
        lastCall_updateStuckValidatorsCount.validatorsCounts = _stuckValidatorsCounts;
        ++lastCall_updateStuckValidatorsCount.callCount;
    }

    function updateExitedValidatorsCount(
        bytes calldata _nodeOperatorIds,
        bytes calldata _exitedValidatorsCounts
    ) external {
        lastCall_updateExitedValidatorsCount.nodeOperatorIds = _nodeOperatorIds;
        lastCall_updateExitedValidatorsCount.validatorsCounts = _exitedValidatorsCounts;
        ++lastCall_updateExitedValidatorsCount.callCount;
    }

    // solhint-disable-next-line
    struct Call_updateRefundedValidatorsCount {
        uint256 nodeOperatorId;
        uint256 refundedValidatorsCount;
        uint256 callCount;
    }
    Call_updateRefundedValidatorsCount public lastCall_updateRefundedValidatorsCount;
    function updateRefundedValidatorsCount(uint256 _nodeOperatorId, uint256 _refundedValidatorsCount) external {
        lastCall_updateRefundedValidatorsCount.nodeOperatorId = _nodeOperatorId;
        lastCall_updateRefundedValidatorsCount.refundedValidatorsCount = _refundedValidatorsCount;
        ++lastCall_updateRefundedValidatorsCount.callCount;
    }

    // solhint-disable-next-line
    struct Call_updateTargetValidatorsLimits {
        uint256 nodeOperatorId;
        bool isTargetLimitActive;
        uint256 targetLimit;
        uint256 callCount;
    }

    Call_updateTargetValidatorsLimits public lastCall_updateTargetValidatorsLimits;
    function updateTargetValidatorsLimits(
        uint256 _nodeOperatorId,
        bool _isTargetLimitActive,
        uint256 _targetLimit
    ) external {
        lastCall_updateTargetValidatorsLimits.nodeOperatorId = _nodeOperatorId;
        lastCall_updateTargetValidatorsLimits.isTargetLimitActive = _isTargetLimitActive;
        lastCall_updateTargetValidatorsLimits.targetLimit = _targetLimit;
        ++lastCall_updateTargetValidatorsLimits.callCount;
    }

    uint256 public callCount_onExitedAndStuckValidatorsCountsUpdated;

    function onExitedAndStuckValidatorsCountsUpdated() external {
        ++callCount_onExitedAndStuckValidatorsCountsUpdated;
    }

    // solhint-disable-next-line
    struct Call_unsafeUpdateValidatorsCount {
        uint256 nodeOperatorId;
        uint256 exitedValidatorsKeysCount;
        uint256 stuckValidatorsKeysCount;
        uint256 callCount;
    }
    Call_unsafeUpdateValidatorsCount public lastCall_unsafeUpdateValidatorsCount;
    function unsafeUpdateValidatorsCount(
        uint256 _nodeOperatorId,
        uint256 _exitedValidatorsKeysCount,
        uint256 _stuckValidatorsKeysCount
    ) external {
        lastCall_unsafeUpdateValidatorsCount.nodeOperatorId = _nodeOperatorId;
        lastCall_unsafeUpdateValidatorsCount.exitedValidatorsKeysCount = _exitedValidatorsKeysCount;
        lastCall_unsafeUpdateValidatorsCount.stuckValidatorsKeysCount = _stuckValidatorsKeysCount;
        ++lastCall_unsafeUpdateValidatorsCount.callCount;
    }

    function onWithdrawalCredentialsChanged() external {
        _availableValidatorsCount = _activeValidatorsCount;
    }

    function obtainDepositData(uint256 _depositsCount, bytes calldata)
        external
        returns (
            bytes memory publicKeys,
            bytes memory signatures
        )
    {
        publicKeys = new bytes(48 * _depositsCount);
        signatures = new bytes(96 * _depositsCount);
    }

    function setTotalExitedValidatorsCount(uint256 newExitedValidatorsCount) external {
        _exitedValidatorsCount = newExitedValidatorsCount;
    }

    function setActiveValidatorsCount(uint256 _newActiveValidatorsCount) external {
        _activeValidatorsCount = _newActiveValidatorsCount;
    }

    function setAvailableKeysCount(uint256 _newAvailableValidatorsCount) external {
        _availableValidatorsCount = _newAvailableValidatorsCount;
    }
}
