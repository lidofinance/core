// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// For full version see: https://github.com/lidofinance/community-staking-module/blob/develop/src/interfaces/ICSModule.sol
import { IStakingModule } from "contracts/0.8.9/interfaces/IStakingModule.sol";

pragma solidity 0.8.9;


struct NodeOperator {
    // All the counters below are used together e.g. in the _updateDepositableValidatorsCount
    /* 1 */ uint32 totalAddedKeys; // @dev increased and decreased when removed
    /* 1 */ uint32 totalWithdrawnKeys; // @dev only increased
    /* 1 */ uint32 totalDepositedKeys; // @dev only increased
    /* 1 */ uint32 totalVettedKeys; // @dev both increased and decreased
    /* 1 */ uint32 stuckValidatorsCount; // @dev both increased and decreased
    /* 1 */ uint32 depositableValidatorsCount; // @dev any value
    /* 1 */ uint32 targetLimit;
    /* 1 */ uint8 targetLimitMode;
    /* 2 */ uint32 totalExitedKeys; // @dev only increased except for the unsafe updates
    /* 2 */ uint32 enqueuedCount; // Tracks how many places are occupied by the node operator's keys in the queue.
    /* 2 */ address managerAddress;
    /* 3 */ address proposedManagerAddress;
    /* 4 */ address rewardAddress;
    /* 5 */ address proposedRewardAddress;
    /* 5 */ bool extendedManagerPermissions;
}

struct NodeOperatorManagementProperties {
    address managerAddress;
    address rewardAddress;
    bool extendedManagerPermissions;
}

/// @title Lido's Community Staking Module interface
interface ICSModule is IStakingModule
{
    error NodeOperatorDoesNotExist();
    error ZeroRewardAddress();

    /// @notice Gets node operator non-withdrawn keys
    /// @param nodeOperatorId ID of the node operator
    /// @return Non-withdrawn keys count
    function getNodeOperatorNonWithdrawnKeys(
        uint256 nodeOperatorId
    ) external view returns (uint256);

    /// @notice Returns the node operator by id
    /// @param nodeOperatorId Node Operator id
    function getNodeOperator(
        uint256 nodeOperatorId
    ) external view returns (NodeOperator memory);

    /// @notice Gets node operator signing keys
    /// @param nodeOperatorId ID of the node operator
    /// @param startIndex Index of the first key
    /// @param keysCount Count of keys to get
    /// @return Signing keys
    function getSigningKeys(
        uint256 nodeOperatorId,
        uint256 startIndex,
        uint256 keysCount
    ) external view returns (bytes memory);

    /// @notice Gets node operator signing keys with signatures
    /// @param nodeOperatorId ID of the node operator
    /// @param startIndex Index of the first key
    /// @param keysCount Count of keys to get
    /// @return keys Signing keys
    /// @return signatures Signatures of (deposit_message, domain) tuples
    function getSigningKeysWithSignatures(
        uint256 nodeOperatorId,
        uint256 startIndex,
        uint256 keysCount
    ) external view returns (bytes memory keys, bytes memory signatures);

    /// @notice Report node operator's key as slashed and apply initial slashing penalty.
    /// @param nodeOperatorId Operator ID in the module.
    /// @param keyIndex Index of the slashed key in the node operator's keys.
    function submitInitialSlashing(
        uint256 nodeOperatorId,
        uint256 keyIndex
    ) external;

    /// @notice Report node operator's key as withdrawn and settle withdrawn amount.
    /// @param nodeOperatorId Operator ID in the module.
    /// @param keyIndex Index of the withdrawn key in the node operator's keys.
    /// @param amount Amount of withdrawn ETH in wei.
    /// @param isSlashed Validator is slashed or not
    function submitWithdrawal(
        uint256 nodeOperatorId,
        uint256 keyIndex,
        uint256 amount,
        bool isSlashed
    ) external;

    function depositETH(uint256 nodeOperatorId) external payable;
}