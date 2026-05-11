// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {
    AccessControlEnumerableUpgradeable
} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

import {IPredepositGuarantee} from "contracts/0.8.25/vaults/interfaces/IPredepositGuarantee.sol";

interface IConsolidationGateway {
    struct ConsolidationWitnessGroup {
        bytes[] sourcePubkeys;
        IPredepositGuarantee.ValidatorWitness targetWitness;
    }

    function addConsolidationRequests(
        ConsolidationWitnessGroup[] calldata groups,
        address refundRecipient
    ) external payable;
}

/**
 * @title ConsolidationBus
 * @notice Message Bus for consolidation requests that decouples request submission from fee payment.
 *
 * The workflow:
 * 1. Admins register/unregister publishers via grant/revoke PUBLISH_ROLE
 * 2. Registered publishers add consolidation requests (PUBLISH_ROLE)
 * 3. Executor bot executes batches, paying the required ETH fee
 *    The bus forwards the batch to ConsolidationGateway
 * 4. Optional REMOVE_ROLE can remove batches from the pending queue
 */
contract ConsolidationBus is AccessControlEnumerableUpgradeable {
    uint256 internal constant PUBKEY_LENGTH = 48;

    /**
     * @notice Thrown when an invalid zero value is passed
     * @param name Name of the argument that was zero
     */
    error ZeroArgument(string name);

    /**
     * @notice Thrown when attempting to set the admin address to zero
     */
    error AdminCannotBeZero();

    /**
     * @notice Thrown when batch is empty
     */
    error EmptyBatch();

    /**
     * @notice Thrown when attempting to remove an empty list of batch hashes
     */
    error EmptyBatchHashes();

    /**
     * @notice Thrown when a source group has zero elements
     * @param groupIndex Index of the empty group
     */
    error EmptyGroup(uint256 groupIndex);

    /**
     * @notice Thrown when batch size exceeds the limit
     * @param size Actual batch size
     * @param limit Maximum allowed batch size
     */
    error BatchTooLarge(uint256 size, uint256 limit);

    /**
     * @notice Thrown when the number of groups in a batch exceeds the limit
     * @param groupsCount Actual number of groups
     * @param limit Maximum allowed number of groups
     */
    error TooManyGroups(uint256 groupsCount, uint256 limit);

    /**
     * @notice Thrown when maxGroupsInBatch exceeds batchSize
     * @param maxGroupsInBatch The max groups in batch value
     * @param batchSizeLimit The batch size limit value
     */
    error MaxGroupsExceedsBatchSize(uint256 maxGroupsInBatch, uint256 batchSizeLimit);

    /**
     * @notice Thrown when attempting to add a batch that is already pending execution
     * @param batchHash Hash of the batch that already exists in the pending queue
     */
    error BatchAlreadyPending(bytes32 batchHash);

    /**
     * @notice Thrown when batch is not found in storage
     * @param batchHash Hash of the missing batch
     */
    error BatchNotFound(bytes32 batchHash);

    /**
     * @notice Thrown when source and target pubkeys are the same
     * @param index Index of the invalid pair in the batch
     */
    error SourceEqualsTarget(uint256 index);

    /**
     * @notice Thrown when target pubkey length is invalid
     * @param groupIndex Index of the group with invalid target pubkey
     * @param length Actual pubkey length in bytes
     */
    error InvalidTargetPubkeyLength(uint256 groupIndex, uint256 length);

    /**
     * @notice Thrown when source pubkey length is invalid
     * @param groupIndex Index of the group with invalid source pubkey
     * @param sourceIndex Index of the source pubkey inside the group
     * @param length Actual pubkey length in bytes
     */
    error InvalidSourcePubkeyLength(uint256 groupIndex, uint256 sourceIndex, uint256 length);

    /**
     * @notice Thrown when attempting to execute a batch before the execution delay has passed
     * @param currentTime Current block timestamp
     * @param executeAfter Earliest timestamp at which the batch can be executed
     */
    error ExecutionDelayNotPassed(uint256 currentTime, uint256 executeAfter);

    /**
     * @notice Emitted when the batch size limit is updated
     * @param newLimit New batch size limit
     */
    event BatchLimitUpdated(uint256 newLimit);

    /**
     * @notice Emitted when the max groups in batch limit is updated
     * @param newLimit New max groups in batch limit
     */
    event MaxGroupsInBatchUpdated(uint256 newLimit);

    /**
     * @notice Emitted when consolidation requests are added
     * @param publisher Address of the publisher who added the requests
     * @param batchData Encoded batch data (abi.encode(groups))
     */
    event RequestsAdded(address indexed publisher, bytes batchData);

    /**
     * @notice Emitted when consolidation requests are executed
     * @param batchHash Hash of the executed batch
     * @param feePaid Amount of ETH paid for the execution
     */
    event RequestsExecuted(bytes32 indexed batchHash, uint256 feePaid);

    /**
     * @notice Emitted when batches are removed
     * @param batchHashes Array of removed batch hashes
     */
    event BatchesRemoved(bytes32[] batchHashes);

    /**
     * @notice Emitted when the execution delay is updated
     * @param newDelay New execution delay in seconds
     */
    event ExecutionDelayUpdated(uint256 newDelay);

    bytes32 public constant MANAGE_ROLE = keccak256("MANAGE_ROLE");
    bytes32 public constant PUBLISH_ROLE = keccak256("PUBLISH_ROLE");
    bytes32 public constant REMOVE_ROLE = keccak256("REMOVE_ROLE");

    struct ConsolidationGroup {
        bytes[] sourcePubkeys;
        bytes targetPubkey;
    }

    struct BatchInfo {
        address publisher;
        uint64 addedAt;
    }

    IConsolidationGateway internal immutable CONSOLIDATION_GATEWAY;

    uint256 internal _batchSize;
    uint256 internal _maxGroupsInBatch;
    uint256 internal _executionDelay;
    mapping(bytes32 batchHash => BatchInfo info) internal _pendingBatches;

    constructor(address consolidationGateway) {
        if (consolidationGateway == address(0)) revert ZeroArgument("consolidationGateway");

        CONSOLIDATION_GATEWAY = IConsolidationGateway(consolidationGateway);

        _disableInitializers();
    }

    /// @notice Initializes the contract.
    /// @param admin Lido DAO Aragon agent contract address.
    /// @dev Proxy initialization method.
    function initialize(
        address admin,
        uint256 initialBatchSize,
        uint256 initialMaxGroupsInBatch,
        uint256 initialExecutionDelay
    ) external initializer {
        if (admin == address(0)) revert AdminCannotBeZero();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MANAGE_ROLE, admin);
        _grantRole(REMOVE_ROLE, admin);

        _setBatchSize(initialBatchSize);
        _setMaxGroupsInBatch(initialMaxGroupsInBatch);
        _setExecutionDelay(initialExecutionDelay);
    }

    /**
     * @notice Sets the maximum batch size limit
     * @param limit New batch size limit
     * @dev Reverts if caller does not have MANAGE_ROLE
     */
    function setBatchSize(uint256 limit) external onlyRole(MANAGE_ROLE) {
        _setBatchSize(limit);
    }

    /**
     * @notice Sets the maximum number of groups allowed in a batch
     * @param limit New max groups in batch limit
     * @dev Reverts if caller does not have MANAGE_ROLE
     */
    function setMaxGroupsInBatch(uint256 limit) external onlyRole(MANAGE_ROLE) {
        _setMaxGroupsInBatch(limit);
    }

    /**
     * @notice Sets the execution delay in seconds between adding and executing a batch
     * @param delay New execution delay in seconds (0 means no delay)
     * @dev Reverts if caller does not have MANAGE_ROLE
     * @dev The execution delay is not snapshotted per batch
     *      Changes to this parameter apply retroactively to all pending batches
     *      MANAGE_ROLE holders are trusted
     */
    function setExecutionDelay(uint256 delay) external onlyRole(MANAGE_ROLE) {
        _setExecutionDelay(delay);
    }

    /**
     * @notice Removes batches from the queue
     * @param batchHashes Array of batch hashes to remove
     * @dev Reverts if caller does not have REMOVE_ROLE
     * @dev Reverts if batchHashes is empty
     * @dev Reverts if any batch is not found or already executed
     */
    function removeBatches(bytes32[] calldata batchHashes) external onlyRole(REMOVE_ROLE) {
        if (batchHashes.length == 0) revert EmptyBatchHashes();

        for (uint256 i = 0; i < batchHashes.length; ++i) {
            bytes32 batchHash = batchHashes[i];

            if (_pendingBatches[batchHash].publisher == address(0)) revert BatchNotFound(batchHash);

            delete _pendingBatches[batchHash];
        }
        emit BatchesRemoved(batchHashes);
    }

    // ==============
    //  View methods
    // ==============

    /**
     * @notice Returns the current batch size limit
     * @return Current maximum batch size
     */
    function batchSize() external view returns (uint256) {
        return _batchSize;
    }

    /**
     * @notice Returns the maximum number of groups allowed in a batch
     * @return Current max groups in batch limit
     */
    function maxGroupsInBatch() external view returns (uint256) {
        return _maxGroupsInBatch;
    }

    /**
     * @notice Returns the current execution delay in seconds
     * @return Current execution delay
     */
    function executionDelay() external view returns (uint256) {
        return _executionDelay;
    }

    /**
     * @notice Returns the address of the ConsolidationGateway
     * @return Address of the ConsolidationGateway contract
     */
    function getConsolidationGateway() external view returns (address) {
        return address(CONSOLIDATION_GATEWAY);
    }

    /**
     * @notice Returns the batch info for a pending batch
     * @param batchHash Hash of the batch to check
     * @return Batch info struct with publisher address and addedAt timestamp (zero values if batch is not in queue)
     */
    function getBatchInfo(bytes32 batchHash) external view returns (BatchInfo memory) {
        return _pendingBatches[batchHash];
    }

    // ===============
    //  Publisher API
    // ===============

    /**
     * @notice Adds grouped consolidation requests to the queue
     * @param groups Array of consolidation groups, where each group contains source pubkeys and a target pubkey
     * @dev The same batch can be submitted again after it has been executed.
     * @dev Reverts if:
     *      - Caller does not have PUBLISH_ROLE
     *      - Batch is empty
     *      - Any group is empty
     *      - Total batch size exceeds limit
     *      - Any source or target pubkey length is not 48 bytes
     *      - Any source pubkey equals its corresponding target pubkey
     *      - Batch already exists
     */
    function addConsolidationRequests(ConsolidationGroup[] calldata groups) external onlyRole(PUBLISH_ROLE) {
        uint256 groupsCount = groups.length;
        if (groupsCount == 0) revert EmptyBatch();

        uint256 maxGroups = _maxGroupsInBatch;
        if (groupsCount > maxGroups) revert TooManyGroups(groupsCount, maxGroups);

        uint256 totalCount = 0;
        for (uint256 i = 0; i < groupsCount; ++i) {
            uint256 groupSize = groups[i].sourcePubkeys.length;
            if (groupSize == 0) revert EmptyGroup(i);
            totalCount += groupSize;
        }

        uint256 limit = _batchSize;
        if (totalCount > limit) revert BatchTooLarge(totalCount, limit);

        for (uint256 i = 0; i < groupsCount; ++i) {
            bytes calldata targetPubkey = groups[i].targetPubkey;
            if (targetPubkey.length != PUBKEY_LENGTH) {
                revert InvalidTargetPubkeyLength(i, targetPubkey.length);
            }

            bytes32 targetHash = keccak256(targetPubkey);
            bytes[] calldata group = groups[i].sourcePubkeys;
            for (uint256 j = 0; j < group.length; ++j) {
                bytes calldata sourcePubkey = group[j];
                if (sourcePubkey.length != PUBKEY_LENGTH) {
                    revert InvalidSourcePubkeyLength(i, j, sourcePubkey.length);
                }

                if (keccak256(sourcePubkey) == targetHash) {
                    revert SourceEqualsTarget(i);
                }
            }
        }

        bytes memory encodedBatch = abi.encode(groups);

        bytes32 batchHash = keccak256(encodedBatch);

        if (_pendingBatches[batchHash].publisher != address(0)) revert BatchAlreadyPending(batchHash);

        _pendingBatches[batchHash] = BatchInfo(msg.sender, uint64(block.timestamp));

        emit RequestsAdded(msg.sender, encodedBatch);
    }

    // ==============
    //  Executor API
    // ==============

    /**
     * @notice Executes a batch of grouped consolidation requests
     * @param groups Array of consolidation witness groups, each containing source pubkeys and a target validator witness
     * @dev Forwards the batch to ConsolidationGateway with msg.value as fee
     * @dev Reverts if:
     *      - Batch was not added or was already executed/removed
     */
    function executeConsolidation(IConsolidationGateway.ConsolidationWitnessGroup[] calldata groups) external payable {
        // Reconstruct ConsolidationGroup[] to compute the batch hash that matches the publisher's submission
        ConsolidationGroup[] memory publisherGroups = new ConsolidationGroup[](groups.length);
        for (uint256 i = 0; i < groups.length; ++i) {
            publisherGroups[i] = ConsolidationGroup({
                sourcePubkeys: groups[i].sourcePubkeys,
                targetPubkey: groups[i].targetWitness.pubkey
            });
        }

        bytes32 batchHash = keccak256(abi.encode(publisherGroups));

        BatchInfo memory batch = _pendingBatches[batchHash];
        if (batch.publisher == address(0)) revert BatchNotFound(batchHash);

        uint256 executeAfter = uint256(batch.addedAt) + _executionDelay;
        if (block.timestamp < executeAfter) revert ExecutionDelayNotPassed(block.timestamp, executeAfter);

        delete _pendingBatches[batchHash];

        CONSOLIDATION_GATEWAY.addConsolidationRequests{value: msg.value}(groups, msg.sender);

        emit RequestsExecuted(batchHash, msg.value);
    }

    // ==================
    //  Internal methods
    // ==================

    function _setBatchSize(uint256 limit) internal {
        if (limit == 0) revert ZeroArgument("batchSizeLimit");
        uint256 maxGroups = _maxGroupsInBatch;
        if (maxGroups > limit) revert MaxGroupsExceedsBatchSize(maxGroups, limit);
        _batchSize = limit;
        emit BatchLimitUpdated(limit);
    }

    function _setMaxGroupsInBatch(uint256 limit) internal {
        if (limit == 0) revert ZeroArgument("maxGroupsInBatchLimit");
        uint256 currentBatchSize = _batchSize;
        if (limit > currentBatchSize) revert MaxGroupsExceedsBatchSize(limit, currentBatchSize);
        _maxGroupsInBatch = limit;
        emit MaxGroupsInBatchUpdated(limit);
    }

    function _setExecutionDelay(uint256 delay) internal {
        _executionDelay = delay;
        emit ExecutionDelayUpdated(delay);
    }
}
