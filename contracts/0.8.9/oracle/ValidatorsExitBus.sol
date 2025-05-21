// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {UnstructuredStorage} from "../lib/UnstructuredStorage.sol";
import {ILidoLocator} from "../../common/interfaces/ILidoLocator.sol";
import {Versioned} from "../utils/Versioned.sol";
import {ExitRequestLimitData, ExitLimitUtilsStorage, ExitLimitUtils} from "../lib/ExitLimitUtils.sol";
import {PausableUntil} from "../utils/PausableUntil.sol";
import {IValidatorsExitBus} from "../interfaces/IValidatorsExitBus.sol";

interface ITriggerableWithdrawalsGateway {
    struct ValidatorData {
        uint256 stakingModuleId;
        uint256 nodeOperatorId;
        bytes pubkey;
    }

    function triggerFullWithdrawals(
        ValidatorData[] calldata triggerableExitData,
        address refundRecipient,
        uint8 exitType
    ) external payable;
}

/**
 * @title ValidatorsExitBus
 * @notice An on-chain contract that serves as the central infrastructure for managing validator exit requests.
 * It stores report hashes, emits exit events, and maintains data and tools that enables anyone to prove a validator was requested to exit.
 * Unlike VEBO, it supports exit reports from a wide range of entities.
 */
contract ValidatorsExitBus is IValidatorsExitBus, AccessControlEnumerable, PausableUntil, Versioned {
    using UnstructuredStorage for bytes32;
    using ExitLimitUtilsStorage for bytes32;
    using ExitLimitUtils for ExitRequestLimitData;

    /// @dev Errors
    /**
     * @notice Thrown when an invalid zero value is passed
     * @param name Name of the argument that was zero
     */
    error ZeroArgument(string name);

    /**
     * @notice Thrown when exit request passed to method contain wrong DATA_FORMAT
     * @param format code of format, currently only DATA_FORMAT=1 is supported in the contract
     */
    error UnsupportedRequestsDataFormat(uint256 format);

    /**
     * @notice Thrown when exit request has wrong length
     */
    error InvalidRequestsDataLength();

    /**
     * @notice Thrown when module id equal to zero
     */
    error InvalidRequestsData();

    /**
     * @notice Thrown when data submitted for exit requests was not sorted in ascending order or contains duplicates
     */
    error InvalidRequestsDataSortOrder();

    /**
     * @notice Thrown when pubkeys of invalid length are provided
     */
    error InvalidPubkeysArray();

    /**
     * Thrown when there are attempt to send exit events for request that was not submitted earlier by trusted entities
     */
    error ExitHashNotSubmitted();

    /**
     * Thrown when there are attempt to store exit hash that was already submitted
     */
    error ExitHashAlreadySubmitted();

    /**
     * @notice Throw when in submitExitRequestsData all requests were already delivered
     */
    error RequestsAlreadyDelivered();

    /**
     * @notice Thrown when any of the provided `exitDataIndexes` refers to a validator that was not yet delivered (i.e., exit request not emitted)
     */
    error ExitDataWasNotDelivered(uint256 exitDataIndex, uint256 lastDeliveredExitDataIndex);

    /**
     * @notice Thrown when index of request in submitted data for triggerable withdrawal is out of range
     */
    error ExitDataIndexOutOfRange(uint256 exitDataIndex, uint256 totalItemsCount);

    /**
     * @notice Thrown when array of indexes of requests in submitted data for triggerable withdrawal is not is not strictly increasing array
     */
    error InvalidExitDataIndexSortOrder();

    /**
     * @notice Thrown when remaining exit requests limit is not enough to cover sender requests
     * @param requestsCount Amount of requests that were sent for processing
     * @param remainingLimit Amount of requests that still can be processed at current day
     */
    error ExitRequestsLimit(uint256 requestsCount, uint256 remainingLimit);

    /**
     * @notice Thrown when the number of requests submitted via submitExitRequestsData exceeds the allowed maxRequestsPerBatch.
     * @param requestsCount The number of requests included in the current call.
     * @param maxRequestsPerBatch The maximum number of requests allowed per call to submitExitRequestsData.
     */
    error MaxRequestsBatchSizeExceeded(uint256 requestsCount, uint256 maxRequestsPerBatch);

    error DeliveredIndexOutOfBounds();
    error DeliveryWasNotStarted();

    /// @dev Events

    /**
     * @notice Emitted when an entity with the SUBMIT_REPORT_HASH_ROLE role submits a hash of the exit requests data.
     * @param exitRequestsHash - keccak256 hash of the encoded validators list
     */
    event RequestsHashSubmitted(bytes32 exitRequestsHash);
    /**
     * @notice Emitted when validator exit requested.
     * @param stakingModuleId Id of staking module.
     * @param nodeOperatorId Id of node operator.
     * @param validatorIndex Validator index.
     * @param validatorPubkey Public key of validator.
     * @param timestamp Block timestamp
     */
    event ValidatorExitRequest(
        uint256 indexed stakingModuleId,
        uint256 indexed nodeOperatorId,
        uint256 indexed validatorIndex,
        bytes validatorPubkey,
        uint256 timestamp
    );
    /**
     * @notice Emitted when maximum exit request limit and the frame during which a portion of the limit can be restored set.
     * @param maxExitRequestsLimit The maximum number of exit requests. The period for which this value is valid can be calculated as: X = maxExitRequests / (exitsPerFrame * frameDuration)
     * @param exitsPerFrame The number of exits that can be restored per frame.
     * @param frameDuration The duration of each frame, in seconds, after which `exitsPerFrame` exits can be restored.
     */
    event ExitRequestsLimitSet(uint256 maxExitRequestsLimit, uint256 exitsPerFrame, uint256 frameDuration);

    struct ValidatorData {
        uint256 nodeOpId;
        uint256 moduleId;
        uint256 valIndex;
        bytes pubkey;
    }
    struct RequestStatus {
        uint32 contractVersion;
        uint32 deliveryHistoryLength;
        uint32 lastDeliveredExitDataIndex; // index of validator,  maximum 600 for example
        uint32 lastDeliveredExitDataTimestamp;
    }

    /// @notice An ACL role granting the permission to submit a hash of the exit requests data
    bytes32 public constant SUBMIT_REPORT_HASH_ROLE = keccak256("SUBMIT_REPORT_HASH_ROLE");
    /// @notice An ACL role granting the permission to set maximum exit request limit and the frame limit restoring values
    bytes32 public constant EXIT_REPORT_LIMIT_ROLE = keccak256("EXIT_REPORT_LIMIT_ROLE");
    /// @notice An ACL role granting the permission to pause accepting validator exit requests
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    /// @notice An ACL role granting the permission to resume accepting validator exit requests
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");
    /// @notice An ACL role granting the permission to set MAX_VALIDATORS_PER_BATCH value
    bytes32 public constant MAX_VALIDATORS_PER_BATCH_ROLE = keccak256("MAX_VALIDATORS_PER_BATCH_ROLE");

    /// Length in bytes of packed request
    uint256 internal constant PACKED_REQUEST_LENGTH = 64;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    /// @notice The list format of the validator exit requests data. Used when all
    /// requests fit into a single transaction.
    ///
    /// Each validator exit request is described by the following 64-byte array:
    ///
    /// MSB <------------------------------------------------------- LSB
    /// |  3 bytes   |  5 bytes   |     8 bytes      |    48 bytes     |
    /// |  moduleId  |  nodeOpId  |  validatorIndex  | validatorPubkey |
    ///
    /// All requests are tightly packed into a byte array where requests follow
    /// one another without any separator or padding, and passed to the `data`
    /// field of the report structure.
    ///
    /// Requests must be sorted in the ascending order by the following compound
    /// key: (moduleId, nodeOpId, validatorIndex).
    ///
    uint256 public constant DATA_FORMAT_LIST = 1;

    ILidoLocator internal immutable LOCATOR;

    // Storage slot for exit request limit configuration and current quota tracking
    bytes32 internal constant EXIT_REQUEST_LIMIT_POSITION = keccak256("lido.ValidatorsExitBus.maxExitRequestLimit");
    // Storage slot for the maximum number of validator exit requests allowed per processing batch
    bytes32 internal constant MAX_VALIDATORS_PER_BATCH_POSITION =
        keccak256("lido.ValidatorsExitBus.maxValidatorsPerBatch");

    // Storage slot for mapping(bytes32 => RequestStatus), keyed by exitRequestsHash
    bytes32 internal constant REQUEST_STATUS_POSITION = keccak256("lido.ValidatorsExitBus.requestStatus");
    // Storage slot for mapping(bytes32 => DeliveryHistory[]), keyed by exitRequestsHash
    bytes32 internal constant DELIVERY_HISTORY_POSITION = keccak256("lido.ValidatorsExitBus.deliveryHistory");

    // RequestStatus stores the last delivered index of the request, timestamp of delivery, and deliveryHistory length (number of deliveries).
    // If a request is fully delivered in one step (as with oracle requests, which can't be delivered partially),
    // only RequestStatus is used for efficiency.
    // If a request is delivered in parts (e.g., due to limit constraints),
    // DeliveryHistory[] stores full delivery records in addition to RequestStatus.
    // If deliveryHistoryLength == 1, delivery info is read from RequestStatus; otherwise, from DeliveryHistory[].
    // Both mappings use the same key (exitRequestsHash).

    constructor(address lidoLocator) {
        LOCATOR = ILidoLocator(lidoLocator);
    }

    /**
     * @notice Submit a hash of the exit requests data.
     *
     * @dev Reverts if:
     * - The contract is paused.
     * - The caller does not have the `SUBMIT_REPORT_HASH_ROLE`.
     * - The hash has already been submitted.
     *
     * Emits `RequestsHashSubmitted` event;
     *
     * @param exitRequestsHash - keccak256 hash of the encoded validators list
     */
    function submitExitRequestsHash(bytes32 exitRequestsHash) external whenResumed onlyRole(SUBMIT_REPORT_HASH_ROLE) {
        uint256 contractVersion = getContractVersion();
        _storeNewHashRequestStatus(
            exitRequestsHash,
            RequestStatus(uint32(contractVersion), 0, type(uint32).max, type(uint32).max)
        );
    }

    /**
     * @notice Method for submitting exit requests data.
     *
     * @dev Reverts if:
     * - The contract is paused.
     * - The keccak256 hash of `requestsData` does not exist in storage (i.e., was not submitted).
     * - The provided Exit Requests Data has already been fully unpacked.
     * - The contract version does not match the version at the time of report submission.
     * - The data format is not supported.
     * - There is no remaining quota available for the current limits.
     *
     * Emits `ValidatorExitRequest` events;
     *
     * @param request - The exit requests structure.
     */
    function submitExitRequestsData(ExitRequestsData calldata request) external whenResumed {
        // bytes calldata data = request.data;
        bytes32 exitRequestsHash = keccak256(abi.encode(request.data, request.dataFormat));
        RequestStatus storage requestStatus = _storageRequestStatus()[exitRequestsHash];

        _checkExitSubmitted(requestStatus);
        _checkExitRequestData(request.data, request.dataFormat);
        _checkMaxBatchSize(request.data);
        _checkContractVersion(requestStatus.contractVersion);

        uint256 totalItemsCount = request.data.length / PACKED_REQUEST_LENGTH;
        uint32 lastDeliveredIndex = requestStatus.lastDeliveredExitDataIndex;

        // maybe this check is extra
        if (requestStatus.deliveryHistoryLength != 0 && lastDeliveredIndex >= totalItemsCount) {
            revert DeliveredIndexOutOfBounds();
        }

        uint256 startIndex = requestStatus.deliveryHistoryLength == 0 ? 0 : lastDeliveredIndex + 1;
        uint256 undeliveredItemsCount = totalItemsCount - startIndex;

        if (undeliveredItemsCount == 0) {
            revert RequestsAlreadyDelivered();
        }

        uint256 requestsToDeliver = _consumeLimit(undeliveredItemsCount);

        _processExitRequestsList(request.data, startIndex, requestsToDeliver);

        uint256 newLastDeliveredIndex = startIndex + requestsToDeliver - 1;

        // if totalItemsCount ==  requestsToDeliver, we deliver it via one attempt and don't need to store deliveryHistory array
        // can store in RequestStatus via lastDeliveredExitDataIndex and lastDeliveredExitDataTimestamp fields
        bool deliverFullyAtOnce = totalItemsCount == requestsToDeliver && requestStatus.deliveryHistoryLength == 0;
        if (!deliverFullyAtOnce) {
            _storeDeliveryEntry(exitRequestsHash, newLastDeliveredIndex, _getTimestamp());
        }

        _updateRequestStatus(
            requestStatus,
            requestStatus.deliveryHistoryLength + 1,
            newLastDeliveredIndex,
            _getTimestamp()
        );
    }

    /**
     * @notice Submits Triggerable Withdrawal Requests to the Triggerable Withdrawals Gateway.
     *
     * @param exitsData The report data previously unpacked and emitted by the VEB.
     * @param exitDataIndexes Array of of sorted indexes pointing to validators in `exitsData.data`
     * to be exited via TWR.
     * @param refundRecipient Address to return extra fee on TW (eip-7002) exit.
     *
     * @dev Reverts if:
     *     - The hash of `exitsData` was not previously submitted in the VEB.
     *     - Any of the provided `exitDataIndexes` refers to a validator that was not yet delivered (i.e., exit request not emitted).
     *     - `exitDataIndexes` is not strictly increasing array
     */
    function triggerExits(
        ExitRequestsData calldata exitsData,
        uint256[] calldata exitDataIndexes,
        address refundRecipient
    ) external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        // If the refund recipient is not set, use the sender as the refund recipient
        if (refundRecipient == address(0)) {
            refundRecipient = msg.sender;
        }

        RequestStatus storage requestStatus = _storageRequestStatus()[
            keccak256(abi.encode(exitsData.data, exitsData.dataFormat))
        ];

        _checkExitSubmitted(requestStatus);
        _checkDeliveryStarted(requestStatus);
        _checkExitRequestData(exitsData.data, exitsData.dataFormat);
        _checkContractVersion(requestStatus.contractVersion);

        ITriggerableWithdrawalsGateway.ValidatorData[]
            memory triggerableExitData = new ITriggerableWithdrawalsGateway.ValidatorData[](exitDataIndexes.length);

        uint256 lastExitDataIndex = type(uint256).max;

        for (uint256 i = 0; i < exitDataIndexes.length; i++) {
            if (exitDataIndexes[i] > requestStatus.lastDeliveredExitDataIndex) {
                revert ExitDataWasNotDelivered(exitDataIndexes[i], requestStatus.lastDeliveredExitDataIndex);
            }

            if (i > 0 && exitDataIndexes[i] <= lastExitDataIndex) {
                revert InvalidExitDataIndexSortOrder();
            }

            lastExitDataIndex = exitDataIndexes[i];

            ValidatorData memory validatorData = _getValidatorData(exitsData.data, exitDataIndexes[i]);
            if (validatorData.moduleId == 0) revert InvalidRequestsData();

            triggerableExitData[i] = ITriggerableWithdrawalsGateway.ValidatorData(
                validatorData.moduleId,
                validatorData.nodeOpId,
                validatorData.pubkey
            );
        }

        ITriggerableWithdrawalsGateway(LOCATOR.triggerableWithdrawalsGateway()).triggerFullWithdrawals{
            value: msg.value
        }(triggerableExitData, refundRecipient, 1);
    }

    /**
     * @notice Sets the maximum exit request limit and the frame during which a portion of the limit can be restored.
     * @param maxExitRequestsLimit The maximum number of exit requests. The period for which this value is valid can be calculated as: X = maxExitRequests / (exitsPerFrame * frameDuration)
     * @param exitsPerFrame The number of exits that can be restored per frame.
     * @param frameDuration The duration of each frame, in seconds, after which `exitsPerFrame` exits can be restored.
     */
    function setExitRequestLimit(
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDuration
    ) external onlyRole(EXIT_REPORT_LIMIT_ROLE) {
        _setExitRequestLimit(maxExitRequestsLimit, exitsPerFrame, frameDuration);
    }

    /**
     * @notice Returns information about current limits data
     * @return maxExitRequestsLimit Maximum exit requests limit
     * @return exitsPerFrame The number of exits that can be restored per frame.
     * @return frameDuration The duration of each frame, in seconds, after which `exitsPerFrame` exits can be restored.
     * @return prevExitRequestsLimit Limit left after previous requests
     * @return currentExitRequestsLimit Current exit requests limit
     */
    function getExitRequestLimitFullInfo()
        external
        view
        returns (
            uint256 maxExitRequestsLimit,
            uint256 exitsPerFrame,
            uint256 frameDuration,
            uint256 prevExitRequestsLimit,
            uint256 currentExitRequestsLimit
        )
    {
        ExitRequestLimitData memory exitRequestLimitData = EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit();
        maxExitRequestsLimit = exitRequestLimitData.maxExitRequestsLimit;
        exitsPerFrame = exitRequestLimitData.exitsPerFrame;
        frameDuration = exitRequestLimitData.frameDuration;
        prevExitRequestsLimit = exitRequestLimitData.prevExitRequestsLimit;
        currentExitRequestsLimit = _getCurrentExitLimit();
    }

    /**
     * @notice Sets the maximum allowed number of validator exit requests to process in a single batch.
     * @param maxRequests The new maximum number of exit requests allowed per batch.
     */
    function setMaxRequestsPerBatch(uint256 maxRequests) external onlyRole(MAX_VALIDATORS_PER_BATCH_ROLE) {
        _setMaxRequestsPerBatch(maxRequests);
    }

    /**
     * @notice Returns information about allowed number of validator exit requests to process in a single batch.
     * @return The new maximum number of exit requests allowed per batch
     */
    function getMaxRequestsPerBatch() external view returns (uint256) {
        return _getMaxRequestsPerBatch();
    }

    /**
     * @notice Returns delivery history and current status for specific exitRequestsData
     *
     * @param exitRequestsHash - The exit requests hash.
     *
     * @dev Reverts if:
     *     - exitRequestsHash was not submited
     */
    function getExitRequestsDeliveryHistory(bytes32 exitRequestsHash) external view returns (DeliveryHistory[] memory) {
        mapping(bytes32 => RequestStatus) storage requestStatusMap = _storageRequestStatus();
        RequestStatus storage storedRequest = requestStatusMap[exitRequestsHash];

        if (storedRequest.contractVersion == 0) {
            revert ExitHashNotSubmitted();
        }

        if (storedRequest.deliveryHistoryLength == 0) {
            DeliveryHistory[] memory deliveryHistory;
            return deliveryHistory;
        }

        if (storedRequest.deliveryHistoryLength == 1) {
            DeliveryHistory[] memory deliveryHistory = new DeliveryHistory[](1);
            deliveryHistory[0] = DeliveryHistory(
                storedRequest.lastDeliveredExitDataIndex,
                storedRequest.lastDeliveredExitDataTimestamp
            );
            return deliveryHistory;
        }

        mapping(bytes32 => DeliveryHistory[]) storage deliveryHistoryMap = _storageDeliveryHistory();
        return deliveryHistoryMap[exitRequestsHash];
    }

    /**
     * @notice Returns validator exit request data by index.
     * @param exitRequests Encoded list of validator exit requests.
     * @param dataFormat Format of the encoded exit request data. Currently, only DATA_FORMAT_LIST = 1 is supported.
     * @param index Index of the exit request within the `exitRequests` list.
     * @return pubkey Public key of the validator.
     * @return nodeOpId ID of the node operator.
     * @return moduleId ID of the staking module.
     * @return valIndex Index of the validator.
     */
    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 dataFormat,
        uint256 index
    ) external pure returns (bytes memory pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex) {
        _checkExitRequestData(exitRequests, dataFormat);

        if (index >= exitRequests.length / PACKED_REQUEST_LENGTH) {
            revert ExitDataIndexOutOfRange(index, exitRequests.length / PACKED_REQUEST_LENGTH);
        }

        ValidatorData memory validatorData = _getValidatorData(exitRequests, index);

        valIndex = validatorData.valIndex;
        nodeOpId = validatorData.nodeOpId;
        moduleId = validatorData.moduleId;
        pubkey = validatorData.pubkey;

        return (pubkey, nodeOpId, moduleId, valIndex);
    }

    /// @notice Resume accepting validator exit requests
    ///
    /// @dev Reverts with `PausedExpected()` if contract is already resumed
    /// @dev Reverts with `AccessControl:...` reason if sender has no `RESUME_ROLE`
    ///
    function resume() external whenPaused onlyRole(RESUME_ROLE) {
        _resume();
    }

    /// @notice Pause accepting validator exit requests util in after duration.
    ///
    /// @param _duration Pause duration, seconds (use `PAUSE_INFINITELY` for unlimited).
    /// @dev Reverts with `ResumedExpected()` if contract is already paused.
    /// @dev Reverts with `AccessControl:...` reason if sender has no `PAUSE_ROLE`.
    /// @dev Reverts with `ZeroPauseDuration()` if zero duration is passed.
    ///
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /// @notice Pause accepting report data.
    /// @param _pauseUntilInclusive The last second to pause until.
    /// @dev Reverts with `ResumeSinceInPast()` if the timestamp is in the past.
    /// @dev Reverts with `AccessControl:...` reason if sender has no `PAUSE_ROLE`.
    /// @dev Reverts with `ResumedExpected()` if contract is already paused.
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }

    /// Internal functions

    function _checkExitRequestData(bytes calldata requests, uint256 dataFormat) internal pure {
        if (dataFormat != DATA_FORMAT_LIST) {
            revert UnsupportedRequestsDataFormat(dataFormat);
        }

        if (requests.length == 0 || requests.length % PACKED_REQUEST_LENGTH != 0) {
            revert InvalidRequestsDataLength();
        }
    }

    function _checkMaxBatchSize(bytes calldata requests) internal view {
        uint256 maxRequestsPerBatch = _getMaxRequestsPerBatch();
        uint256 requestsCount = requests.length / PACKED_REQUEST_LENGTH;

        if (requestsCount > maxRequestsPerBatch) {
            revert MaxRequestsBatchSizeExceeded(requestsCount, maxRequestsPerBatch);
        }
    }

    function _checkExitSubmitted(RequestStatus storage requestStatus) internal view {
        if (requestStatus.contractVersion == 0) {
            revert ExitHashNotSubmitted();
        }
    }

    function _checkDeliveryStarted(RequestStatus storage status) internal view {
        if (status.deliveryHistoryLength == 0) {
            revert DeliveryWasNotStarted();
        }
    }

    function _getCurrentExitLimit() internal view returns (uint256) {
        ExitRequestLimitData memory exitRequestLimitData = EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit();
        if (!exitRequestLimitData.isExitLimitSet()) {
            return type(uint256).max;
        }

        return exitRequestLimitData.calculateCurrentExitLimit(_getTimestamp());
    }

    function _getTimestamp() internal view virtual returns (uint256) {
        return block.timestamp; // solhint-disable-line not-rely-on-time
    }

    function _setMaxRequestsPerBatch(uint256 value) internal {
        MAX_VALIDATORS_PER_BATCH_POSITION.setStorageUint256(value);
    }

    function _getMaxRequestsPerBatch() internal view returns (uint256) {
        return MAX_VALIDATORS_PER_BATCH_POSITION.getStorageUint256();
    }

    function _setExitRequestLimit(uint256 maxExitRequestsLimit, uint256 exitsPerFrame, uint256 frameDuration) internal {
        require(maxExitRequestsLimit >= exitsPerFrame, "TOO_LARGE_TW_EXIT_REQUEST_LIMIT");

        uint256 timestamp = _getTimestamp();

        EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(
            EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit().setExitLimits(
                maxExitRequestsLimit,
                exitsPerFrame,
                frameDuration,
                timestamp
            )
        );

        emit ExitRequestsLimitSet(maxExitRequestsLimit, exitsPerFrame, frameDuration);
    }

    function _consumeLimit(uint256 requestsCount) internal returns (uint256 requestsToDeliver) {
        ExitRequestLimitData memory exitRequestLimitData = EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit();
        if (!exitRequestLimitData.isExitLimitSet()) {
            return requestsCount;
        }

        uint256 limit = exitRequestLimitData.calculateCurrentExitLimit(_getTimestamp());

        if (limit == 0) {
            revert ExitRequestsLimit(requestsCount, 0);
        }

        requestsToDeliver = limit >= requestsCount ? requestsCount : limit;
        EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(
            exitRequestLimitData.updatePrevExitLimit(limit - requestsToDeliver, _getTimestamp())
        );
    }

    function _storeNewHashRequestStatus(bytes32 exitRequestsHash, RequestStatus memory requestStatus) internal {
        mapping(bytes32 => RequestStatus) storage requestStatusMap = _storageRequestStatus();
        RequestStatus storage storedRequest = requestStatusMap[exitRequestsHash];

        if (storedRequest.contractVersion != 0) {
            revert ExitHashAlreadySubmitted();
        }

        storedRequest.contractVersion = requestStatus.contractVersion;
        storedRequest.deliveryHistoryLength = requestStatus.deliveryHistoryLength;
        storedRequest.lastDeliveredExitDataIndex = requestStatus.lastDeliveredExitDataIndex;
        storedRequest.lastDeliveredExitDataTimestamp = requestStatus.lastDeliveredExitDataTimestamp;

        emit RequestsHashSubmitted(exitRequestsHash);
    }

    function _updateRequestStatus(
        RequestStatus storage requestStatus,
        uint256 deliveryHistoryLength,
        uint256 lastDeliveredExitDataIndex,
        uint256 lastDeliveredExitDataTimestamp
    ) internal {
        require(deliveryHistoryLength <= type(uint32).max, "DELIVERY_HISTORY_LENGTH_OVERFLOW");
        require(lastDeliveredExitDataIndex <= type(uint32).max, "LAST_DELIVERED_EXIT_DATA_INDEX_OVERFLOW");
        require(lastDeliveredExitDataTimestamp <= type(uint32).max, "LAST_DELIVERED_EXIT_DATA_TIMESTAMP_OVERFLOW");

        requestStatus.deliveryHistoryLength = uint32(deliveryHistoryLength);
        requestStatus.lastDeliveredExitDataIndex = uint32(lastDeliveredExitDataIndex);
        requestStatus.lastDeliveredExitDataTimestamp = uint32(lastDeliveredExitDataTimestamp);
    }

    function _storeDeliveryEntry(
        bytes32 exitRequestsHash,
        uint256 lastDeliveredExitDataIndex,
        uint256 lastDeliveredExitDataTimestamp
    ) internal {
        require(lastDeliveredExitDataIndex <= type(uint32).max, "LAST_DELIVERED_EXIT_DATA_INDEX_OVERFLOW");
        require(lastDeliveredExitDataTimestamp <= type(uint32).max, "LAST_DELIVERED_EXIT_DATA_TIMESTAMP_OVERFLOW");

        mapping(bytes32 => DeliveryHistory[]) storage deliveryHistoryMap = _storageDeliveryHistory();
        DeliveryHistory[] storage deliveryHistory = deliveryHistoryMap[exitRequestsHash];
        deliveryHistory.push(
            DeliveryHistory(uint32(lastDeliveredExitDataIndex), uint32(lastDeliveredExitDataTimestamp))
        );
    }

    /// Methods for reading data from tightly packed validator exit requests
    /// Format DATA_FORMAT_LIST = 1;

    /**
     * @notice Method for reading node operator id, module id and validator index from validator exit request data
     * @param exitRequestData Validator exit requests data. DATA_FORMAT = 1
     * @param index index of request in array above
     * @return validatorData Validator data including node operator id, module id, validator index
     */
    function _getValidatorData(
        bytes calldata exitRequestData,
        uint256 index
    ) internal pure returns (ValidatorData memory validatorData) {
        uint256 itemOffset;
        uint256 dataWithoutPubkey;

        assembly {
            // Compute the start of this packed request (item)
            itemOffset := add(exitRequestData.offset, mul(PACKED_REQUEST_LENGTH, index))

            // Load the first 16 bytes which contain moduleId (24 bits),
            // nodeOpId (40 bits), and valIndex (64 bits).
            dataWithoutPubkey := shr(128, calldataload(itemOffset))
        }

        // dataWithoutPubkey format (128 bits total):
        // MSB <-------------------- 128 bits --------------------> LSB
        // |   128 bits: zeros  | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: valIndex |

        validatorData.valIndex = uint64(dataWithoutPubkey);
        validatorData.nodeOpId = uint40(dataWithoutPubkey >> 64);
        validatorData.moduleId = uint24(dataWithoutPubkey >> (64 + 40));

        bytes memory pubkey = new bytes(PUBLIC_KEY_LENGTH);
        assembly {
            itemOffset := add(exitRequestData.offset, mul(PACKED_REQUEST_LENGTH, index))
            let pubkeyCalldataOffset := add(itemOffset, 16)
            let pubkeyMemPtr := add(pubkey, 32)
            calldatacopy(pubkeyMemPtr, pubkeyCalldataOffset, PUBLIC_KEY_LENGTH)
        }

        validatorData.pubkey = pubkey;
    }

    /**
     * This method read report data (DATA_FORMAT=1) within a range
     * Check dataWithoutPubkey <= lastDataWithoutPubkey needs to prevent duplicates
     */
    function _processExitRequestsList(bytes calldata data, uint256 startIndex, uint256 count) internal {
        uint256 offset;
        uint256 offsetPastEnd;
        uint256 lastDataWithoutPubkey = 0;
        uint256 timestamp = _getTimestamp();

        assembly {
            offset := add(data.offset, mul(startIndex, PACKED_REQUEST_LENGTH))
            offsetPastEnd := add(offset, mul(count, PACKED_REQUEST_LENGTH))
        }

        bytes calldata pubkey;

        assembly {
            pubkey.length := 48
        }

        while (offset < offsetPastEnd) {
            uint256 dataWithoutPubkey;
            assembly {
                // 16 most significant bytes are taken by module id, node op id, and val index
                dataWithoutPubkey := shr(128, calldataload(offset))
                // the next 48 bytes are taken by the pubkey
                pubkey.offset := add(offset, 16)
                // totalling to 64 bytes
                offset := add(offset, 64)
            }
            //                              dataWithoutPubkey
            // MSB <---------------------------------------------------------------------- LSB
            // | 128 bits: zeros | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: valIndex |
            if (dataWithoutPubkey <= lastDataWithoutPubkey) {
                revert InvalidRequestsDataSortOrder();
            }

            uint64 valIndex = uint64(dataWithoutPubkey);
            uint256 nodeOpId = uint40(dataWithoutPubkey >> 64);
            uint256 moduleId = uint24(dataWithoutPubkey >> (64 + 40));

            if (moduleId == 0) {
                revert InvalidRequestsData();
            }

            lastDataWithoutPubkey = dataWithoutPubkey;
            emit ValidatorExitRequest(moduleId, nodeOpId, valIndex, pubkey, timestamp);
        }
    }

    /// Storage helpers

    function _storageRequestStatus() internal pure returns (mapping(bytes32 => RequestStatus) storage r) {
        bytes32 position = REQUEST_STATUS_POSITION;
        assembly {
            r.slot := position
        }
    }

    function _storageDeliveryHistory() internal pure returns (mapping(bytes32 => DeliveryHistory[]) storage r) {
        bytes32 position = DELIVERY_HISTORY_POSITION;
        assembly {
            r.slot := position
        }
    }
}
