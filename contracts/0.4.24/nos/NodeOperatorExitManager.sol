// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.4.24;

import {SafeMath} from "@aragon/os/contracts/lib/math/SafeMath.sol";
import {UnstructuredStorage} from "@aragon/os/contracts/common/UnstructuredStorage.sol";

interface IStETH {
    function getSharesByPooledEth(uint256 _ethAmount) external view returns (uint256);
    function getPooledEthByShares(uint256 _sharesAmount) external view returns (uint256);
}

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
    event PenaltyApplied(
        uint256 indexed nodeOperatorId,
        bytes publicKey,
        uint256 penaltyAmount,
        string penaltyType
    );
    event ExitDeadlineThresholdChanged(uint256 threshold);

    // Storage positions
    bytes32 internal constant EXIT_DEADLINE_THRESHOLD_POSITION = keccak256("lido.NodeOperatorExitManager.exitDeadlineThreshold");

    // Struct to store exit-related data for each validator
    struct ValidatorExitRecord {
        uint256 eligibleToExitInSec;
        uint256 pinalizedFee;
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
     * @param _exitDeadlineThreshold The number of seconds after which a validator is considered late
     */
    function _initializeNodeOperatorExitManager(uint256 _exitDeadlineThreshold) internal {
        EXIT_DEADLINE_THRESHOLD_POSITION.setStorageUint256(_exitDeadlineThreshold);
        emit ExitDeadlineThresholdChanged(_exitDeadlineThreshold);
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
        require(_publicKey.length > 0, "INVALID_PUBLIC_KEY");

        // Hash the public key to use as a mapping key
        bytes32 publicKeyHash = keccak256(_publicKey);

        // Track this validator key if it's new
        _ensureValidatorKeyTracked(_nodeOperatorId, publicKeyHash, _publicKey);

        // Get or initialize the validator exit record
        ValidatorExitRecord storage record = validatorExitRecords[_nodeOperatorId][publicKeyHash];

        // Update the record with the new data
        record.eligibleToExitInSec = _eligibleToExitInSec;
        record.lastUpdatedTimestamp = _proofSlotTimestamp;

        // Calculate penalty if the validator has exceeded the exit deadline
        if (_eligibleToExitInSec > _exitDeadlineThreshold(_nodeOperatorId)) {
            // Calculate penalty based on the excess time
            uint256 excessTime = _eligibleToExitInSec.sub(_exitDeadlineThreshold(_nodeOperatorId));
            uint256 penaltyAmount = _calculatePenalty(excessTime);

            // Add to the penalized fee
            record.pinalizedFee = record.pinalizedFee.add(penaltyAmount);

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
        bytes32 publicKeyHash = keccak256(_publicKey);

        // Track this validator key if it's new
        _ensureValidatorKeyTracked(_nodeOperatorId, publicKeyHash, _publicKey);

        // Get or initialize the validator exit record
        ValidatorExitRecord storage record = validatorExitRecords[_nodeOperatorId][publicKeyHash];

        // Set the triggerable exit fee
        record.triggerableExitFee = _withdrawalRequestPaidFee;

        emit TriggerableExitFeeSet(_nodeOperatorId, _publicKey, _withdrawalRequestPaidFee, _exitType);
    }

    /**
     * @notice Ensures a validator key is tracked in the operatorWatchableValidatorKeys array
     * @param _nodeOperatorId The node operator ID
     * @param _publicKeyHash Hash of the validator public key
     * @param _publicKey Original public key (for events)
     */
    function _ensureValidatorKeyTracked(
        uint256 _nodeOperatorId,
        bytes32 _publicKeyHash,
        bytes _publicKey
    ) internal {
        // Only add to tracking if this is a new record
        if (validatorExitRecords[_nodeOperatorId][_publicKeyHash].lastUpdatedTimestamp == 0) {
            operatorWatchableValidatorKeys[_nodeOperatorId].push(_publicKeyHash);
        }
    }

    /**
     * @notice Returns the number of seconds after which a validator is considered late
     * @param _nodeOperatorId The ID of the node operator
     * @return The exit deadline threshold in seconds
     */
    function _exitDeadlineThreshold(uint256 _nodeOperatorId) public view returns (uint256) {
        // Currently using a global threshold, but could be extended to support per-operator thresholds
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
        uint256 _nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes _publicKey,
        uint256 _eligibleToExitInSec
    ) internal view returns (bool) {
        bytes32 publicKeyHash = keccak256(_publicKey);

        // Check if record exists, otherwise it's a new record and should be updated
        ValidatorExitRecord storage record = validatorExitRecords[_nodeOperatorId][publicKeyHash];
        bool recordExists = record.lastUpdatedTimestamp > 0;

        if (!recordExists) {
            return true;
        }

        // If the validator has exceeded the exit deadline, it should be penalized
        if (_eligibleToExitInSec > _exitDeadlineThreshold(_nodeOperatorId)) {
            return true;
        }

        // If the validator's exit status has changed, it should be updated
        if (_eligibleToExitInSec != record.eligibleToExitInSec) {
            return true;
        }

        // If proof timestamp is newer than last updated, it should be updated
        if (_proofSlotTimestamp > record.lastUpdatedTimestamp) {
            return true;
        }

        return false;
    }

    /**
     * @notice Get the exit record for a validator using its public key hash
     * @param _nodeOperatorId The ID of the node operator
     * @param _publicKeyHash Hash of the validator's public key
     * @return Record data: eligibleToExitInSec, pinalizedFee, triggerableExitFee, lastUpdatedTimestamp
     */
    function _getValidatorExitRecordByHash(
        uint256 _nodeOperatorId,
        bytes32 _publicKeyHash
    ) internal view returns (uint256, uint256, uint256, uint256) {
        ValidatorExitRecord storage record = validatorExitRecords[_nodeOperatorId][_publicKeyHash];
        require(record.lastUpdatedTimestamp > 0, "VALIDATOR_RECORD_NOT_FOUND");

        return (
            record.eligibleToExitInSec,
            record.pinalizedFee,
            record.triggerableExitFee,
            record.lastUpdatedTimestamp
        );
    }

    /**
     * @notice Get the exit record for a validator using its public key
     * @param _nodeOperatorId The ID of the node operator
     * @param _publicKey The public key of the validator
     * @return Record data: eligibleToExitInSec, pinalizedFee, triggerableExitFee, lastUpdatedTimestamp
     */
    function _getValidatorExitRecord(
        uint256 _nodeOperatorId,
        bytes _publicKey
    ) internal view returns (uint256, uint256, uint256, uint256) {
        require(_publicKey.length > 0, "INVALID_PUBLIC_KEY");
        bytes32 publicKeyHash = keccak256(_publicKey);

        return _getValidatorExitRecordByHash(_nodeOperatorId, publicKeyHash);
    }

    /**
     * @notice Helper function to calculate penalty based on excess time
     * @param _excessTime Time in seconds beyond the exit deadline
     * @return Penalty amount in ETH
     */
    function _calculatePenalty(uint256 _excessTime) internal pure returns (uint256) {
        // TODO: get the penalty rate from analytics team
        return _excessTime.mul(1 ether).div(86400);
    }

    /**
     * @notice Apply penalties to an operator's rewards using public key hash
     * @param _nodeOperatorId The ID of the node operator
     * @param _publicKeyHash Hash of the validator's public key
     * @param _stETH Interface to the stETH token
     * @param _shares Amount of shares being distributed to the operator
     * @return Adjusted shares after penalties
     */
    function _applyPenaltiesByHash(
        uint256 _nodeOperatorId,
        bytes32 _publicKeyHash,
        IStETH _stETH,
        uint256 _shares
    ) internal returns (uint256) {
        // Check if record exists before attempting to apply penalties
        ValidatorExitRecord storage record = validatorExitRecords[_nodeOperatorId][_publicKeyHash];
        if (record.lastUpdatedTimestamp == 0) {
            return _shares;
        }

        // If there are no penalties, return the original shares
        if (record.pinalizedFee == 0 && record.triggerableExitFee == 0) {
            return _shares;
        }

        uint256 remainingShares = _shares;

        // Apply penalties for exceeding exit deadline
        if (record.pinalizedFee > 0) {
            uint256 pinalizedShares = _stETH.getSharesByPooledEth(record.pinalizedFee);

            if (pinalizedShares >= remainingShares) {
                // Not enough shares to cover the full penalty
                record.pinalizedFee = record.pinalizedFee.sub(
                    _stETH.getPooledEthByShares(remainingShares)
                );
                remainingShares = 0;
            } else {
                // Enough shares to cover the penalty
                remainingShares = remainingShares.sub(pinalizedShares);
                record.pinalizedFee = 0;
                record.isPenalized = true;
            }
        }


        // Apply penalties for triggerable exit fees
        if (remainingShares > 0 && record.triggerableExitFee > 0) {
            uint256 triggerableShares = _stETH.getSharesByPooledEth(record.triggerableExitFee);

            if (triggerableShares >= remainingShares) {
                // Not enough shares to cover the full fee
                record.triggerableExitFee = record.triggerableExitFee.sub(
                    _stETH.getPooledEthByShares(remainingShares)
                );
                remainingShares = 0;
            } else {
                // Enough shares to cover the fee
                remainingShares = remainingShares.sub(triggerableShares);
                record.triggerableExitFee = 0;
                record.isExited = true;
            }
        }

        return remainingShares;
    }

    /**
     * @notice Apply penalties to an operator's rewards using public key
     * @param _nodeOperatorId The ID of the node operator
     * @param _publicKey The public key of the validator
     * @param _stETH Interface to the stETH token
     * @param _shares Amount of shares being distributed to the operator
     * @return Adjusted shares after penalties
     */
    function _applyPenalties(
        uint256 _nodeOperatorId,
        bytes _publicKey,
        IStETH _stETH,
        uint256 _shares
    ) internal returns (uint256) {
        require(_publicKey.length > 0, "INVALID_PUBLIC_KEY");
        bytes32 publicKeyHash = keccak256(_publicKey);

        return _applyPenaltiesByHash(_nodeOperatorId, publicKeyHash, _stETH, _shares);
    }

    /**
     * @notice Apply penalties to all validators of an operator
     * @param _nodeOperatorId The ID of the node operator
     * @param _stETH Interface to the stETH token
     * @param _shares Amount of shares being distributed to the operator
     * @return Adjusted shares after penalties
     */
    function _applyAllPenalties(
        uint256 _nodeOperatorId,
        IStETH _stETH,
        uint256 _shares
    ) internal returns (uint256) {
        uint256 remainingShares = _shares;
        bytes32[] storage validatorKeys = operatorValidatorKeys[_nodeOperatorId];

        // Iterate through all validator keys for this operator
        for (uint256 i = 0; i < validatorKeys.length; i++) {
            remainingShares = _applyPenaltiesByHash(
                _nodeOperatorId,
                validatorKeys[i],
                _stETH,
                remainingShares
            );

            if (remainingShares == 0) break;
        }
        // Clean up completed validators from the watchable keys array
        // TODO: combine with _applyPenaltiesByHash to avoid double iteration
        _cleanupCompletedValidators(_nodeOperatorId);

        return remainingShares;
    }

     /**
     * @notice Clean up validators that have completed processing from the watchable keys array
     * @param _nodeOperatorId The ID of the node operator
     */
    function _cleanupCompletedValidators(uint256 _nodeOperatorId) internal {
        bytes32[] storage watchableKeys = operatorWatchableValidatorKeys[_nodeOperatorId];
        uint256 i = 0;

        while (i < watchableKeys.length) {
            ValidatorExitRecord storage record = validatorExitRecords[_nodeOperatorId][watchableKeys[i]];

            if (record.isPenalized && record.isExited) {
                // If both conditions are met, remove from watchable keys by swapping with the last element
                watchableKeys[i] = watchableKeys[watchableKeys.length - 1];
                watchableKeys.length--;
                // Don't increment i as we need to process the swapped element
            } else {
                // Move to next key
                i++;
            }
        }
    }

    /**
     * @notice Check if a validator exit record exists using key hash
     * @param _nodeOperatorId The ID of the node operator
     * @param _publicKeyHash Hash of the validator public key
     * @return True if record exists
     */
    function _validatorExitRecordExistsByHash(
        uint256 _nodeOperatorId,
        bytes32 _publicKeyHash
    ) internal view returns (bool) {
        return validatorExitRecords[_nodeOperatorId][_publicKeyHash].lastUpdatedTimestamp > 0;
    }

    /**
     * @notice Check if a validator exit record exists
     * @param _nodeOperatorId The ID of the node operator
     * @param _publicKey The public key of the validator
     * @return True if record exists
     */
    function _validatorExitRecordExists(
        uint256 _nodeOperatorId,
        bytes _publicKey
    ) internal view returns (bool) {
        require(_publicKey.length > 0, "INVALID_PUBLIC_KEY");
        bytes32 publicKeyHash = keccak256(_publicKey);

        return _validatorExitRecordExistsByHash(_nodeOperatorId, publicKeyHash);
    }

    /**
     * @notice Get the count of validators with exit records for a node operator
     * @param _nodeOperatorId The ID of the node operator
     * @return Count of validators with exit records
     */
    function _getValidatorExitRecordCount(uint256 _nodeOperatorId) internal view returns (uint256) {
        return operatorWatchableValidatorKeys[_nodeOperatorId].length;
    }
}
