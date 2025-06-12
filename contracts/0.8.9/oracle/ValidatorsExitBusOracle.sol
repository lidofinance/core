// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {SafeCast} from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";

import {UnstructuredStorage} from "../lib/UnstructuredStorage.sol";

import {BaseOracle} from "./BaseOracle.sol";
import {ValidatorsExitBus} from "./ValidatorsExitBus.sol";
import {ExitRequestLimitData, ExitLimitUtilsStorage, ExitLimitUtils} from "../lib/ExitLimitUtils.sol";

interface IOracleReportSanityChecker {
    function checkExitBusOracleReport(uint256 _exitRequestsCount) external view;
}

contract ValidatorsExitBusOracle is BaseOracle, ValidatorsExitBus {
    using UnstructuredStorage for bytes32;
    using SafeCast for uint256;
    using ExitLimitUtilsStorage for bytes32;
    using ExitLimitUtils for ExitRequestLimitData;

    error AdminCannotBeZero();
    error SenderNotAllowed();
    error UnexpectedRequestsDataLength();
    error ArgumentOutOfBounds();

    event WarnDataIncompleteProcessing(uint256 indexed refSlot, uint256 requestsProcessed, uint256 requestsCount);

    struct DataProcessingState {
        uint64 refSlot;
        uint64 requestsCount;
        uint64 requestsProcessed;
        uint16 dataFormat;
    }

    /// @notice An ACL role granting the permission to submit the data for a committee report.
    bytes32 public constant SUBMIT_DATA_ROLE = keccak256("SUBMIT_DATA_ROLE");

    /// @dev Storage slot: uint256 totalRequestsProcessed
    bytes32 internal constant TOTAL_REQUESTS_PROCESSED_POSITION =
        keccak256("lido.ValidatorsExitBusOracle.totalRequestsProcessed");

    /// @dev [DEPRECATED] Storage slot: mapping(uint256 => RequestedValidator) lastRequestedValidatorIndices
    /// This mapping was previously used for storing last requested validator indexes per (moduleId, nodeOpId) key.
    /// This code was removed from the contract, but slots can still contain logic.

    /// @dev Storage slot: DataProcessingState dataProcessingState
    bytes32 internal constant DATA_PROCESSING_STATE_POSITION =
        keccak256("lido.ValidatorsExitBusOracle.dataProcessingState");

    ///
    /// Initialization & admin functions
    ///

    constructor(
        uint256 secondsPerSlot,
        uint256 genesisTime,
        address lidoLocator
    ) BaseOracle(secondsPerSlot, genesisTime) ValidatorsExitBus(lidoLocator) {}

    function initialize(
        address admin,
        address consensusContract,
        uint256 consensusVersion,
        uint256 lastProcessingRefSlot,
        uint256 maxValidatorsPerRequest,
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec
    ) external {
        if (admin == address(0)) revert AdminCannotBeZero();
        _setupRole(DEFAULT_ADMIN_ROLE, admin);

        _pauseFor(PAUSE_INFINITELY);
        _initialize(consensusContract, consensusVersion, lastProcessingRefSlot);

        _initialize_v2(maxValidatorsPerRequest, maxExitRequestsLimit, exitsPerFrame, frameDurationInSec);
    }

    /**
     * @notice A function to finalize upgrade to v2 (from v1). Can be called only once
     *
     * For more details see https://github.com/lidofinance/lido-improvement-proposals/blob/develop/LIPS/lip-10.md
     */
    function finalizeUpgrade_v2(
        uint256 maxValidatorsPerReport,
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec
    ) external {
        _initialize_v2(maxValidatorsPerReport, maxExitRequestsLimit, exitsPerFrame, frameDurationInSec);
    }

    function _initialize_v2(
        uint256 maxValidatorsPerReport,
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec
    ) internal {
        _updateContractVersion(2);
        _setMaxValidatorsPerReport(maxValidatorsPerReport);
        _setExitRequestLimit(maxExitRequestsLimit, exitsPerFrame, frameDurationInSec);
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
    function submitReportData(ReportData calldata data, uint256 contractVersion) external whenResumed {
        _checkMsgSenderIsAllowedToSubmitData();
        _checkContractVersion(contractVersion);
        bytes32 dataHash = keccak256(abi.encode(data.data, data.dataFormat));
        // it's a waste of gas to copy the whole calldata into mem but seems there's no way around
        bytes32 reportDataHash = keccak256(abi.encode(data));
        _checkConsensusData(data.refSlot, data.consensusVersion, reportDataHash);
        _startProcessing();
        _handleConsensusReportData(data);
        _storeOracleExitRequestHash(dataHash, contractVersion);
        emit ExitDataProcessing(dataHash);
    }

    /// @notice Returns the total number of validator exit requests ever processed
    /// across all received reports.
    ///
    function getTotalRequestsProcessed() external view returns (uint256) {
        return TOTAL_REQUESTS_PROCESSED_POSITION.getStorageUint256();
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
            emit WarnDataIncompleteProcessing(prevProcessingRefSlot, state.requestsProcessed, state.requestsCount);
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

        if (data.data.length / PACKED_REQUEST_LENGTH != data.requestsCount) {
            revert UnexpectedRequestsDataLength();
        }

        IOracleReportSanityChecker(LOCATOR.oracleReportSanityChecker()).checkExitBusOracleReport(data.requestsCount);

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

    function _storeOracleExitRequestHash(bytes32 exitRequestsHash, uint256 contractVersion) internal {
        _storeOracleNewHashRequestStatus(exitRequestsHash, uint32(contractVersion), uint32(_getTime()));
    }

    ///
    /// Storage helpers
    ///

    struct StorageDataProcessingState {
        DataProcessingState value;
    }

    function _storageDataProcessingState() internal pure returns (StorageDataProcessingState storage r) {
        bytes32 position = DATA_PROCESSING_STATE_POSITION;
        assembly {
            r.slot := position
        }
    }
}
