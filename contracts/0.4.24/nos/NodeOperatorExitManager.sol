// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.4.24;

import {SafeMath} from "@aragon/os/contracts/lib/math/SafeMath.sol";
import {UnstructuredStorage} from "@aragon/os/contracts/common/UnstructuredStorage.sol";

/**
 * @title NodeOperatorExitManager
 * @notice Base contract for handling triggerable withdrawals and penalties for validators
 */
contract NodeOperatorExitManager {
    using SafeMath for uint256;
    using UnstructuredStorage for bytes32;

    // Events
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

    // Storage positions
    bytes32 internal constant EXIT_DEADLINE_THRESHOLD_POSITION =
        keccak256("lido.NodeOperatorExitManager.exitDeadlineThreshold");

    // Struct to store exit-related data for each validator
    struct ValidatorExitRecord {
        uint256 eligibleToExitInSec;
        uint256 penalizedFee;
        uint256 triggerableExitFee;
        uint256 lastUpdatedTimestamp;
        bool isPenalized;
        bool isExited;
    }

    // Mapping from operator ID to mapping from validator public key hash to exit record
    mapping(uint256 => mapping(bytes32 => ValidatorExitRecord)) internal validatorExitRecords;

    // Mapping to store all validator key hashes for each operator
    mapping(uint256 => bytes32[]) internal operatorWatchableValidatorKeys;

    /**
     * @notice Initialize the contract with a default exit deadline threshold
     * @param _getExitDeadlineThreshold The number of seconds after which a validator is considered late
     */
    function _initializeNodeOperatorExitManager(uint256 _getExitDeadlineThreshold) internal {
        EXIT_DEADLINE_THRESHOLD_POSITION.setStorageUint256(_getExitDeadlineThreshold);
        emit ExitDeadlineThresholdChanged(_getExitDeadlineThreshold);
    }

    /**
     * @notice Set the exit deadline threshold
     * @param _threshold New threshold in seconds
     */
    function _setExitDeadlineThreshold(uint256 _threshold) internal {
        EXIT_DEADLINE_THRESHOLD_POSITION.setStorageUint256(_threshold);
        emit ExitDeadlineThresholdChanged(_threshold);
    }

    /**
     * @notice Handles tracking and penalization logic for a validator that remains active beyond its eligible exit window
     * @param _nodeOperatorId The ID of the node operator whose validator's status is being delivered
     * @param _proofSlotTimestamp The timestamp when the validator was last known to be in an active ongoing state
     * @param _publicKey The public key of the validator being reported
     * @param _eligibleToExitInSec The duration (in seconds) indicating how long the validator has been eligible to exit
     */
    function _handleActiveValidatorsExitingStatus(
        uint256 _nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes _publicKey,
        uint256 _eligibleToExitInSec
    ) internal {
        require(_eligibleToExitInSec >= _getExitDeadlineThreshold(), "INVALID_EXIT_TIME");
        require(_publicKey.length > 0, "INVALID_PUBLIC_KEY");

        // Hash the public key to use as a mapping key
        bytes32 publicKeyHash = keccak256(_publicKey);

        // Track this validator key if it's new
        if (validatorExitRecords[_nodeOperatorId][_publicKeyHash].lastUpdatedTimestamp == 0) {
            operatorWatchableValidatorKeys[_nodeOperatorId].push(_publicKeyHash);
        }

        // Get or initialize the validator exit record
        ValidatorExitRecord storage record = validatorExitRecords[_nodeOperatorId][publicKeyHash];

        // Update the record with the new data
        record.eligibleToExitInSec = _eligibleToExitInSec;
        record.lastUpdatedTimestamp = _proofSlotTimestamp;

        // Calculate penalty if the validator has exceeded the exit deadline
        if (record.penalizedFee == 0) {
            uint256 penaltyAmount = _getPenalty();

            // Add to the penalized fee
            record.penalizedFee = record.penalizedFee.add(penaltyAmount);

            emit PenaltyApplied(_nodeOperatorId, _publicKey, penaltyAmount, "EXCESS_EXIT_TIME");
        }

        emit ValidatorExitStatusUpdated(_nodeOperatorId, _publicKey, _eligibleToExitInSec, _proofSlotTimestamp);
    }

    /**
     * @notice Handles the triggerable exit event for a validator
     * @param _nodeOperatorId The ID of the node operator
     * @param _publicKey The public key of the validator being reported
     * @param _withdrawalRequestPaidFee Fee amount paid to send a withdrawal request on the EL
     * @param _exitType The type of exit being performed
     */
    function _onTriggerableExit(
        uint256 _nodeOperatorId,
        bytes _publicKey,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) internal {
        require(_publicKey.length > 0, "INVALID_PUBLIC_KEY");

        // Hash the public key to use as a mapping key
        bytes32 _publicKeyHash = keccak256(_publicKey);

        // Get or initialize the validator exit record
        ValidatorExitRecord storage record = validatorExitRecords[_nodeOperatorId][_publicKeyHash];
        require(record.lastUpdatedTimestamp > 0, "VALIDATOR_RECORD_NOT_FOUND");

        // Set the triggerable exit fee
        // TODO: validation?
        record.triggerableExitFee = _withdrawalRequestPaidFee;

        emit TriggerableExitFeeSet(_nodeOperatorId, _publicKey, _withdrawalRequestPaidFee, _exitType);
    }

    /**
     * @notice Returns the number of seconds after which a validator is considered late
     * @return The exit deadline threshold in seconds
     */
    function _getExitDeadlineThreshold() public view returns (uint256) {
        return EXIT_DEADLINE_THRESHOLD_POSITION.getStorageUint256();
    }

    /**
     * @notice Determines whether a validator's exit status should be updated
     * @param _nodeOperatorId The ID of the node operator
     * @param _proofSlotTimestamp The timestamp when the validator was last known to be active
     * @param _publicKey The public key of the validator
     * @param _eligibleToExitInSec The number of seconds the validator was eligible to exit
     * @return bool Returns true if the contract should receive the updated status
     */
    function _shouldValidatorBePenalized(
        uint256, // _nodeOperatorId,
        uint256, // _proofSlotTimestamp,
        bytes, // _publicKey,
        uint256 _eligibleToExitInSec
    ) internal view returns (bool) {
        // If the validator has exceeded the exit deadline, it should be penalized
        return _eligibleToExitInSec >= _getExitDeadlineThreshold();
    }

    /**
     * @notice Helper function to calculate penalty based on excess time
     * @return Penalty amount in stETH
     */
    function _getPenalty() internal pure returns (uint256) {
        // TODO: get the penalty rate from analytics team
        return 1 ether;
    }

    /**
     * @notice Apply penalties to an operator's rewards using public key hash
     * @param _nodeOperatorId The ID of the node operator
     * @param _publicKeyHash Hash of the validator's public key
     * @param _sharesInStETH Amount of shares being distributed to the operator in stETH
     * @return Adjusted shares after penalties
     */
    function _applyPenaltiesByHash(
        uint256 _nodeOperatorId,
        bytes32 _publicKeyHash,
        uint256 _sharesInStETH
    ) internal returns (uint256, bool) {
        ValidatorExitRecord storage record = validatorExitRecords[_nodeOperatorId][_publicKeyHash];

        if (record.lastUpdatedTimestamp == 0) {
            return (_sharesInStETH, false);
        }

        uint256 remainingSharesInStETH = _sharesInStETH;

        if (record.penalizedFee > 0) {
            if (record.penalizedFee > remainingSharesInStETH) {
                record.penalizedFee = record.penalizedFee.sub(remainingSharesInStETH);
                remainingSharesInStETH = 0;
            } else {
                remainingSharesInStETH = remainingSharesInStETH.sub(record.penalizedFee);
                record.penalizedFee = 0;
                record.isPenalized = true;
            }
        }

        if (remainingSharesInStETH > 0 && record.triggerableExitFee > 0) {
            if (record.triggerableExitFee > remainingSharesInStETH) {
                record.triggerableExitFee = record.triggerableExitFee.sub(remainingSharesInStETH);
                remainingSharesInStETH = 0;
            } else {
                remainingSharesInStETH = remainingSharesInStETH.sub(record.triggerableExitFee);
                record.triggerableExitFee = 0;
                record.isExited = true;
            }
        }

        bool completed = record.isPenalized && record.isExited;
        return (remainingSharesInStETH, completed);
    }

    /**
     * @notice Apply penalties to all validators of an operator
     * @param _nodeOperatorId The ID of the node operator
     * @param _sharesInStETH Amount of shares being distributed to the operator
     * @return Adjusted shares after penalties
     */
    function _applyAllPenalties(uint256 _nodeOperatorId, uint256 _sharesInStETH) internal returns (uint256) {
        uint256 remainingSharesInStETH = _sharesInStETH;
        bytes32[] storage validatorKeys = operatorWatchableValidatorKeys[_nodeOperatorId];
        uint256 i = 0;

        while (i < validatorKeys.length) {
            bytes32 key = validatorKeys[i];

            (uint256 updatedShares, bool completed) = _applyPenaltiesByHash(
                _nodeOperatorId,
                key,
                remainingSharesInStETH
            );
            remainingSharesInStETH = updatedShares;

            if (completed) {
                validatorKeys[i] = validatorKeys[validatorKeys.length - 1];
                validatorKeys.length--;
            } else {
                i++;
            }

            if (remainingSharesInStETH == 0) {
                break;
            }
        }

        return remainingSharesInStETH;
    }
}
