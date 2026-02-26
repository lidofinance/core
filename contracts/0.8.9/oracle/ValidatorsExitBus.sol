// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {UnstructuredStorage} from "../lib/UnstructuredStorage.sol";
import {Versioned} from "../utils/Versioned.sol";
import {LimitData, RateLimitStorage, RateLimit} from "../../common/lib/RateLimit.sol";
import {PausableUntil} from "../utils/PausableUntil.sol";

interface ITriggerableWithdrawalsGateway {
    struct ValidatorData {
        uint256 stakingModuleId;
        uint256 nodeOperatorId;
        bytes pubkey;
    }

    function triggerFullWithdrawals(
        ValidatorData[] calldata validatorsData,
        address refundRecipient,
        uint256 exitType
    ) external payable;
}

/// @notice New interface for staking modules (CSM, CuratedV2)
/// @dev Returns only pubkeys
interface INewStakingModule {
    /// @dev It also works for legacy staking modules (NOR, SDVT) where `getSigningKeys` returns different
    ///      tuple `(bytes memory pubkeys, bytes memory signatures, bool[] memory used)`.
    ///      The trick: `abi.decode(returndata, (bytes))` will decode only the first tuple element.
    ///      This is safe as long as the first returned value really is `bytes pubkeys` in that position.
    function getSigningKeys(
        uint256 nodeOperatorId,
        uint256 startIndex,
        uint256 keysCount
    ) external view returns (bytes memory);
}

interface INodeOperatorsRegistry {
    function getSigningKey(
        uint256 _nodeOperatorId,
        uint256 _index
    ) external view returns (bytes memory key, bytes memory depositSignature, bool used);
}


interface IStakingRouter {
    struct ModuleStateConfig {
        address moduleAddress;
        uint16 moduleFee;
        uint16 treasuryFee;
        uint16 depositTargetShare;
        uint16 withdrawalProtectShare;
        uint8 status;
        uint8 withdrawalCredentialsType;
    }

    function getStakingModuleStateConfig(uint256 _stakingModuleId)
        external
        view
        returns (ModuleStateConfig memory stateConfig);

    function getStakingModuleMaxEB(uint256 _stakingModuleId) external view returns (uint256);
}

interface ILidoLocator {
    function validatorExitDelayVerifier() external view returns (address);
    function triggerableWithdrawalsGateway() external view returns (address);
    function oracleReportSanityChecker() external view returns(address);
    function stakingRouter() external view returns (address);
}

/**
 * @title ValidatorsExitBus
 * @notice Contract that serves as the central infrastructure for managing validator exit requests.
 * It stores report hashes, emits exit events, and maintains data and tools that enables anyone to prove a validator was requested to exit.
 */
abstract contract ValidatorsExitBus is AccessControlEnumerable, PausableUntil, Versioned {
    using UnstructuredStorage for bytes32;

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
    error InvalidModuleId();

    /**
     * @notice Thrown when data submitted for exit requests was not sorted in ascending order or contains duplicates
     */
    error InvalidRequestsDataSortOrder();

    /**
     * @notice Thrown when provided public key does not match the registered signing key
     * @param index Index of the validator in the exit request list
     */
    error InvalidPublicKey(uint256 index);

    /**
     * @notice Thrown when retrieved pubkey length is invalid
     */
    error InvalidRetrievedKeyLength();

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
     * @notice Thrown when index of request in submitted data for triggerable withdrawal is out of range
     * @param exitDataIndex Index of request
     * @param requestsCount Amount of requests that were sent for processing
     */
    error ExitDataIndexOutOfRange(uint256 exitDataIndex, uint256 requestsCount);

    /**
     * @notice Thrown when array of indexes of requests in submitted data for triggerable withdrawal is not is not strictly increasing array
     */
    error InvalidExitDataIndexSortOrder();

    /**
     * @notice Thrown when remaining exit balance limit is not enough to cover the exit requests
     * @param balanceEth Total balance being requested for exit in ETH
     * @param remainingLimitEth Remaining balance limit in ETH that can still be processed
     */
    error ExitRequestsLimitExceeded(uint256 balanceEth, uint256 remainingLimitEth);

    /**
     * @notice Thrown when submitting was not started for request
     */
    error RequestsNotDelivered();

    /**
     * @notice Thrown when exit requests in report exceed the maximum allowed number of requests per report.
     * @param requestsCount  Amount of requests that were sent for processing
     */
    error TooManyExitRequestsInReport(uint256 requestsCount, uint256 maxRequestsPerReport);

    error UnexpectedMaxEB();

    /**
     * @notice Emitted when an entity with the SUBMIT_REPORT_HASH_ROLE role submits a hash of the exit requests data.
     * @param exitRequestsHash keccak256 hash of the encoded validators list
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
     * @notice Emitted when limits configs are set.
     * @param maxExitBalanceEth The maximum exit balance limit in ETH.
     * @param balancePerFrameEth The exit balance in ETH that can be restored per frame.
     * @param frameDurationInSec The duration of each frame, in seconds, after which `balancePerFrameEth` can be restored.
     */
    event ExitBalanceLimitSet(uint256 maxExitBalanceEth, uint256 balancePerFrameEth, uint256 frameDurationInSec);

    /**
     * @notice Emitted when exit requests were delivered
     * @param exitRequestsHash keccak256 hash of the encoded validators list
     */
    event ExitDataProcessing(bytes32 exitRequestsHash);

    /**
     * @notice Emitted when max validators per report value is set.
     * @param maxValidatorsPerReport The number of validators allowed per report.
     */
    event SetMaxValidatorsPerReport(uint256 maxValidatorsPerReport);

    struct ExitRequestsData {
        bytes data;
        uint256 dataFormat;
    }

    struct ValidatorData {
        uint256 nodeOpId;
        uint256 moduleId;
        uint256 valIndex;
        uint256 keyIndex;  // - will be max uint256 for format 1, actual value for format 2
        bytes pubkey;
    }

    // RequestStatus stores timestamp of delivery, and contract version.
    struct RequestStatus {
        uint32 contractVersion;
        uint32 deliveredExitDataTimestamp;
    }

    /// @notice An ACL role granting the permission to submit a hash of the exit requests data
    bytes32 public constant SUBMIT_REPORT_HASH_ROLE = keccak256("SUBMIT_REPORT_HASH_ROLE");
    /// @notice An ACL role granting the permission to set limits configs and MAX_VALIDATORS_PER_REPORT value
    bytes32 public constant EXIT_REQUEST_LIMIT_MANAGER_ROLE = keccak256("EXIT_REQUEST_LIMIT_MANAGER_ROLE");
    /// @notice An ACL role granting the permission to pause accepting validator exit requests
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    /// @notice An ACL role granting the permission to resume accepting validator exit requests
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");

    /// Length in bytes of packed request
    uint256 internal constant PACKED_REQUEST_LENGTH = 64;
    uint256 internal constant PACKED_REQUEST_LENGTH_V2 = 72;

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

    /// @notice The extended list format that includes a key index for each validator.
    ///
    /// Each validator exit request is 72 bytes:
    ///
    /// MSB <-------------------------------------------------------------------- LSB
    /// |  3 bytes   |  5 bytes   |     8 bytes      |   8 bytes  |    48 bytes     |
    /// |  moduleId  |  nodeOpId  |  validatorIndex  |  keyIndex  | validatorPubkey |
    ///
    /// Encoding and sorting rules are identical to `DATA_FORMAT_LIST`.
    /// `keyIndex` is used to validate the pubkey against on-chain registered keys.
    uint256 public constant DATA_FORMAT_LIST_WITH_KEY_INDEX = 2;

    ILidoLocator internal immutable LOCATOR;

    /// @dev Storage slot: uint256 totalRequestsProcessed
    bytes32 internal constant TOTAL_REQUESTS_PROCESSED_POSITION =
        keccak256("lido.ValidatorsExitBusOracle.totalRequestsProcessed");
    // Storage slot for exit balance limit configuration and current quota tracking (in ETH, not Gwei)
    bytes32 internal constant EXIT_BALANCE_LIMIT_POSITION = keccak256("lido.ValidatorsExitBus.exitBalanceLimitEth");
    // Storage slot for the maximum number of validator exit requests allowed per processing report
    bytes32 internal constant MAX_VALIDATORS_PER_REPORT_POSITION =
        keccak256("lido.ValidatorsExitBus.maxValidatorsPerReport");

    // Storage slot for mapping(bytes32 => RequestStatus), keyed by exitRequestsHash
    bytes32 internal constant REQUEST_STATUS_POSITION = keccak256("lido.ValidatorsExitBus.requestStatus");

    uint256 public constant EXIT_TYPE = 2;

    /// @dev Ensures the contract's ETH balance is unchanged.
    modifier preservesEthBalance() {
        uint256 balanceBeforeCall = address(this).balance - msg.value;
        _;
        assert(address(this).balance == balanceBeforeCall);
    }

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
        _storeNewHashRequestStatus(exitRequestsHash, uint32(contractVersion), 0);
    }

    /**
     * @notice Method for submitting exit requests data.
     *
     * @dev Reverts if:
     * - The contract is paused.
     * - The keccak256 hash of `requestsData` does not exist in storage (i.e., was not submitted).
     * - The provided Exit Requests Data has already been submitted.
     * - The contract version does not match the version at the time of hash submission.
     * - The data format is not supported.
     * - The data length exceeds the maximum number of requests allowed per payload.
     * - There is no remaining quota available for the current limits.
     * - The requests was not sorted in strictly increasing order before the report hash submit.
     *
     * Emits `ValidatorExitRequest` events;
     *
     * @param request - The exit requests structure.
     */
    function submitExitRequestsData(ExitRequestsData calldata request) external whenResumed {
        bytes32 exitRequestsHash = keccak256(abi.encode(request.data, request.dataFormat));
        RequestStatus storage requestStatus = _storageRequestStatus()[exitRequestsHash];

        _checkExitSubmitted(requestStatus);
        _checkNotDelivered(requestStatus);
        _checkExitRequestData(request.data, request.dataFormat);
        _checkContractVersion(requestStatus.contractVersion);

        uint256 requestsCount = request.data.length / _getPackedRequestLength(request.dataFormat);
        uint256 maxRequestsPerReport = _getMaxValidatorsPerReport();

        if (requestsCount > maxRequestsPerReport) {
            revert TooManyExitRequestsInReport(requestsCount, maxRequestsPerReport);
        }

        uint256 totalBalanceEth = _calculateTotalExitBalanceEth(request.data, request.dataFormat);
        _consumeLimit(totalBalanceEth);

        _processExitRequestsList(request.data, request.dataFormat);

        TOTAL_REQUESTS_PROCESSED_POSITION.setStorageUint256(
            TOTAL_REQUESTS_PROCESSED_POSITION.getStorageUint256() + requestsCount
        );

        _updateRequestStatus(requestStatus);

        emit ExitDataProcessing(exitRequestsHash);
    }

    /**
     * @notice Submits Triggerable Withdrawal Requests to the Triggerable Withdrawals Gateway.
     *
     * @param exitsData The report data previously submitted by the VEB.
     * @param exitDataIndexes Array of sorted indexes pointing to validators in `exitsData.data`
     * to be exited via TWR.
     * @param refundRecipient Address to return extra fee on TW (eip-7002) exit.
     *
     * @dev Reverts if:
     *     - The contract is paused.
     *     - The keccak256 hash of `requestsData` does not exist in storage (i.e., was not submitted).
     *     - The provided Exit Requests Data has not been previously submitted.
     *     - Any of the provided `exitDataIndexes` refers to an index out of range.
     *     - `exitDataIndexes` is not strictly increasing array
     */
    function triggerExits(
        ExitRequestsData calldata exitsData,
        uint256[] calldata exitDataIndexes,
        address refundRecipient
    ) external payable whenResumed preservesEthBalance {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        if (exitDataIndexes.length == 0) revert ZeroArgument("exitDataIndexes");

        // If the refund recipient is not set, use the sender as the refund recipient
        if (refundRecipient == address(0)) {
            refundRecipient = msg.sender;
        }

        RequestStatus storage requestStatus = _storageRequestStatus()[
            keccak256(abi.encode(exitsData.data, exitsData.dataFormat))
        ];

        _checkExitSubmitted(requestStatus);
        _checkDelivered(requestStatus);
        _checkExitRequestData(exitsData.data, exitsData.dataFormat);

        ITriggerableWithdrawalsGateway.ValidatorData[]
            memory triggerableExitData = new ITriggerableWithdrawalsGateway.ValidatorData[](exitDataIndexes.length);

        uint256 lastExitDataIndex = type(uint256).max;
        uint256 requestsCount = exitsData.data.length / _getPackedRequestLength(exitsData.dataFormat);

        for (uint256 i = 0; i < exitDataIndexes.length; i++) {
            if (exitDataIndexes[i] >= requestsCount) {
                revert ExitDataIndexOutOfRange(exitDataIndexes[i], requestsCount);
            }

            if (i > 0 && exitDataIndexes[i] <= lastExitDataIndex) {
                revert InvalidExitDataIndexSortOrder();
            }

            lastExitDataIndex = exitDataIndexes[i];

            ValidatorData memory validatorData = _getValidatorData(exitsData.data, exitsData.dataFormat, exitDataIndexes[i]);

            if (validatorData.moduleId == 0) revert InvalidModuleId();

            triggerableExitData[i] = ITriggerableWithdrawalsGateway.ValidatorData(
                validatorData.moduleId,
                validatorData.nodeOpId,
                validatorData.pubkey
            );
        }

        ITriggerableWithdrawalsGateway(LOCATOR.triggerableWithdrawalsGateway()).triggerFullWithdrawals{
            value: msg.value
        }(triggerableExitData, refundRecipient, EXIT_TYPE);
    }

    /**
     * @notice Sets the limits config
     * @param maxExitBalanceEth The maximum exit balance limit in ETH.
     * @param balancePerFrameEth The exit balance in ETH that can be restored per frame.
     * @param frameDurationInSec The duration of each frame, in seconds, after which `balancePerFrameEth` can be restored.
     */
    function setExitRequestLimit(
        uint256 maxExitBalanceEth,
        uint256 balancePerFrameEth,
        uint256 frameDurationInSec
    ) external onlyRole(EXIT_REQUEST_LIMIT_MANAGER_ROLE) {
        _setExitRequestLimit(maxExitBalanceEth, balancePerFrameEth, frameDurationInSec);
    }

    /**
     * @notice Returns information about current limits data
     * @return maxExitBalanceEth Maximum exit balance limit in ETH
     * @return balancePerFrameEth The exit balance in ETH that can be restored per frame
     * @return frameDurationInSec The duration of each frame, in seconds, after which `balancePerFrameEth` can be restored
     * @return prevExitBalanceEth Balance limit in ETH left after previous requests
     * @return currentExitBalanceEth Current exit balance limit in ETH
     */
    function getExitRequestLimitFullInfo()
        external
        view
        returns (
            uint256 maxExitBalanceEth,
            uint256 balancePerFrameEth,
            uint256 frameDurationInSec,
            uint256 prevExitBalanceEth,
            uint256 currentExitBalanceEth
        )
    {
        LimitData memory limitData = RateLimitStorage.getStorageLimit(EXIT_BALANCE_LIMIT_POSITION);
        maxExitBalanceEth = limitData.maxLimit;
        balancePerFrameEth = limitData.itemsPerFrame;
        frameDurationInSec = limitData.frameDurationInSec;
        prevExitBalanceEth = limitData.prevLimit;

        currentExitBalanceEth = RateLimit.isLimitSet(limitData)
            ? RateLimit.calculateCurrentLimit(limitData, _getTimestamp())
            : type(uint256).max;
    }

    /**
     * @notice Sets the maximum allowed number of validator exit requests to process in a single report.
     * @param maxRequests The new maximum number of exit requests allowed per report.
     */
    function setMaxValidatorsPerReport(uint256 maxRequests) external onlyRole(EXIT_REQUEST_LIMIT_MANAGER_ROLE) {
        _setMaxValidatorsPerReport(maxRequests);
    }

    /**
     * @notice Returns information about allowed number of validator exit requests to process in a single report.
     * @return The new maximum number of exit requests allowed per report
     */
    function getMaxValidatorsPerReport() external view returns (uint256) {
        return _getMaxValidatorsPerReport();
    }

    /**
     * @notice Returns the timestamp when the exit request was delivered.
     *
     * @param exitRequestsHash - The exit requests hash.
     *
     * @dev Reverts if:
     *     - exitRequestsHash was not submitted
     *     - Request was not submitted
     */
    function getDeliveryTimestamp(bytes32 exitRequestsHash) external view returns (uint256 deliveryDateTimestamp) {
        mapping(bytes32 => RequestStatus) storage requestStatusMap = _storageRequestStatus();
        RequestStatus storage storedRequest = requestStatusMap[exitRequestsHash];

        _checkExitSubmitted(storedRequest);
        _checkDelivered(storedRequest);

        return storedRequest.deliveredExitDataTimestamp;
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

        uint256 requestsCount = exitRequests.length / _getPackedRequestLength(dataFormat);
        if (index >= requestsCount) {
            revert ExitDataIndexOutOfRange(index, requestsCount);
        }

        ValidatorData memory validatorData = _getValidatorData(exitRequests, dataFormat, index);

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

    /// @notice Returns the total number of validator exit requests ever processed
    /// across all received reports.
    ///
    function getTotalRequestsProcessed() external view returns (uint256) {
        return TOTAL_REQUESTS_PROCESSED_POSITION.getStorageUint256();
    }

    /// @dev Returns the packed request length for a given data format
    function _getPackedRequestLength(uint256 dataFormat) internal pure returns (uint256) {
        if (dataFormat == DATA_FORMAT_LIST) {
            return PACKED_REQUEST_LENGTH; // 64
        } else if (dataFormat == DATA_FORMAT_LIST_WITH_KEY_INDEX) {
            return PACKED_REQUEST_LENGTH_V2; // 72
        } else {
            revert UnsupportedRequestsDataFormat(dataFormat);
        }
    }

    /// Internal functions

    function _checkExitRequestData(bytes calldata requests, uint256 dataFormat) internal pure {
        uint256 packedLength = _getPackedRequestLength(dataFormat); // validates format

        if (requests.length == 0 || requests.length % packedLength != 0) {
            revert InvalidRequestsDataLength();
        }
    }

    function _checkExitSubmitted(RequestStatus storage requestStatus) internal view {
        if (requestStatus.contractVersion == 0) {
            revert ExitHashNotSubmitted();
        }
    }

    function _checkNotDelivered(RequestStatus storage status) internal view {
        if (status.deliveredExitDataTimestamp != 0) {
            revert RequestsAlreadyDelivered();
        }
    }

    function _checkDelivered(RequestStatus storage status) internal view {
        if (status.deliveredExitDataTimestamp == 0) {
            revert RequestsNotDelivered();
        }
    }

    function _getTimestamp() internal view virtual returns (uint32) {
        return uint32(block.timestamp); // solhint-disable-line not-rely-on-time
    }

    function _setMaxValidatorsPerReport(uint256 maxValidatorsPerReport) internal {
        if (maxValidatorsPerReport == 0) revert ZeroArgument("maxValidatorsPerReport");

        MAX_VALIDATORS_PER_REPORT_POSITION.setStorageUint256(maxValidatorsPerReport);

        emit SetMaxValidatorsPerReport(maxValidatorsPerReport);
    }

    function _getMaxValidatorsPerReport() internal view returns (uint256) {
        return MAX_VALIDATORS_PER_REPORT_POSITION.getStorageUint256();
    }

    function _setExitRequestLimit(
        uint256 maxExitBalanceEth,
        uint256 balancePerFrameEth,
        uint256 frameDurationInSec
    ) internal {
        uint256 timestamp = _getTimestamp();

        LimitData memory limitData = RateLimitStorage.getStorageLimit(EXIT_BALANCE_LIMIT_POSITION);
        limitData = RateLimit.setLimits(
            limitData,
            maxExitBalanceEth,
            balancePerFrameEth,
            frameDurationInSec,
            timestamp
        );
        RateLimitStorage.setStorageLimit(EXIT_BALANCE_LIMIT_POSITION, limitData);

        emit ExitBalanceLimitSet(maxExitBalanceEth, balancePerFrameEth, frameDurationInSec);
    }

    function _consumeLimit(uint256 balanceEth) internal {
        LimitData memory limitData = RateLimitStorage.getStorageLimit(EXIT_BALANCE_LIMIT_POSITION);
        if (!RateLimit.isLimitSet(limitData)) {
            return;
        }

        uint256 limitEth = RateLimit.calculateCurrentLimit(limitData, _getTimestamp());

        if (balanceEth > limitEth) {
            revert ExitRequestsLimitExceeded(balanceEth, limitEth);
        }

        RateLimitStorage.setStorageLimit(
            EXIT_BALANCE_LIMIT_POSITION,
            RateLimit.updatePrevLimit(limitData, limitEth - balanceEth, _getTimestamp())
        );
    }

    function _storeOracleNewHashRequestStatus(
        bytes32 exitRequestsHash,
        uint32 contractVersion,
        uint32 deliveredExitDataTimestamp
    ) internal {
        mapping(bytes32 => RequestStatus) storage requestStatusMap = _storageRequestStatus();

        if (requestStatusMap[exitRequestsHash].deliveredExitDataTimestamp != 0) {
            return;
        }

        requestStatusMap[exitRequestsHash] = RequestStatus({
            contractVersion: contractVersion,
            deliveredExitDataTimestamp: deliveredExitDataTimestamp
        });

        emit RequestsHashSubmitted(exitRequestsHash);
    }

    function _storeNewHashRequestStatus(
        bytes32 exitRequestsHash,
        uint32 contractVersion,
        uint32 deliveredExitDataTimestamp
    ) internal {
        mapping(bytes32 => RequestStatus) storage requestStatusMap = _storageRequestStatus();

        if (requestStatusMap[exitRequestsHash].contractVersion != 0) {
            revert ExitHashAlreadySubmitted();
        }

        requestStatusMap[exitRequestsHash] = RequestStatus({
            contractVersion: contractVersion,
            deliveredExitDataTimestamp: deliveredExitDataTimestamp
        });

        emit RequestsHashSubmitted(exitRequestsHash);
    }

    function _updateRequestStatus(RequestStatus storage requestStatus) internal {
        requestStatus.deliveredExitDataTimestamp = _getTimestamp();
    }

    /// Methods for reading data from tightly packed validator exit requests
    /// Format DATA_FORMAT_LIST = 1;

   /**
    * @notice Method for reading node operator id, module id, validator index, and optionally key index
    * from validator exit request data
    * @param exitRequestData Validator exit requests data
    * @param dataFormat Format of the data (1 or 2)
    * @param index index of request in array above
    * @return validatorData Validator data including node operator id, module id, validator index, and key index
    */
    function _getValidatorData(
        bytes calldata exitRequestData,
        uint256 dataFormat,
        uint256 index
    ) internal pure returns (ValidatorData memory validatorData) {
        if (dataFormat == DATA_FORMAT_LIST) {
            return _getValidatorDataV1(exitRequestData, index);
        } else if (dataFormat == DATA_FORMAT_LIST_WITH_KEY_INDEX) {
            return _getValidatorDataV2(exitRequestData, index);
        } else {
            revert UnsupportedRequestsDataFormat(dataFormat);
        }
    }

    /**
    * @notice Extracts validator data from format 1 (64 bytes per request, no keyIndex)
    * @param exitRequestData Validator exit requests data
    * @param index index of request in array
    * @return validatorData Validator data with keyIndex = type(uint256).max
    */
    function _getValidatorDataV1(
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
        validatorData.keyIndex = type(uint256).max; // Format 1 always uses keyIndex set to max uint256 to indicate unused

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
    * @notice Extracts validator data from format 2 (72 bytes per request, includes keyIndex)
    * @param exitRequestData Validator exit requests data
    * @param index index of request in array
    * @return validatorData Validator data with extracted keyIndex
    */
    function _getValidatorDataV2(
        bytes calldata exitRequestData,
        uint256 index
    ) internal pure returns (ValidatorData memory validatorData) {
        uint256 itemOffset;
        uint256 dataWithoutPubkey;

        assembly {
            // Compute the start of this packed request (item)
            itemOffset := add(exitRequestData.offset, mul(PACKED_REQUEST_LENGTH_V2, index))

            // Load the first 24 bytes which contain moduleId (24 bits),
            // nodeOpId (40 bits), valIndex (64 bits), and keyIndex (64 bits).
            dataWithoutPubkey := shr(64, calldataload(itemOffset))
        }

        // dataWithoutPubkey format (192 bits total):
        // MSB <--------------------------------- 192 bits ----------------------------------> LSB
        // | 64 bits: zeros | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: valIndex | 64 bits: keyIndex |

        validatorData.keyIndex = uint64(dataWithoutPubkey);
        validatorData.valIndex = uint64(dataWithoutPubkey >> 64);
        validatorData.nodeOpId = uint40(dataWithoutPubkey >> (64 + 64));
        validatorData.moduleId = uint24(dataWithoutPubkey >> (64 + 64 + 40));

        bytes memory pubkey = new bytes(PUBLIC_KEY_LENGTH);
        assembly {
            itemOffset := add(exitRequestData.offset, mul(PACKED_REQUEST_LENGTH_V2, index))
            let pubkeyCalldataOffset := add(itemOffset, 24)
            let pubkeyMemPtr := add(pubkey, 32)
            calldatacopy(pubkeyMemPtr, pubkeyCalldataOffset, PUBLIC_KEY_LENGTH)
        }

        validatorData.pubkey = pubkey;
    }

    /**
    * @notice Calculates the total balance in ETH for all validators in the exit requests
    * @dev This function determines the max effective balance based on the module's withdrawal credentials type:
    *      - Legacy modules (0x01 withdrawal credentials): 32 ETH per validator
    *      - Compounding modules (0x02 withdrawal credentials): 2048 ETH per validator (post-MaxEB/EIP-7251)
    *
    *      The withdrawal credentials type is queried from the Staking Router for each module,
    *      eliminating the need for hardcoded module IDs.
    *
    *      For gas efficiency, module types are cached during iteration to avoid repeated external calls
    *      for the same module.
    *
    * @param data Packed exit requests data
    * @param dataFormat Format of the data (1 or 2)
    * @return totalBalanceEth Total balance of all validators being exited in ETH
    */
    function _calculateTotalExitBalanceEth(bytes calldata data, uint256 dataFormat)
        internal
        view
        returns (uint256 totalBalanceEth)
    {
        uint256 packedLength;
        uint256 dataShift;
        uint256 moduleShift;

        if (dataFormat == DATA_FORMAT_LIST) {
            packedLength = PACKED_REQUEST_LENGTH;
            dataShift = 128;
            moduleShift = 104;
        } else if (dataFormat == DATA_FORMAT_LIST_WITH_KEY_INDEX) {
            packedLength = PACKED_REQUEST_LENGTH_V2;
            dataShift = 64;
            moduleShift = 168;
        } else {
            revert UnsupportedRequestsDataFormat(dataFormat);
        }

        uint256 baseOffset;
        assembly {
            baseOffset := data.offset
        }

        uint256 requestsCount = data.length / packedLength;
        uint256 cachedModuleId = 0;
        uint256 cachedModuleMaxEBEth = 0;
        uint256 totalBalanceEthAccum = 0;

        for (uint256 i = 0; i < requestsCount; ++i) {
            uint256 moduleId;
            uint256 itemOffset;

            assembly {
                itemOffset := add(baseOffset, mul(packedLength, i))
                let dataWithoutPubkey := shr(dataShift, calldataload(itemOffset))
                moduleId := shr(moduleShift, dataWithoutPubkey) // Extract top 24 bits
            }

            if (moduleId != cachedModuleId) {
                cachedModuleId = moduleId;
                // downscale, i.e. 2048 ether => 2048
                cachedModuleMaxEBEth = IStakingRouter(LOCATOR.stakingRouter()).getStakingModuleMaxEB(moduleId) / 1 ether;
                if (cachedModuleMaxEBEth > type(uint32).max) {
                    revert UnexpectedMaxEB();
                }
            }
            totalBalanceEthAccum += cachedModuleMaxEBEth;
        }

        totalBalanceEth = totalBalanceEthAccum;
    }

    /**
     * @notice Verify that a pubkey belongs to the specified module and node operator
     * @param moduleId Staking module ID
     * @param nodeOpId Node operator ID
     * @param keyIndex Index of the key in the module
     * @param pubkey Public key to verify (48 bytes)
     * @param requestIndex Index of the request in the batch (for error reporting)
     * @param cachedModuleId Previously cached module ID (type(uint256).max if none)
     * @param cachedModuleAddress Previously cached module address
     * @return newModuleAddress Updated module address (same if module unchanged)
     */
    function _verifyKey(
        uint256 moduleId,
        uint256 nodeOpId,
        uint256 keyIndex,
        bytes calldata pubkey,
        uint256 requestIndex,
        uint256 cachedModuleId,
        address cachedModuleAddress
    ) internal view returns (address newModuleAddress) {
        if (moduleId == cachedModuleId) {
            newModuleAddress = cachedModuleAddress;
        } else {
            newModuleAddress = IStakingRouter(LOCATOR.stakingRouter()).getStakingModuleStateConfig(moduleId).moduleAddress;
        }

        bytes memory retrievedKeys = INewStakingModule(newModuleAddress)
            .getSigningKeys(
                nodeOpId,
                keyIndex, // startIndex
                1 // keysCount: get only 1 key
            );

        if (retrievedKeys.length != 48) {
            revert InvalidRetrievedKeyLength();
        }

        if (keccak256(retrievedKeys) != keccak256(pubkey)) {
            revert InvalidPublicKey(requestIndex);
        }
    }

    /**
    * @notice Dispatcher that processes exit requests based on data format
    * @param data Packed exit requests data
    * @param dataFormat Format of the data (1 or 2)
    */
    function _processExitRequestsList(bytes calldata data, uint256 dataFormat) internal {
        if (dataFormat == DATA_FORMAT_LIST) {
            _processExitRequestsListV1(data);
        } else if (dataFormat == DATA_FORMAT_LIST_WITH_KEY_INDEX) {
            _processExitRequestsListV2(data);
        } else {
            revert UnsupportedRequestsDataFormat(dataFormat);
        }
    }

    /**
    * @notice Process exit requests for format 1 (64 bytes per request, no keyIndex)
    * @dev Check dataWithoutPubkey <= lastDataWithoutPubkey prevents duplicates and ensures sorting
    * @param data Packed exit requests data (DATA_FORMAT=1)
    */
    function _processExitRequestsListV1(bytes calldata data) internal {
        uint256 offset;
        uint256 offsetPastEnd;
        uint256 lastDataWithoutPubkey = 0;
        uint256 timestamp = _getTimestamp();

        assembly {
            offset := data.offset
            offsetPastEnd := add(offset, data.length)
        }

        bytes calldata pubkey;
        uint256 dataWithoutPubkey;
        uint256 moduleId;
        uint256 nodeOpId;
        uint64 valIndex;

        assembly {
            pubkey.length := 48
        }

        while (offset < offsetPastEnd) {
            assembly {
                // 16 most significant bytes are taken by module id, node op id, and val index
                dataWithoutPubkey := shr(128, calldataload(offset))
                // the next 48 bytes are taken by the pubkey
                pubkey.offset := add(offset, 16)
                // totalling to 64 bytes
                offset := add(offset, 64)
            }

            moduleId = uint24(dataWithoutPubkey >> (64 + 40));

            if (moduleId == 0) {
                revert InvalidModuleId();
            }

            //                              dataWithoutPubkey
            // MSB <---------------------------------------------------------------------- LSB
            // | 128 bits: zeros | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: valIndex |
            if (dataWithoutPubkey <= lastDataWithoutPubkey) {
                revert InvalidRequestsDataSortOrder();
            }

            valIndex = uint64(dataWithoutPubkey);
            nodeOpId = uint40(dataWithoutPubkey >> 64);

            lastDataWithoutPubkey = dataWithoutPubkey;
            emit ValidatorExitRequest(moduleId, nodeOpId, valIndex, pubkey, timestamp);
        }
    }

    /**
    * @notice Process exit requests for format 2 (72 bytes per request, includes keyIndex)
    * @dev Check dataWithoutPubkey <= lastDataWithoutPubkey prevents duplicates and ensures sorting
    * @param data Packed exit requests data (DATA_FORMAT=2)
    */
    function _processExitRequestsListV2(bytes calldata data) internal {
        uint256 offset;
        uint256 offsetPastEnd;
        uint256 lastDataWithoutPubkey = 0;
        uint256 timestamp = _getTimestamp();
        uint256 index = 0;

        assembly {
            offset := data.offset
            offsetPastEnd := add(offset, data.length)
        }

        bytes calldata pubkey;
        uint256 dataWithoutPubkey;
        uint256 moduleId;

        // Cache module data to avoid repeated external calls for the same module
        uint256 cachedModuleId = 0;
        address cachedModuleAddress;

        assembly {
            pubkey.length := 48
        }

        while (offset < offsetPastEnd) {
            assembly {
                // 24 most significant bytes are taken by module id, node op id, val index, and key index
                dataWithoutPubkey := shr(64, calldataload(offset))
                // the next 48 bytes are taken by the pubkey
                pubkey.offset := add(offset, 24)
                // totalling to 72 bytes
                offset := add(offset, 72)
            }

            moduleId = uint24(dataWithoutPubkey >> (64 + 64 + 40));

            if (moduleId == 0) {
                revert InvalidModuleId();
            }

            //                              dataWithoutPubkey (192 bits)
            // MSB <--------------------------------------------------------------------------------------- LSB
            // | 64 bits: zeros | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: valIndex | 64 bits: keyIndex |
            //
            // Sorting compound key: (moduleId, nodeOpId, valIndex, keyIndex)
            if (dataWithoutPubkey <= lastDataWithoutPubkey) {
                revert InvalidRequestsDataSortOrder();
            }

            // Verify that the pubkey belongs to the module and node operator
            // Cache is updated if module changed
            cachedModuleAddress = _verifyKey(
                moduleId,
                uint40(dataWithoutPubkey >> (64 + 64)),  // nodeOpId
                uint64(dataWithoutPubkey),                // keyIndex
                pubkey,
                index,
                cachedModuleId,
                cachedModuleAddress
            );

            cachedModuleId = moduleId;
            lastDataWithoutPubkey = dataWithoutPubkey;

            emit ValidatorExitRequest(
                moduleId,
                uint40(dataWithoutPubkey >> (64 + 64)),  // nodeOpId
                uint64(dataWithoutPubkey >> 64),          // valIndex
                pubkey,
                timestamp
            );

            unchecked {
                ++index;
            }
        }
    }

    /// Storage helpers

    function _storageRequestStatus() internal pure returns (mapping(bytes32 => RequestStatus) storage r) {
        bytes32 position = REQUEST_STATUS_POSITION;
        assembly {
            r.slot := position
        }
    }
}
