// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {UnstructuredStorage} from "../lib/UnstructuredStorage.sol";
import {ILidoLocator} from "../../common/interfaces/ILidoLocator.sol";
import {Versioned} from "../utils/Versioned.sol";
import {ExitRequestLimitData, ExitLimitUtilsStorage, ExitLimitUtils} from "../lib/ExitLimitUtils.sol";
import {PausableUntil} from "../utils/PausableUntil.sol";
import {IValidatorsExitBus} from "../interfaces/IValidatorExitBus.sol";

interface IWithdrawalVault {
    function addWithdrawalRequests(bytes calldata pubkeys, uint64[] calldata amounts) external payable;

    function getWithdrawalRequestFee() external view returns (uint256);
}

interface IStakingRouter {
    function onValidatorExitTriggered(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bytes calldata _publicKey,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) external;
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
    error ExitHashWasNotSubmitted();

    /**
     * TODO: do we need this error ?
     * @notice Throw when in emitExitEvents all requests were already delivered
     */
    error RequestsAlreadyDelivered();

    error KeyWasNotDelivered(uint256 keyIndex, uint256 lastDeliveredKeyIndex);

    /**
     * @notice Thrown when a withdrawal fee insufficient
     * @param feeRequired Amount of fee required to cover withdrawal request
     * @param passedValue Amount of fee sent to cover withdrawal request
     */
    error InsufficientWithdrawalFee(uint256 feeRequired, uint256 passedValue);

    /**
     * @notice Index in
     */
    error KeyIndexOutOfRange(uint256 keyIndex, uint256 totalItemsCount);

    /**
     * @notice Thrown when a withdrawal fee refund failed
     */
    error TriggerableWithdrawalFeeRefundFailed();

    /// @dev Events
    event MadeRefund(address sender, uint256 refundValue); // maybe we dont need it
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
    bytes32 public constant TW_EXIT_REQUEST_LIMIT_POSITION = keccak256("lido.ValidatorsExitBus.twExitDailyLimit");

    /// @dev Ensures the contract’s ETH balance is unchanged.
    modifier preservesEthBalance() {
        uint256 balanceBeforeCall = address(this).balance - msg.value;
        _;
        assert(address(this).balance == balanceBeforeCall);
    }

    constructor(address lidoLocator) {
        LOCATOR = ILidoLocator(lidoLocator);
    }

    /// @notice Method for submitting request hash by trusted entities
    /// @param exitReportHash Request hash
    /// @dev After request was stored anyone can deliver it via emitExitEvents method below
    function submitReportHash(bytes32 exitReportHash) external whenResumed onlyRole(SUBMIT_REPORT_HASH_ROLE) {
        uint256 contractVersion = getContractVersion();
        _storeExitRequestHash(exitReportHash, type(uint256).max, 0, contractVersion, DeliveryHistory(0, 0));
    }

    /// @notice Method to emit exit events by providing report data, the hash of which was previously stored
    /// @param request Exit request data struct
    function emitExitEvents(ExitRequestData calldata request) external whenResumed {
        bytes calldata data = request.data;

        RequestStatus storage requestStatus = _storageExitRequestsHashes()[
            keccak256(abi.encode(data, request.dataFormat))
        ];

        _checkExitWasSubmitted(requestStatus);
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

    /// @notice Triggers exits on the EL via the Withdrawal Vault contract
    /// @param request Exit request data struct
    /// @param keyIndexes Array of indexes of requests in request.data
    /// @param refundRecipient Address to return extra fee on TW (eip-7002) exit
    /// @param exitType type of request. 0 - non-refundable, 1 - require refund
    /// @dev This function verifies that the hash of the provided exit request data exists in storage
    // and ensures that the events for the requests specified in the `keyIndexes` array have already been delivered.
    // Verify that keyIndexes amount fits within the limits
    function triggerExits(
        ExitRequestData calldata request,
        uint256[] calldata keyIndexes,
        address refundRecipient,
        uint8 exitType
    ) external payable whenResumed preservesEthBalance {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        // If the refund recipient is not set, use the sender as the refund recipient
        if (refundRecipient == address(0)) {
            refundRecipient = msg.sender;
        }

        // bytes calldata data = request.data;
        RequestStatus storage requestStatus = _storageExitRequestsHashes()[
            keccak256(abi.encode(request.data, request.dataFormat))
        ];

        _checkExitWasSubmitted(requestStatus);
        _checkExitRequestData(request);
        _checkContractVersion(requestStatus.contractVersion);

        uint256 withdrawalFee = IWithdrawalVault(LOCATOR.withdrawalVault()).getWithdrawalRequestFee();

        if (msg.value < keyIndexes.length * withdrawalFee) {
            revert InsufficientWithdrawalFee(keyIndexes.length * withdrawalFee, msg.value);
        }

        ExitRequestLimitData memory exitRequestLimitData = TW_EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit();
        exitRequestLimitData.checkLimit(keyIndexes.length, _getTimestamp());
        TW_EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(
            exitRequestLimitData.updateRequestsCounter(keyIndexes.length, _getTimestamp())
        );

        bytes memory pubkeys = new bytes(keyIndexes.length * PUBLIC_KEY_LENGTH);
        bytes memory pubkey = new bytes(PUBLIC_KEY_LENGTH);

        for (uint256 i = 0; i < keyIndexes.length; i++) {
            if (keyIndexes[i] >= requestStatus.totalItemsCount) {
                revert KeyIndexOutOfRange(keyIndexes[i], requestStatus.totalItemsCount);
            }

            if (keyIndexes[i] > (requestStatus.deliveredItemsCount - 1)) {
                revert KeyWasNotDelivered(keyIndexes[i], requestStatus.deliveredItemsCount - 1);
            }

            ValidatorData memory validatorData = _getValidatorData(request.data, keyIndexes[i]);
            if (validatorData.moduleId == 0) revert InvalidRequestsData();
            pubkey = validatorData.pubkey;

            assembly {
                let pubkeyMemPtr := add(pubkey, 32)
                let dest := add(pubkeys, add(32, mul(PUBLIC_KEY_LENGTH, i)))
                mstore(dest, mload(pubkeyMemPtr))
                mstore(add(dest, 32), mload(add(pubkeyMemPtr, 32)))
            }

            IStakingRouter(LOCATOR.stakingRouter()).onValidatorExitTriggered(
                validatorData.moduleId,
                validatorData.nodeOpId,
                pubkey,
                withdrawalFee,
                exitType
            );
        }

        IWithdrawalVault(LOCATOR.withdrawalVault()).addWithdrawalRequests{value: keyIndexes.length * withdrawalFee}(
            pubkeys,
            new uint64[](keyIndexes.length)
        );

        _refundFee(keyIndexes.length * withdrawalFee, refundRecipient);
    }

    /// @notice Directly emit exit events and request validators through the TW to exit them without delivering hashes and any proving
    /// @param exitData Direct exit request data struct
    /// @param refundRecipient Address to return extra fee on TW (eip-7002) exit
    /// @param exitType type of request. 0 - non-refundable, 1 - require refund
    /// @dev  Verify that requests amount fits within the limits
    function triggerExitsDirectly(
        DirectExitData calldata exitData,
        address refundRecipient,
        uint8 exitType
    ) external payable whenResumed onlyRole(DIRECT_EXIT_ROLE) preservesEthBalance {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        // If the refund recipient is not set, use the sender as the refund recipient
        if (refundRecipient == address(0)) {
            refundRecipient = msg.sender;
        }

        if (exitData.validatorsPubkeys.length == 0) {
            revert ZeroArgument("exitData.validatorsPubkeys");
        }

        if (exitData.validatorsPubkeys.length % PUBLIC_KEY_LENGTH != 0) {
            revert InvalidPubkeysArray();
        }

        uint256 requestsCount = exitData.validatorsPubkeys.length / PUBLIC_KEY_LENGTH;
        uint256 withdrawalFee = IWithdrawalVault(LOCATOR.withdrawalVault()).getWithdrawalRequestFee();

        if (msg.value < withdrawalFee * requestsCount) {
            revert InsufficientWithdrawalFee(withdrawalFee * requestsCount, msg.value);
        }

        ExitRequestLimitData memory exitRequestLimitData = TW_EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit();
        exitRequestLimitData.checkLimit(requestsCount, _getTimestamp());
        TW_EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(
            exitRequestLimitData.updateRequestsCounter(requestsCount, _getTimestamp())
        );

        for (uint256 i = 0; i < requestsCount; i++) {
            bytes memory pubkey = new bytes(PUBLIC_KEY_LENGTH);

            pubkey = _getPubkey(exitData.validatorsPubkeys, i);

            IStakingRouter(LOCATOR.stakingRouter()).onValidatorExitTriggered(
                exitData.stakingModuleId,
                exitData.nodeOperatorId,
                pubkey,
                withdrawalFee,
                exitType
            );

            emit DirectExitRequest(
                exitData.stakingModuleId,
                exitData.nodeOperatorId,
                pubkey,
                _getTimestamp(),
                refundRecipient
            );
        }

        uint64[] memory amount = new uint64[](requestsCount);
        IWithdrawalVault(LOCATOR.withdrawalVault()).addWithdrawalRequests{value: withdrawalFee * requestsCount}(
            exitData.validatorsPubkeys,
            amount
        );

        _refundFee(requestsCount * withdrawalFee, refundRecipient);
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

        TW_EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(
            TW_EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit().setExitDailyLimit(twExitsDailyLimit, timestamp)
        );

        emit ExitRequestsLimitSet(exitsDailyLimit, twExitsDailyLimit);
    }

    function getExitRequestsDeliveryHistory(
        bytes32 exitRequestsHash
    ) external view returns (uint256 totalItemsCount, uint256 deliveredItemsCount, DeliveryHistory[] memory history) {
        RequestStatus storage requestStatus = _storageExitRequestsHashes()[exitRequestsHash];

        _checkExitWasSubmitted(requestStatus);

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

    function _checkExitWasSubmitted(RequestStatus storage requestStatus) internal view {
        if (requestStatus.contractVersion == 0) {
            revert ExitHashWasNotSubmitted();
        }
    }

    function _refundFee(uint256 fee, address recipient) internal returns (uint256) {
        uint256 refund = msg.value - fee;

        if (refund > 0) {
            (bool success, ) = recipient.call{value: refund}("");

            if (!success) {
                revert TriggerableWithdrawalFeeRefundFailed();
            }

            emit MadeRefund(msg.sender, refund);
        }

        return refund;
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
     * @notice Method for reading public key value from pubkeys list
     * @param pubkeys Concatenated list of pubkeys
     * @param index index of pubkey in array above
     * @return pubkey Validator public key
     */
    function _getPubkey(bytes calldata pubkeys, uint256 index) internal pure returns (bytes memory pubkey) {
        pubkey = new bytes(PUBLIC_KEY_LENGTH);

        assembly {
            let offset := add(pubkeys.offset, mul(index, PUBLIC_KEY_LENGTH))
            let dest := add(pubkey, 0x20)
            calldatacopy(dest, offset, PUBLIC_KEY_LENGTH)
        }
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

    /// Storage helpers
    function _storageExitRequestsHashes() internal pure returns (mapping(bytes32 => RequestStatus) storage r) {
        bytes32 position = EXIT_REQUESTS_HASHES_POSITION;
        assembly {
            r.slot := position
        }
    }
}
