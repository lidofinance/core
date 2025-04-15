// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.4.24;

/**
 * @title NodeOperatorExitManager
 * @notice Mock version: only event interfaces and signatures, logic removed
 */
contract NodeOperatorExitManager {

    event ValidatorExitStatusUpdated(
        uint256 indexed nodeOperatorId,
        bytes publicKey,
        uint256 eligibleToExitInSec,
        uint256 proofSlotTimestamp
    );
    event TriggerableExitFeeSet(
        uint256 indexed nodeOperatorId,
        bytes publicKey,
        uint256 withdrawalRequestPaidFee,
        uint256 exitType
    );
    event PenaltyApplied(uint256 indexed nodeOperatorId, bytes publicKey, uint256 penaltyAmount, string penaltyType);
    event ExitDeadlineThresholdChanged(uint256 threshold);

    struct ValidatorExitRecord {
        uint256 eligibleToExitInSec;
        uint256 penalizedFee;
        uint256 triggerableExitFee;
        uint256 lastUpdatedTimestamp;
        bool isPenalized;
        bool isExited;
    }

    function _initializeNodeOperatorExitManager(uint256 _getExitDeadlineThreshold) internal {
        emit ExitDeadlineThresholdChanged(_getExitDeadlineThreshold);
    }

    function _setExitDeadlineThreshold(uint256 _threshold) internal {
        emit ExitDeadlineThresholdChanged(_threshold);
    }

    function _handleActiveValidatorsExitingStatus(
        uint256 _nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes _publicKey,
        uint256 _eligibleToExitInSec
    ) internal {
        require(_eligibleToExitInSec >= 0, "INVALID_EXIT_TIME"); // placeholder check
        require(_publicKey.length > 0, "INVALID_PUBLIC_KEY");

        emit PenaltyApplied(_nodeOperatorId, _publicKey, 1 ether, "EXCESS_EXIT_TIME");
        emit ValidatorExitStatusUpdated(_nodeOperatorId, _publicKey, _eligibleToExitInSec, _proofSlotTimestamp);
    }

    function _onTriggerableExit(
        uint256 _nodeOperatorId,
        bytes _publicKey,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) internal {
        require(_publicKey.length > 0, "INVALID_PUBLIC_KEY");

        emit TriggerableExitFeeSet(_nodeOperatorId, _publicKey, _withdrawalRequestPaidFee, _exitType);
    }

    function _getExitDeadlineThreshold() public view returns (uint256) {
        return 60 * 60 * 24 * 2; // 2 days
    }

    function _shouldValidatorBePenalized(
        uint256, // _nodeOperatorId
        uint256, // _proofSlotTimestamp
        bytes, // _publicKey
        uint256 _eligibleToExitInSec
    ) internal view returns (bool) {
        return _eligibleToExitInSec >= _getExitDeadlineThreshold();
    }

    function _getPenalty() internal pure returns (uint256) {
        return 1 ether;
    }
}
