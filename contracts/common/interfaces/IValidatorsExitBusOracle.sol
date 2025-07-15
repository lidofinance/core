// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.5.0;

import {IValidatorsExitBus} from "./IValidatorsExitBus.sol";

interface IValidatorsExitBusOracle is IValidatorsExitBus {
    // Structs
    struct DataProcessingState {
        uint64 refSlot;
        uint64 requestsCount;
        uint64 requestsProcessed;
        uint16 dataFormat;
    }

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

    // Errors
    error AdminCannotBeZero();
    error SenderNotAllowed();
    error UnexpectedRequestsDataLength();

    // Events
    event WarnDataIncompleteProcessing(uint256 indexed refSlot, uint256 requestsProcessed, uint256 requestsCount);

    // Constants (external view functions for public constants)
    function SUBMIT_DATA_ROLE() external view returns (bytes32);

    // External functions
    function initialize(
        address admin,
        address consensusContract,
        uint256 consensusVersion,
        uint256 lastProcessingRefSlot,
        uint256 maxValidatorsPerRequest,
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec
    ) external;
    function finalizeUpgrade_v2(
        uint256 maxValidatorsPerReport,
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec
    ) external;
    function submitReportData(ReportData calldata data, uint256 contractVersion) external;
    function getProcessingState() external view returns (ProcessingState memory result);
}