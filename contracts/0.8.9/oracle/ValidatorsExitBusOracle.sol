// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {SafeCast} from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";

import {UnstructuredStorage} from "../lib/UnstructuredStorage.sol";

import {BaseOracle} from "./BaseOracle.sol";
import {ValidatorsExitBus} from "./ValidatorsExitBus.sol";
import {WithdrawalIntent} from "../../common/interfaces/WithdrawalIntent.sol";

interface IOracleReportSanityChecker {
    function checkExitBusOracleReport(uint256 _maxBalanceExitRequestedPerReportInEth) external view;
}

contract ValidatorsExitBusOracle is BaseOracle, ValidatorsExitBus {
    using UnstructuredStorage for bytes32;
    using SafeCast for uint256;

    error AdminCannotBeZero();
    error SenderNotAllowed();
    error UnexpectedRequestsDataLength();

    event WarnDataIncompleteProcessing(uint256 indexed refSlot, uint256 requestsProcessed, uint256 requestsCount);

    struct DataProcessingState {
        uint64 refSlot;
        uint64 requestsCount;
        uint64 requestsProcessed;
        //uint16 _deprecatedDataFormat
    }

    /// @notice An ACL role granting the permission to submit the data for a committee report.
    bytes32 public constant SUBMIT_DATA_ROLE = keccak256("SUBMIT_DATA_ROLE");

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
        address lidoLocator,
        uint256 maxRequestsPerReport
    )
        BaseOracle(secondsPerSlot, genesisTime)
        ValidatorsExitBus(lidoLocator, maxRequestsPerReport)
    {}

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
        _updateContractVersion(2);
        _updateContractVersion(3);
        _updateContractVersion(4);
    }

    /**
     * @notice A function to finalize upgrade to v4. Can be called only once
     * @dev Switches the report to the withdrawal requests format, so the consensus version is updated as well.
     *
     * For more details see https://github.com/lidofinance/lido-improvement-proposals/blob/develop/LIPS/lip-38.md
     * @param consensusVersion New consensus version
     */
    function finalizeUpgrade_v4(uint256 consensusVersion) external {
        _updateContractVersion(4);
        _setConsensusVersion(consensusVersion);
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

        /// @dev Total number of withdrawal requests in this report. Must not be greater
        /// than MAX_REQUESTS_PER_REPORT.
        uint256 requestsCount;
        /// @dev Packed withdrawal requests, see the data format in ValidatorsExitBus.
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
    /// - The report contains more than MAX_REQUESTS_PER_REPORT records.
    /// - A partial withdrawal targets a module without `partialWithdrawalsAllowed`.
    /// - A partial withdrawal amount exceeds MAX_PWR_AMOUNT_GWEI.
    /// - The report's total exit balance exceeds the OracleReportSanityChecker limit.
    ///
    function submitReportData(ReportData calldata data, uint256 contractVersion) external whenResumed {
        _checkMsgSenderIsAllowedToSubmitData();
        _checkContractVersion(contractVersion);
        // need to discuss delete of ExitDataProcessing event
        // bytes32 dataHash = keccak256(abi.encode(data.data, data.dataFormat));
        // it's a waste of gas to copy the whole calldata into mem but seems there's no way around
        bytes32 reportDataHash = keccak256(abi.encode(data));
        _checkConsensusData(data.refSlot, data.consensusVersion, reportDataHash);
        _startProcessing();
        _handleConsensusReportData(data);
        // possibly delete
        // emit ExitDataProcessing(dataHash);
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
        if (data.data.length % PACKED_REQUEST_LENGTH != 0) {
            revert InvalidRequestsDataLength();
        }

        if (data.data.length / PACKED_REQUEST_LENGTH != data.requestsCount) {
            revert UnexpectedRequestsDataLength();
        }

        if (data.requestsCount > MAX_REQUESTS_PER_REPORT) {
            revert TooManyRequestsInReport(data.requestsCount, MAX_REQUESTS_PER_REPORT);
        }

        (WithdrawalIntent[] memory intents, uint256 totalExitBalanceEth) = _processWithdrawalRequests(data.data);

        IOracleReportSanityChecker(LOCATOR.oracleReportSanityChecker()).checkExitBusOracleReport(
            totalExitBalanceEth
        );

        _storageDataProcessingState().value = DataProcessingState({
            refSlot: data.refSlot.toUint64(),
            requestsCount: data.requestsCount.toUint64(),
            requestsProcessed: data.requestsCount.toUint64()
        });

        if (data.requestsCount == 0) {
            return;
        }

        _addWithdrawalIntents(intents);

        TOTAL_REQUESTS_PROCESSED_POSITION.setStorageUint256(
            TOTAL_REQUESTS_PROCESSED_POSITION.getStorageUint256() + data.requestsCount
        );
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
