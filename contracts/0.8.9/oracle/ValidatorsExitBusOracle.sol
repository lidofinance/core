// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";

import { ILidoLocator } from "../../common/interfaces/ILidoLocator.sol";
import { Math256 } from "../../common/lib/Math256.sol";
import { PausableUntil } from "../utils/PausableUntil.sol";
import { UnstructuredStorage } from "../lib/UnstructuredStorage.sol";

import { BaseOracle } from "./BaseOracle.sol";
import { ValidatorsExitBus } from "./ValidatorsExitBus.sol";


interface IOracleReportSanityChecker {
    function checkExitBusOracleReport(uint256 _exitRequestsCount) external view;
}


contract ValidatorsExitBusOracle is BaseOracle, PausableUntil, ValidatorsExitBus {
    using UnstructuredStorage for bytes32;
    using SafeCast for uint256;

    error AdminCannotBeZero();
    error SenderNotAllowed();
    error UnsupportedRequestsDataFormat(uint256 format);
    error InvalidRequestsData();
    error InvalidRequestsDataLength();
    error UnexpectedRequestsDataLength();
    error InvalidRequestsDataSortOrder();
    error ArgumentOutOfBounds();
    error NodeOpValidatorIndexMustIncrease(
        uint256 moduleId,
        uint256 nodeOpId,
        uint256 prevRequestedValidatorIndex,
        uint256 requestedValidatorIndex
    );

    event ValidatorExitRequest(
        uint256 indexed stakingModuleId,
        uint256 indexed nodeOperatorId,
        uint256 indexed validatorIndex,
        bytes validatorPubkey,
        uint256 timestamp
    );

    event WarnDataIncompleteProcessing(
        uint256 indexed refSlot,
        uint256 requestsProcessed,
        uint256 requestsCount
    );

    event StoreOracleExitRequestHashStart(
        bytes32 exitRequestHash
    );

    struct DataProcessingState {
        uint64 refSlot;
        uint64 requestsCount;
        uint64 requestsProcessed;
        uint16 dataFormat;
    }

    struct RequestedValidator {
        bool requested;
        uint64 index;
    }

    /// @notice An ACL role granting the permission to submit the data for a committee report.
    bytes32 public constant SUBMIT_DATA_ROLE = keccak256("SUBMIT_DATA_ROLE");

    /// @notice An ACL role granting the permission to pause accepting validator exit requests
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");

    /// @notice An ACL role granting the permission to resume accepting validator exit requests
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");

    /// @dev Storage slot: uint256 totalRequestsProcessed
    bytes32 internal constant TOTAL_REQUESTS_PROCESSED_POSITION =
        keccak256("lido.ValidatorsExitBusOracle.totalRequestsProcessed");

    /// @dev Storage slot: mapping(uint256 => RequestedValidator) lastRequestedValidatorIndices
    /// A mapping from the (moduleId, nodeOpId) packed key to the last requested validator index.
    bytes32 internal constant LAST_REQUESTED_VALIDATOR_INDICES_POSITION =
        keccak256("lido.ValidatorsExitBusOracle.lastRequestedValidatorIndices");

    /// @dev Storage slot: DataProcessingState dataProcessingState
    bytes32 internal constant DATA_PROCESSING_STATE_POSITION =
        keccak256("lido.ValidatorsExitBusOracle.dataProcessingState");

    ILidoLocator internal immutable LOCATOR;

    ///
    /// Initialization & admin functions
    ///

    constructor(uint256 secondsPerSlot, uint256 genesisTime, address lidoLocator)
        BaseOracle(secondsPerSlot, genesisTime)
    {
        LOCATOR = ILidoLocator(lidoLocator);
    }

    function initialize(
        address admin,
        address consensusContract,
        uint256 consensusVersion,
        uint256 lastProcessingRefSlot
    ) external {
        if (admin == address(0)) revert AdminCannotBeZero();
        _setupRole(DEFAULT_ADMIN_ROLE, admin);

        _pauseFor(PAUSE_INFINITELY);
        _initialize(consensusContract, consensusVersion, lastProcessingRefSlot);
    }

    function finalizeUpgrade_v2() external {
        _updateContractVersion(2);
        _setLocatorAddress(address(LOCATOR));
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

    ///
    /// Data provider interface
    ///

    struct ReportData {
        ///
        /// Oracle consensus info
        ///

        /// @dev Version of the oracle consensus rules. Current version expected
        /// by the oracle can be obtained by calling getConsensusVersion().
        uint256 consensusVersion;

        /// @dev Reference slot for which the report was calculated. If the slot
        /// contains a block, the state being reported should include all state
        /// changes resulting from that block. The epoch containing the slot
        /// should be finalized prior to calculating the report.
        uint256 refSlot;

        ///
        /// Requests data
        ///

        /// @dev Total number of validator exit requests in this report. Must not be greater
        /// than limit checked in OracleReportSanityChecker.checkExitBusOracleReport.
        uint256 requestsCount;

        /// @dev Format of the validator exit requests data. Currently, only the
        /// DATA_FORMAT_LIST=1 is supported.
        uint256 dataFormat;

        /// @dev Validator exit requests data. Can differ based on the data format,
        /// see the constant defining a specific data format below for more info.
        bytes data;
    }

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

    /// @notice Submits report data for processing.
    ///
    /// @param data The data. See the `ReportData` structure's docs for details.
    /// @param contractVersion Expected version of the oracle contract.
    ///
    /// Reverts if:
    /// - The caller is not a member of the oracle committee and doesn't possess the
    ///   SUBMIT_DATA_ROLE.
    /// - The provided contract version is different from the current one.
    /// - The provided consensus version is different from the expected one.
    /// - The provided reference slot differs from the current consensus frame's one.
    /// - The processing deadline for the current consensus frame is missed.
    /// - The keccak256 hash of the ABI-encoded data is different from the last hash
    ///   provided by the hash consensus contract.
    /// - The provided data doesn't meet safety checks.
    ///
    function submitReportData(ReportData calldata data, uint256 contractVersion)
        external whenResumed
    {
        _checkMsgSenderIsAllowedToSubmitData();
        _checkContractVersion(contractVersion);
        bytes32 dataHash = keccak256(abi.encode(data.data, data.dataFormat));
        // it's a waste of gas to copy the whole calldata into mem but seems there's no way around
        bytes32 reportDataHash = keccak256(abi.encode(data));
        _checkConsensusData(data.refSlot, data.consensusVersion, reportDataHash);
        _startProcessing();
        _handleConsensusReportData(data);
        _storeOracleExitRequestHash(dataHash, data.requestsCount, contractVersion);
    }

    /// @notice Returns the total number of validator exit requests ever processed
    /// across all received reports.
    ///
    function getTotalRequestsProcessed() external view returns (uint256) {
        return TOTAL_REQUESTS_PROCESSED_POSITION.getStorageUint256();
    }

    /// @notice Returns the latest validator indices that were requested to exit for the given
    /// `nodeOpIds` in the given `moduleId`. For node operators that were never requested to exit
    /// any validator, index is set to -1.
    ///
    /// @param moduleId ID of the staking module.
    /// @param nodeOpIds IDs of the staking module's node operators.
    ///
    function getLastRequestedValidatorIndices(uint256 moduleId, uint256[] calldata nodeOpIds)
        external view returns (int256[] memory)
    {
        if (moduleId > type(uint24).max) revert ArgumentOutOfBounds();

        int256[] memory indices = new int256[](nodeOpIds.length);

        for (uint256 i = 0; i < nodeOpIds.length; ++i) {
            uint256 nodeOpId = nodeOpIds[i];
            if (nodeOpId > type(uint40).max) revert ArgumentOutOfBounds();
            uint256 nodeOpKey = _computeNodeOpKey(moduleId, nodeOpId);
            RequestedValidator memory validator = _storageLastRequestedValidatorIndices()[nodeOpKey];
            indices[i] = validator.requested ? int256(uint256(validator.index)) : -1;
        }

        return indices;
    }

    struct ProcessingState {
        /// @notice Reference slot for the current reporting frame.
        uint256 currentFrameRefSlot;
        /// @notice The last time at which a report data can be submitted for the current
        /// reporting frame.
        uint256 processingDeadlineTime;
        /// @notice Hash of the report data. Zero bytes if consensus on the hash hasn't
        /// been reached yet for the current reporting frame.
        bytes32 dataHash;
        /// @notice Whether any report data for the for the current reporting frame has been
        /// already submitted.
        bool dataSubmitted;
        /// @notice Format of the report data for the current reporting frame.
        uint256 dataFormat;
        /// @notice Total number of validator exit requests for the current reporting frame.
        uint256 requestsCount;
        /// @notice How many validator exit requests are already submitted for the current
        /// reporting frame.
        uint256 requestsSubmitted;
    }

    /// @notice Returns data processing state for the current reporting frame.
    /// @return result See the docs for the `ProcessingState` struct.
    ///
    function getProcessingState() external view returns (ProcessingState memory result) {
        ConsensusReport memory report = _storageConsensusReport().value;
        result.currentFrameRefSlot = _getCurrentRefSlot();

        if (report.hash == bytes32(0) || result.currentFrameRefSlot != report.refSlot) {
            return result;
        }

        result.processingDeadlineTime = report.processingDeadlineTime;
        result.dataHash = report.hash;

        DataProcessingState memory procState = _storageDataProcessingState().value;

        result.dataSubmitted = procState.refSlot == result.currentFrameRefSlot;
        if (!result.dataSubmitted) {
            return result;
        }

        result.dataFormat = procState.dataFormat;
        result.requestsCount = procState.requestsCount;
        result.requestsSubmitted = procState.requestsProcessed;
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

        uint256 itemOffset;
        uint256 dataWithoutPubkey;

        assembly {
            // Compute the start of this packed request (item)
            itemOffset := add(exitRequests.offset, mul(PACKED_REQUEST_LENGTH, index))

            // Load the first 16 bytes which contain moduleId (24 bits),
            // nodeOpId (40 bits), and valIndex (64 bits).
            dataWithoutPubkey := shr(128, calldataload(itemOffset))
        }

        // dataWithoutPubkey format (128 bits total):
        // MSB <-------------------- 128 bits --------------------> LSB
        // |   128 bits: zeros  | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: valIndex |

        valIndex = uint64(dataWithoutPubkey);
        nodeOpId = uint40(dataWithoutPubkey >> 64);
        moduleId = uint24(dataWithoutPubkey >> (64 + 40));

        // Allocate a new bytes array in memory for the pubkey
        pubkey = new bytes(PUBLIC_KEY_LENGTH);

        assembly {
            // Starting offset in calldata for the pubkey part
            let pubkeyCalldataOffset := add(itemOffset, 16)

            // Memory location of the 'pubkey' bytes array data
            let pubkeyMemPtr := add(pubkey, 32)

            // Copy the 48 bytes of the pubkey from calldata into memory
            calldatacopy(pubkeyMemPtr, pubkeyCalldataOffset, PUBLIC_KEY_LENGTH)
        }

        return (pubkey, nodeOpId, moduleId, valIndex);
    }

    function getExitRequestsDeliveryHistory(
        bytes32 exitRequestsHash
    ) external view returns (uint256 totalItemsCount, uint256 deliveredItemsCount, DeliveryHistory[] memory history) {
        RequestStatus storage requestStatus = _storageExitRequestsHashes()[exitRequestsHash];

        if (requestStatus.contractVersion == 0) {
            revert ExitHashWasNotSubmitted();
        }

        return (requestStatus.totalItemsCount, requestStatus.deliveredItemsCount, requestStatus.deliverHistory);
    }

    ///
    /// Implementation & helpers
    ///

    function _handleConsensusReport(
        ConsensusReport memory /* report */,
        uint256 /* prevSubmittedRefSlot */,
        uint256 prevProcessingRefSlot
    ) internal override {
        DataProcessingState memory state = _storageDataProcessingState().value;
        if (state.refSlot == prevProcessingRefSlot && state.requestsProcessed < state.requestsCount) {
            emit WarnDataIncompleteProcessing(
                prevProcessingRefSlot,
                state.requestsProcessed,
                state.requestsCount
            );
        }
    }

    function _checkMsgSenderIsAllowedToSubmitData() internal view {
        address sender = _msgSender();
        if (!hasRole(SUBMIT_DATA_ROLE, sender) && !_isConsensusMember(sender)) {
            revert SenderNotAllowed();
        }
    }

    function _handleConsensusReportData(ReportData calldata data) internal {
        if (data.dataFormat != DATA_FORMAT_LIST) {
            revert UnsupportedRequestsDataFormat(data.dataFormat);
        }

        if (data.data.length % PACKED_REQUEST_LENGTH != 0) {
            revert InvalidRequestsDataLength();
        }

        // TODO: next iteration will check ref slot deliveredReportAmount
        IOracleReportSanityChecker(LOCATOR.oracleReportSanityChecker())
            .checkExitBusOracleReport(data.requestsCount);

        if (data.data.length / PACKED_REQUEST_LENGTH != data.requestsCount) {
            revert UnexpectedRequestsDataLength();
        }

        _processExitRequestsList(data.data);

        _storageDataProcessingState().value = DataProcessingState({
            refSlot: data.refSlot.toUint64(),
            requestsCount: data.requestsCount.toUint64(),
            requestsProcessed: data.requestsCount.toUint64(),
            dataFormat: uint16(DATA_FORMAT_LIST)
        });

        if (data.requestsCount == 0) {
            return;
        }

        TOTAL_REQUESTS_PROCESSED_POSITION.setStorageUint256(
            TOTAL_REQUESTS_PROCESSED_POSITION.getStorageUint256() + data.requestsCount
        );
    }

    function _processExitRequestsList(bytes calldata data) internal {
        uint256 offset;
        uint256 offsetPastEnd;
        assembly {
            offset := data.offset
            offsetPastEnd := add(offset, data.length)
        }

        uint256 lastDataWithoutPubkey = 0;
        uint256 lastNodeOpKey = 0;
        RequestedValidator memory lastRequestedVal;
        bytes calldata pubkey;

        assembly {
            pubkey.length := 48
        }

        uint256 timestamp = _getTime();

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
            //
            if (dataWithoutPubkey <= lastDataWithoutPubkey) {
                revert InvalidRequestsDataSortOrder();
            }

            uint64 valIndex = uint64(dataWithoutPubkey);
            uint256 nodeOpId = uint40(dataWithoutPubkey >> 64);
            uint256 moduleId = uint24(dataWithoutPubkey >> (64 + 40));

            if (moduleId == 0) {
                revert InvalidRequestsData();
            }

            uint256 nodeOpKey = _computeNodeOpKey(moduleId, nodeOpId);
            if (nodeOpKey != lastNodeOpKey) {
                if (lastNodeOpKey != 0) {
                    _storageLastRequestedValidatorIndices()[lastNodeOpKey] = lastRequestedVal;
                }
                lastRequestedVal = _storageLastRequestedValidatorIndices()[nodeOpKey];
                lastNodeOpKey = nodeOpKey;
            }

            if (lastRequestedVal.requested && valIndex <= lastRequestedVal.index) {
                revert NodeOpValidatorIndexMustIncrease(
                    moduleId,
                    nodeOpId,
                    lastRequestedVal.index,
                    valIndex
                );
            }

            lastRequestedVal = RequestedValidator(true, valIndex);
            lastDataWithoutPubkey = dataWithoutPubkey;

            emit ValidatorExitRequest(moduleId, nodeOpId, valIndex, pubkey, timestamp);
        }

        if (lastNodeOpKey != 0) {
            _storageLastRequestedValidatorIndices()[lastNodeOpKey] = lastRequestedVal;
        }
    }

    function _computeNodeOpKey(uint256 moduleId, uint256 nodeOpId) internal pure returns (uint256) {
        return (moduleId << 40) | nodeOpId;
    }

    function _storeOracleExitRequestHash(bytes32 exitRequestHash, uint256 requestsCount, uint256 contractVersion) internal {
        if (requestsCount == 0) {
            return;
        }
        _storeExitRequestHash(exitRequestHash, requestsCount, requestsCount, contractVersion, requestsCount - 1);
    }

    ///
    /// Storage helpers
    ///

    function _storageLastRequestedValidatorIndices() internal pure returns (
        mapping(uint256 => RequestedValidator) storage r
    ) {
        bytes32 position = LAST_REQUESTED_VALIDATOR_INDICES_POSITION;
        assembly { r.slot := position }
    }

    struct StorageDataProcessingState {
        DataProcessingState value;
    }

    function _storageDataProcessingState() internal pure returns (
        StorageDataProcessingState storage r
    ) {
        bytes32 position = DATA_PROCESSING_STATE_POSITION;
        assembly { r.slot := position }
    }
}
