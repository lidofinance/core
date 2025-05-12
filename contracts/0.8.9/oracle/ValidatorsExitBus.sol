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

interface ITriggerableWithdrawalGateway {
    function triggerFullWithdrawals(
        bytes calldata triggerableExitData,
        address refundRecipient,
        uint8 exitType
    ) external payable;
}

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
     * @notice Thrown than module id equal to zero
     */
    error InvalidRequestsData();

    /**
     * TODO: maybe this part will be deleted
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

    error KeyWasNotDelivered(uint256 keyIndex, uint256 lastDeliveredKeyIndex);

    error KeyIndexOutOfRange(uint256 keyIndex, uint256 totalItemsCount);

    /**
     * @notice Thrown when a withdrawal fee refund failed
     */
    error TriggerableWithdrawalFeeRefundFailed();

    /// @dev Events
    event StoredExitRequestHash(bytes32 exitRequestHash);
    event ValidatorExitRequest(
        uint256 indexed stakingModuleId,
        uint256 indexed nodeOperatorId,
        uint256 indexed validatorIndex,
        bytes validatorPubkey,
        uint256 timestamp
    );
    event ExitRequestsLimitSet(uint256 exitRequestsLimit, uint256 twExitRequestsLimit);

    event DirectExitRequest(
        uint256 indexed stakingModuleId,
        uint256 indexed nodeOperatorId,
        bytes validatoPubkey,
        uint256 timestamp,
        address indexed refundRecipient
    );
    struct RequestStatus {
        // Total items count in report (by default type(uint32).max, update on first report delivery)
        uint256 totalItemsCount;
        // Total processed items in report (by default 0)
        uint256 deliveredItemsCount;
        // Vebo contract version at the time of hash submission
        uint256 contractVersion;
        DeliveryHistory[] deliverHistory;
    }

    struct ValidatorData {
        uint256 nodeOpId;
        uint256 moduleId;
        uint256 valIndex;
        bytes pubkey;
    }

    bytes32 public constant SUBMIT_REPORT_HASH_ROLE = keccak256("SUBMIT_REPORT_HASH_ROLE");
    bytes32 public constant DIRECT_EXIT_ROLE = keccak256("DIRECT_EXIT_ROLE");
    bytes32 public constant EXIT_REPORT_LIMIT_ROLE = keccak256("EXIT_REPORT_LIMIT_ROLE");
    /// @notice An ACL role granting the permission to pause accepting validator exit requests
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    /// @notice An ACL role granting the permission to resume accepting validator exit requests
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");

    /// Length in bytes of packed request
    uint256 internal constant PACKED_REQUEST_LENGTH = 64;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    uint256 internal constant PACKED_TWG_EXIT_REQUEST_LENGTH = 56;

    ILidoLocator internal immutable LOCATOR;

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

    /// Hash constant for mapping exit requests storage
    bytes32 internal constant EXIT_REQUESTS_HASHES_POSITION = keccak256("lido.ValidatorsExitBus.reportHashes");
    bytes32 public constant EXIT_REQUEST_LIMIT_POSITION = keccak256("lido.ValidatorsExitBus.exitDailyLimit");

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
        RequestStatus storage requestStatus = _storageExitRequestsHashes()[exitRequestsHash];
        _checkExitNotSubmitted(requestStatus);

        uint256 contractVersion = getContractVersion();
        _storeExitRequestHash(exitRequestsHash, type(uint256).max, 0, contractVersion, DeliveryHistory(0, 0));
    }

    /**
     * @notice Method for submitting exit requests data
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
    function submitExitRequestsData(ExitRequestData calldata request) external whenResumed {
        bytes calldata data = request.data;

        RequestStatus storage requestStatus = _storageExitRequestsHashes()[
            keccak256(abi.encode(data, request.dataFormat))
        ];

        _checkExitSubmitted(requestStatus);
        _checkExitRequestData(request);
        _checkContractVersion(requestStatus.contractVersion);

        // By default, totalItemsCount is set to type(uint256).max.
        // If an exit is emitted for the request for the first time, the default value is used for totalItemsCount.
        if (requestStatus.totalItemsCount == type(uint256).max) {
            requestStatus.totalItemsCount = request.data.length / PACKED_REQUEST_LENGTH;
        }

        uint256 undeliveredItemsCount = requestStatus.totalItemsCount - requestStatus.deliveredItemsCount;

        if (undeliveredItemsCount == 0) {
            revert RequestsAlreadyDelivered();
        }

        ExitRequestLimitData memory exitRequestLimitData = EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit();
        uint256 requestsToDeliver = exitRequestLimitData.consumeLimit(undeliveredItemsCount, _getTimestamp());
        EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(
            exitRequestLimitData.updateRequestsCounter(requestsToDeliver, _getTimestamp())
        );

        require(
            requestStatus.totalItemsCount >= requestStatus.deliveredItemsCount + requestsToDeliver,
            "INDEX_OUT_OF_RANGE"
        );

        _processExitRequestsList(request.data, requestStatus.deliveredItemsCount, requestsToDeliver);

        require(requestStatus.deliveredItemsCount + requestsToDeliver - 1 >= 0, "WRONG_REQUESTS_TO_DELIVER_VALUE");

        requestStatus.deliverHistory.push(
            DeliveryHistory(requestStatus.deliveredItemsCount + requestsToDeliver - 1, _getTimestamp())
        );
        requestStatus.deliveredItemsCount += requestsToDeliver;
    }

    /**
     * @notice Submits Triggerable Withdrawal Requests to the Triggerable Withdrawals Gateway.
     *
     * @param requestsData The report data previously unpacked and emitted by the VEB.
     * @param keyIndexes Array of indexes pointing to validators in `requestsData.data`
     *                   to be exited via TWR.
     * @param refundRecipient Address to return extra fee on TW (eip-7002) exit
     * @param exitType type of request. 0 - non-refundable, 1 - require refund
     *
     * @dev Reverts if:
     *     - The hash of `requestsData` was not previously submitted in the VEB.
     *     - Any of the provided `keyIndexes` refers to a validator that was not yet unpacked (i.e., exit requiest not emitted).
     */
    function triggerExits(
        ExitRequestData calldata requestsData,
        uint256[] calldata keyIndexes,
        address refundRecipient,
        uint8 exitType
    ) external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        // If the refund recipient is not set, use the sender as the refund recipient
        if (refundRecipient == address(0)) {
            refundRecipient = msg.sender;
        }

        // bytes calldata data = request.data;
        RequestStatus storage requestStatus = _storageExitRequestsHashes()[
            keccak256(abi.encode(requestsData.data, requestsData.dataFormat))
        ];

        _checkExitSubmitted(requestStatus);
        _checkExitRequestData(requestsData);
        _checkContractVersion(requestStatus.contractVersion);

        bytes memory exits = new bytes(keyIndexes.length * PACKED_TWG_EXIT_REQUEST_LENGTH);

        for (uint256 i = 0; i < keyIndexes.length; i++) {
            if (keyIndexes[i] >= requestStatus.totalItemsCount) {
                revert KeyIndexOutOfRange(keyIndexes[i], requestStatus.totalItemsCount);
            }

            if (keyIndexes[i] > (requestStatus.deliveredItemsCount - 1)) {
                revert KeyWasNotDelivered(keyIndexes[i], requestStatus.deliveredItemsCount - 1);
            }

            ValidatorData memory validatorData = _getValidatorData(requestsData.data, keyIndexes[i]);
            if (validatorData.moduleId == 0) revert InvalidRequestsData();

            _copyValidatorData(validatorData, exits, i);
        }

        ITriggerableWithdrawalGateway(LOCATOR.triggerableWithdrawalGateway()).triggerFullWithdrawals{value: msg.value}(
            exits,
            refundRecipient,
            exitType
        );
    }

    function setExitRequestLimit(
        uint256 exitsDailyLimit,
        uint256 twExitsDailyLimit
    ) external onlyRole(EXIT_REPORT_LIMIT_ROLE) {
        require(exitsDailyLimit != 0, "ZERO_MAX_EXIT_REQUEST_LIMIT");
        require(twExitsDailyLimit != 0, "ZERO_MAX_TW_EXIT_REQUEST_LIMIT");
        require(exitsDailyLimit >= twExitsDailyLimit, "TOO_LARGE_TW_EXIT_REQUEST_LIMIT");

        uint256 timestamp = _getTimestamp();

        EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(
            EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit().setExitDailyLimit(exitsDailyLimit, timestamp)
        );

        emit ExitRequestsLimitSet(exitsDailyLimit, twExitsDailyLimit);
    }

    /**
     * @notice Returns unpacking history and current status for specific exitRequestsData
     *
     * @dev Reverts if such exitRequestsHash was not submited.
     *
     * @param exitRequestsHash - The exit requests hash.
     */
    function getExitRequestsDeliveryHistory(
        bytes32 exitRequestsHash
    ) external view returns (uint256 totalItemsCount, uint256 deliveredItemsCount, DeliveryHistory[] memory history) {
        RequestStatus storage requestStatus = _storageExitRequestsHashes()[exitRequestsHash];

        _checkExitSubmitted(requestStatus);

        return (requestStatus.totalItemsCount, requestStatus.deliveredItemsCount, requestStatus.deliverHistory);
    }

    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 dataFormat,
        uint256 index
    ) external pure returns (bytes memory pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex) {
        if (dataFormat != DATA_FORMAT_LIST) {
            revert UnsupportedRequestsDataFormat(dataFormat);
        }

        if (exitRequests.length % PACKED_REQUEST_LENGTH != 0) {
            revert InvalidRequestsDataLength();
        }

        if (index >= exitRequests.length / PACKED_REQUEST_LENGTH) {
            revert KeyIndexOutOfRange(index, exitRequests.length / PACKED_REQUEST_LENGTH);
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

    /// @notice Pause accepting validator exit requests util in after duration
    ///
    /// @param _duration pause duration, seconds (use `PAUSE_INFINITELY` for unlimited)
    /// @dev Reverts with `ResumedExpected()` if contract is already paused
    /// @dev Reverts with `AccessControl:...` reason if sender has no `PAUSE_ROLE`
    /// @dev Reverts with `ZeroPauseDuration()` if zero duration is passed
    ///
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /// @notice Pause accepting report data
    /// @param _pauseUntilInclusive the last second to pause until
    /// @dev Reverts with `ResumeSinceInPast()` if the timestamp is in the past
    /// @dev Reverts with `AccessControl:...` reason if sender has no `PAUSE_ROLE`
    /// @dev Reverts with `ResumedExpected()` if contract is already paused
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }

    /// Internal functions

    // TODO: fixed to be used in unpackExitRequest too
    function _checkExitRequestData(ExitRequestData calldata request) internal pure {
        if (request.dataFormat != DATA_FORMAT_LIST) {
            revert UnsupportedRequestsDataFormat(request.dataFormat);
        }

        if (request.data.length % PACKED_REQUEST_LENGTH != 0) {
            revert InvalidRequestsDataLength();
        }
    }

    function _checkExitSubmitted(RequestStatus storage requestStatus) internal view {
        if (requestStatus.contractVersion == 0) {
            revert ExitHashNotSubmitted();
        }
    }

    function _checkExitNotSubmitted(RequestStatus storage requestStatus) internal view {
        if (requestStatus.contractVersion != 0) {
            revert ExitHashAlreadySubmitted();
        }
    }

    function _getTimestamp() internal view virtual returns (uint256) {
        return block.timestamp; // solhint-disable-line not-rely-on-time
    }

    function _storeExitRequestHash(
        bytes32 exitRequestHash,
        uint256 totalItemsCount,
        uint256 deliveredItemsCount,
        uint256 contractVersion,
        DeliveryHistory memory history
    ) internal {
        mapping(bytes32 => RequestStatus) storage hashes = _storageExitRequestsHashes();
        RequestStatus storage request = hashes[exitRequestHash];

        require(request.contractVersion == 0, "Hash already exists");

        request.totalItemsCount = totalItemsCount;
        request.deliveredItemsCount = deliveredItemsCount;
        request.contractVersion = contractVersion;
        if (history.timestamp != 0) {
            request.deliverHistory.push(history);
        }

        emit StoredExitRequestHash(exitRequestHash);
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
     * check dataWithoutPubkey <= lastDataWithoutPubkey needs to prevent duplicates
     * However, it seems that duplicates are no longer an issue.
     * But this logic prevent use of _getValidatorData method here
     *
     * check what will happen if startIndex bigger than length of data
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

    /// Methods for working with TWG exit data type
    /// | MSB <------------------------------------------------ LSB
    /// |       3 bytes     |     5 bytes      |    48 bytes     |
    /// |  stakingModuleId  |  nodeOperatorId  | validatorPubkey |

    function _copyValidatorData(
        ValidatorData memory validatorData,
        bytes memory exitData,
        uint256 index
    ) internal pure {
        uint256 nodeOpId = validatorData.nodeOpId;
        uint256 moduleId = validatorData.moduleId;
        bytes memory pubkey = validatorData.pubkey;

        assembly {
            let exitDataOffset := add(exitData, add(32, mul(56, index)))
            let id := or(shl(40, moduleId), nodeOpId)
            mstore(exitDataOffset, shl(192, id))
            let pubkeyOffset := add(pubkey, 32)
            mstore(add(exitDataOffset, 8), mload(pubkeyOffset))
            mstore(add(exitDataOffset, 40), mload(add(pubkeyOffset, 32)))
        }
    }

    /// Storage helpers
    function _storageExitRequestsHashes() internal pure returns (mapping(bytes32 => RequestStatus) storage r) {
        bytes32 position = EXIT_REQUESTS_HASHES_POSITION;
        assembly {
            r.slot := position
        }
    }
}
