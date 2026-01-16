// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

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
 * 1. Admins register/unregister publishers (MANAGER_ROLE)
 * 2. Registered publishers add consolidation requests (PUBLISHER_ROLE)
 * 3. Executor bot executes batches, paying the required ETH fee (EXECUTER_ROLE)
 *    The bus forwards the batch to ConsolidationGateway
 */
contract ConsolidationBus is AccessControlEnumerableUpgradeable {
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
     * @notice Thrown when trying to add a batch that already exists
     * @param batchHash Hash of the duplicate batch
     */
    error BatchAlreadyAdded(bytes32 batchHash);

    /**
     * @notice Thrown when batch is not found in storage
     * @param batchHash Hash of the missing batch
     */
    error BatchNotFound(bytes32 batchHash);

    /**
     * @notice Thrown when trying to execute or remove an already executed batch
     * @param batchHash Hash of the executed batch
     */
    error BatchAlreadyExecuted(bytes32 batchHash);

    /**
     * @notice Emitted when a publisher is registered
     * @param publisher Address of the registered publisher
     */
    event PublisherRegistered(address indexed publisher);

    /**
     * @notice Emitted when a publisher is unregistered
     * @param publisher Address of the unregistered publisher
     */
    event PublisherUnregistered(address indexed publisher);

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

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");
    bytes32 public constant EXECUTER_ROLE = keccak256("EXECUTER_ROLE");

    uint256 public constant VERSION = 1;

    IConsolidationGateway internal immutable CONSOLIDATION_GATEWAY;

    struct BatchInfo {
        address publisher;
        bool executed;
    }

    uint256 internal _batchSize;
    mapping(bytes32 batchHash => BatchInfo) internal _batches;

    constructor(
        address admin,
        address consolidationGateway,
        uint256 initialBatchSize
    ) {
        if (admin == address(0)) revert AdminCannotBeZero();
        if (consolidationGateway == address(0)) revert ZeroArgument("consolidationGateway");

        CONSOLIDATION_GATEWAY = IConsolidationGateway(consolidationGateway);
        _batchSize = initialBatchSize;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ==================
    //  Admin operations
    // ==================

    /**
     * @notice Registers a new publisher by granting PUBLISHER_ROLE
     * @param publisher Address to register as publisher
     * @dev Reverts if caller does not have MANAGER_ROLE
     */
    function registerPublisher(address publisher) external onlyRole(MANAGER_ROLE) {
        if (publisher == address(0)) revert ZeroArgument("publisher");
        _grantRole(PUBLISHER_ROLE, publisher);
        emit PublisherRegistered(publisher);
    }

    /**
     * @notice Unregisters a publisher by revoking PUBLISHER_ROLE
     * @param publisher Address to unregister
     * @dev Reverts if caller does not have MANAGER_ROLE
     */
    function unregisterPublisher(address publisher) external onlyRole(MANAGER_ROLE) {
        if (publisher == address(0)) revert ZeroArgument("publisher");
        _revokeRole(PUBLISHER_ROLE, publisher);
        emit PublisherUnregistered(publisher);
    }

    /**
     * @notice Sets the maximum batch size limit
     * @param limit New batch size limit
     * @dev Reverts if caller does not have MANAGER_ROLE
     */
    function setBatchSize(uint256 limit) external onlyRole(MANAGER_ROLE) {
        _batchSize = limit;
        emit BatchLimitUpdated(limit);
    }

    /**
     * @notice Removes batches from the queue
     * @param batchHashes Array of batch hashes to remove
     * @dev Reverts if caller does not have MANAGER_ROLE
     * @dev Reverts if any batch is not found or already executed
     */
    function removeBatches(bytes32[] calldata batchHashes) external onlyRole(MANAGER_ROLE) {
        for (uint256 i = 0; i < batchHashes.length; ++i) {
            bytes32 batchHash = batchHashes[i];
            BatchInfo storage batch = _batches[batchHash];

            if (batch.publisher == address(0)) revert BatchNotFound(batchHash);
            if (batch.executed) revert BatchAlreadyExecuted(batchHash);

            delete _batches[batchHash];
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
     * @notice Checks if a batch has been added
     * @param batchHash Hash of the batch to check
     * @return True if batch exists and is not executed
     */
    function isBatchAdded(bytes32 batchHash) external view returns (bool) {
        BatchInfo storage batch = _batches[batchHash];
        return batch.publisher != address(0) && !batch.executed;
    }

    /**
     * @notice Returns the publisher address for a batch
     * @param batchHash Hash of the batch
     * @return Address of the publisher who added the batch
     */
    function addedBy(bytes32 batchHash) external view returns (address) {
        return _batches[batchHash].publisher;
    }

    /**
     * @notice Returns the address of the ConsolidationGateway
     * @return Address of the ConsolidationGateway contract
     */
    function getConsolidationGateway() external view returns (address) {
        return address(CONSOLIDATION_GATEWAY);
    }

    // ===============
    //  Publisher API
    // ===============

    /**
     * @notice Adds consolidation requests to the queue
     * @param sourcePubkeys Array of 48-byte source validator public keys
     * @param targetPubkeys Array of 48-byte target validator public keys
     * @dev Reverts if:
     *      - Caller does not have PUBLISHER_ROLE
     *      - Arrays have different lengths
     *      - Batch is empty
     *      - Batch size exceeds limit (when limit > 0)
     *      - Batch already exists
     */
    function addConsolidationRequests(
        bytes[] calldata sourcePubkeys,
        bytes[] calldata targetPubkeys
    ) external onlyRole(PUBLISHER_ROLE) {
        uint256 count = sourcePubkeys.length;
        if (count == 0) revert EmptyBatch();
        if (count != targetPubkeys.length) revert ArraysLengthMismatch(count, targetPubkeys.length);

        uint256 limit = _batchSize;
        if (limit > 0 && count > limit) revert BatchTooLarge(count, limit);

        bytes32 batchHash = _computeBatchHash(sourcePubkeys, targetPubkeys);

        if (_batches[batchHash].publisher != address(0)) revert BatchAlreadyAdded(batchHash);

        _batches[batchHash] = BatchInfo({
            publisher: msg.sender,
            executed: false
        });

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
     *      - Caller does not have EXECUTER_ROLE
     *      - Batch was not added or was already executed/removed
     */
    function executeConsolidation(
        bytes[] calldata sourcePubkeys,
        bytes[] calldata targetPubkeys
    ) external payable onlyRole(EXECUTER_ROLE) {
        bytes32 batchHash = _computeBatchHash(sourcePubkeys, targetPubkeys);

        BatchInfo storage batch = _batches[batchHash];
        if (batch.publisher == address(0)) revert BatchNotFound(batchHash);
        if (batch.executed) revert BatchAlreadyExecuted(batchHash);

        batch.executed = true;

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
}
