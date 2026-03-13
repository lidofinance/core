// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";

interface IConsolidationGateway {
    function addConsolidationRequests(
        bytes[] calldata sourcePubkeys,
        bytes[] calldata targetPubkeys,
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
 * 3. Executor bot executes batches, paying the required ETH fee (EXECUTE_ROLE)
 *    The bus forwards the batch to ConsolidationGateway
 * 4. Optional REMOVE_ROLE can remove batches from the pending queue
 */
contract ConsolidationBus is AccessControlEnumerable {
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
     * @notice Thrown when source and target arrays have different lengths
     * @param sourceLength Length of source pubkeys array
     * @param targetLength Length of target pubkeys array
     */
    error ArraysLengthMismatch(uint256 sourceLength, uint256 targetLength);

    /**
     * @notice Thrown when batch is empty
     */
    error EmptyBatch();

    /**
     * @notice Thrown when batch size exceeds the limit
     * @param size Actual batch size
     * @param limit Maximum allowed batch size
     */
    error BatchTooLarge(uint256 size, uint256 limit);

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
     * @notice Emitted when the batch size limit is updated
     * @param newLimit New batch size limit
     */
    event BatchLimitUpdated(uint256 newLimit);

    /**
     * @notice Emitted when consolidation requests are added
     * @param publisher Address of the publisher who added the requests
     * @param batchData Encoded batch data (abi.encode(sourcePubkeys, targetPubkeys))
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

    bytes32 public constant MANAGE_ROLE = keccak256("MANAGE_ROLE");
    bytes32 public constant PUBLISH_ROLE = keccak256("PUBLISH_ROLE");
    bytes32 public constant EXECUTE_ROLE = keccak256("EXECUTE_ROLE");
    bytes32 public constant REMOVE_ROLE = keccak256("REMOVE_ROLE");

    IConsolidationGateway internal immutable CONSOLIDATION_GATEWAY;

    uint256 internal _batchSize;
    mapping(bytes32 batchHash => address publisher) internal _pendingBatches;

    constructor(
        address admin,
        address consolidationGateway,
        uint256 initialBatchSize
    ) {
        if (admin == address(0)) revert AdminCannotBeZero();
        if (consolidationGateway == address(0)) revert ZeroArgument("consolidationGateway");

        CONSOLIDATION_GATEWAY = IConsolidationGateway(consolidationGateway);
        _setBatchSize(initialBatchSize);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MANAGE_ROLE, admin);
        _grantRole(REMOVE_ROLE, admin);
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
     * @notice Removes batches from the queue
     * @param batchHashes Array of batch hashes to remove
     * @dev Reverts if caller does not have REMOVE_ROLE
     * @dev Reverts if any batch is not found or already executed
     */
    function removeBatches(bytes32[] calldata batchHashes) external onlyRole(REMOVE_ROLE) {
        for (uint256 i = 0; i < batchHashes.length; ++i) {
            bytes32 batchHash = batchHashes[i];

            if (_pendingBatches[batchHash] == address(0)) revert BatchNotFound(batchHash);

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
     * @notice Returns the address of the ConsolidationGateway
     * @return Address of the ConsolidationGateway contract
     */
    function getConsolidationGateway() external view returns (address) {
        return address(CONSOLIDATION_GATEWAY);
    }

    /**
     * @notice Returns the publisher address for a pending batch, or zero address if batch is not in queue
     * @param batchHash Hash of the batch to check
     * @return Address of the publisher who added the batch, or zero address if not in queue
     */
    function getBatchPublisher(bytes32 batchHash) external view returns (address) {
        return _pendingBatches[batchHash];
    }

    // ===============
    //  Publisher API
    // ===============

    /**
     * @notice Adds consolidation requests to the queue
     * @param sourcePubkeys Array of 48-byte source validator public keys
     * @param targetPubkeys Array of 48-byte target validator public keys
     * @dev Reverts if:
     *      - Caller does not have PUBLISH_ROLE
     *      - Arrays have different lengths
     *      - Batch is empty
     *      - Batch size exceeds limit (when limit > 0)
     *      - Any source pubkey equals its corresponding target pubkey
     *      - Batch already exists
     */
    function addConsolidationRequests(
        bytes[] calldata sourcePubkeys,
        bytes[] calldata targetPubkeys
    ) external onlyRole(PUBLISH_ROLE) {
        uint256 count = sourcePubkeys.length;
        if (count == 0) revert EmptyBatch();
        if (count != targetPubkeys.length) revert ArraysLengthMismatch(count, targetPubkeys.length);

        uint256 limit = _batchSize;
        if (count > limit) revert BatchTooLarge(count, limit);

        for (uint256 i = 0; i < count; ++i) {
            if (keccak256(sourcePubkeys[i]) == keccak256(targetPubkeys[i])) {
                revert SourceEqualsTarget(i);
            }
        }

        bytes32 batchHash = _computeBatchHash(sourcePubkeys, targetPubkeys);

        if (_pendingBatches[batchHash] != address(0)) revert BatchAlreadyPending(batchHash);

        _pendingBatches[batchHash] = msg.sender;

        emit RequestsAdded(msg.sender, abi.encode(sourcePubkeys, targetPubkeys));
    }

    // ==============
    //  Executor API
    // ==============

    /**
     * @notice Executes a batch of consolidation requests
     * @param sourcePubkeys Array of 48-byte source validator public keys
     * @param targetPubkeys Array of 48-byte target validator public keys
     * @dev Forwards the batch to ConsolidationGateway with msg.value as fee
     * @dev Reverts if:
     *      - Caller does not have EXECUTE_ROLE
     *      - Batch was not added or was already executed/removed
     */
    function executeConsolidation(
        bytes[] calldata sourcePubkeys,
        bytes[] calldata targetPubkeys
    ) external payable onlyRole(EXECUTE_ROLE) {
        bytes32 batchHash = _computeBatchHash(sourcePubkeys, targetPubkeys);

        if (_pendingBatches[batchHash] == address(0)) revert BatchNotFound(batchHash);

        delete _pendingBatches[batchHash];

        CONSOLIDATION_GATEWAY.addConsolidationRequests{value: msg.value}(
            sourcePubkeys,
            targetPubkeys,
            msg.sender
        );

        emit RequestsExecuted(batchHash, msg.value);
    }

    // ==================
    //  Internal methods
    // ==================

    /**
     * @dev Computes the hash of a batch from source and target pubkeys
     * @param sourcePubkeys Array of source validator public keys
     * @param targetPubkeys Array of target validator public keys
     * @return Hash of the encoded batch data
     */
    function _computeBatchHash(
        bytes[] calldata sourcePubkeys,
        bytes[] calldata targetPubkeys
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(sourcePubkeys, targetPubkeys));
    }

    function _setBatchSize(uint256 limit) internal {
        if (limit == 0) revert ZeroArgument("batchSizeLimit");
        _batchSize = limit;
        emit BatchLimitUpdated(limit);
    }
}
