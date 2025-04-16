// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";

import { UnstructuredStorage } from "../lib/UnstructuredStorage.sol";
import { Versioned } from "../utils/Versioned.sol";
import { AccessControlEnumerable } from "../utils/access/AccessControlEnumerable.sol";

import { IReportAsyncProcessor } from "./HashConsensus.sol";


interface IConsensusContract {
    function getIsMember(address addr) external view returns (bool);

    function getCurrentFrame() external view returns (
        uint256 refSlot,
        uint256 reportProcessingDeadlineSlot
    );

    function getChainConfig() external view returns (
        uint256 slotsPerEpoch,
        uint256 secondsPerSlot,
        uint256 genesisTime
    );

    function getFrameConfig() external view returns (uint256 initialEpoch, uint256 epochsPerFrame);

    function getInitialRefSlot() external view returns (uint256);
}


abstract contract BaseOracle is IReportAsyncProcessor, AccessControlEnumerable, Versioned {
    using UnstructuredStorage for bytes32;
    using SafeCast for uint256;

    error AddressCannotBeZero();
    error AddressCannotBeSame();
    error VersionCannotBeSame();
    error UnexpectedChainConfig();
    error SenderIsNotTheConsensusContract();
    error InitialRefSlotCannotBeLessThanProcessingOne(uint256 initialRefSlot, uint256 processingRefSlot);
    error RefSlotMustBeGreaterThanProcessingOne(uint256 refSlot, uint256 processingRefSlot);
    error RefSlotCannotDecrease(uint256 refSlot, uint256 prevRefSlot);
    error NoConsensusReportToProcess();
    error ProcessingDeadlineMissed(uint256 deadline);
    error RefSlotAlreadyProcessing();
    error UnexpectedRefSlot(uint256 consensusRefSlot, uint256 dataRefSlot);
    error UnexpectedConsensusVersion(uint256 expectedVersion, uint256 receivedVersion);
    error HashCannotBeZero();
    error UnexpectedDataHash(bytes32 consensusHash, bytes32 receivedHash);
    error SecondsPerSlotCannotBeZero();

    event ConsensusHashContractSet(address indexed addr, address indexed prevAddr);
    event ConsensusVersionSet(uint256 indexed version, uint256 indexed prevVersion);
    event ReportSubmitted(uint256 indexed refSlot, bytes32 hash, uint256 processingDeadlineTime);
    event ReportDiscarded(uint256 indexed refSlot, bytes32 hash);
    event ProcessingStarted(uint256 indexed refSlot, bytes32 hash);
    event WarnProcessingMissed(uint256 indexed refSlot);

    struct ConsensusReport {
        bytes32 hash;
        uint64 refSlot;
        uint64 processingDeadlineTime;
    }

    /// @notice An ACL role granting the permission to set the consensus
    /// contract address by calling setConsensusContract.
    bytes32 public constant MANAGE_CONSENSUS_CONTRACT_ROLE =
        keccak256("MANAGE_CONSENSUS_CONTRACT_ROLE");

    /// @notice An ACL role granting the permission to set the consensus
    /// version by calling setConsensusVersion.
    bytes32 public constant MANAGE_CONSENSUS_VERSION_ROLE =
        keccak256("MANAGE_CONSENSUS_VERSION_ROLE");


    /// @dev Storage slot: address consensusContract
    bytes32 internal constant CONSENSUS_CONTRACT_POSITION =
        keccak256("lido.BaseOracle.consensusContract");

    /// @dev Storage slot: uint256 consensusVersion
    bytes32 internal constant CONSENSUS_VERSION_POSITION =
        keccak256("lido.BaseOracle.consensusVersion");

    /// @dev Storage slot: uint256 lastProcessingRefSlot
    bytes32 internal constant LAST_PROCESSING_REF_SLOT_POSITION =
        keccak256("lido.BaseOracle.lastProcessingRefSlot");

    /// @dev Storage slot: ConsensusReport consensusReport
    bytes32 internal constant CONSENSUS_REPORT_POSITION =
        keccak256("lido.BaseOracle.consensusReport");


    uint256 public immutable SECONDS_PER_SLOT;
    uint256 public immutable GENESIS_TIME;

    ///
    /// Initialization & admin functions
    ///

    constructor(uint256 secondsPerSlot, uint256 genesisTime) {
        if (secondsPerSlot == 0) revert SecondsPerSlotCannotBeZero();
        SECONDS_PER_SLOT = secondsPerSlot;
        GENESIS_TIME = genesisTime;
    }

    /// @notice Returns the address of the HashConsensus contract.
    ///
    function getConsensusContract() external view returns (address) {
        return CONSENSUS_CONTRACT_POSITION.getStorageAddress();
    }

    /// @notice Sets the address of the HashConsensus contract.
    ///
    function setConsensusContract(address addr) external onlyRole(MANAGE_CONSENSUS_CONTRACT_ROLE) {
        _setConsensusContract(addr, LAST_PROCESSING_REF_SLOT_POSITION.getStorageUint256());
    }

    /// @notice Returns the current consensus version expected by the oracle contract.
    ///
    /// Consensus version must change every time consensus rules change, meaning that
    /// an oracle looking at the same reference slot would calculate a different hash.
    ///
    function getConsensusVersion() external view returns (uint256) {
        return CONSENSUS_VERSION_POSITION.getStorageUint256();
    }

    /// @notice Sets the consensus version expected by the oracle contract.
    ///
    function setConsensusVersion(uint256 version) external onlyRole(MANAGE_CONSENSUS_VERSION_ROLE) {
        _setConsensusVersion(version);
    }

    ///
    /// Data provider interface
    ///

    /// @notice Returns the last consensus report hash and metadata.
    ///
    function getConsensusReport() external view returns (
        bytes32 hash,
        uint256 refSlot,
        uint256 processingDeadlineTime,
        bool processingStarted
    ) {
        ConsensusReport memory report = _storageConsensusReport().value;
        uint256 processingRefSlot = LAST_PROCESSING_REF_SLOT_POSITION.getStorageUint256();
        return (
            report.hash,
            report.refSlot,
            report.processingDeadlineTime,
            report.hash != bytes32(0) && report.refSlot == processingRefSlot
        );
    }

    ///
    /// Consensus contract interface
    ///

    /// @notice Called by HashConsensus contract to push a consensus report for processing.
    ///
    /// Note that submitting the report doesn't require the processor to start processing it right
    /// away, this can happen later (see `getLastProcessingRefSlot`). Until processing is started,
    /// HashConsensus is free to reach consensus on another report for the same reporting frame an
    /// submit it using this same function, or to lose the consensus on the submitted report,
    /// notifying the processor via `discardConsensusReport`.
    ///
    function submitConsensusReport(bytes32 reportHash, uint256 refSlot, uint256 deadline) external {
        _checkSenderIsConsensusContract();

        uint256 prevSubmittedRefSlot = _storageConsensusReport().value.refSlot;
        if (refSlot < prevSubmittedRefSlot) {
            revert RefSlotCannotDecrease(refSlot, prevSubmittedRefSlot);
        }

        uint256 prevProcessingRefSlot = LAST_PROCESSING_REF_SLOT_POSITION.getStorageUint256();
        if (refSlot <= prevProcessingRefSlot) {
            revert RefSlotMustBeGreaterThanProcessingOne(refSlot, prevProcessingRefSlot);
        }

        if (_getTime() > deadline) {
            revert ProcessingDeadlineMissed(deadline);
        }

        if (refSlot != prevSubmittedRefSlot && prevProcessingRefSlot != prevSubmittedRefSlot) {
            emit WarnProcessingMissed(prevSubmittedRefSlot);
        }

        if (reportHash == bytes32(0)) {
            revert HashCannotBeZero();
        }

        emit ReportSubmitted(refSlot, reportHash, deadline);

        ConsensusReport memory report = ConsensusReport({
            hash: reportHash,
            refSlot: refSlot.toUint64(),
            processingDeadlineTime: deadline.toUint64()
        });

        _storageConsensusReport().value = report;
        _handleConsensusReport(report, prevSubmittedRefSlot, prevProcessingRefSlot);
    }

    /// @notice Called by HashConsensus contract to notify that the report for the given ref. slot
    /// is not a conensus report anymore and should be discarded. This can happen when a member
    /// changes their report, is removed from the set, or when the quorum value gets increased.
    ///
    /// Only called when, for the given reference slot:
    ///
    ///   1. there previously was a consensus report; AND
    ///   1. processing of the consensus report hasn't started yet; AND
    ///   2. report processing deadline is not expired yet; AND
    ///   3. there's no consensus report now (otherwise, `submitConsensusReport` is called instead).
    ///
    /// Can be called even when there's no submitted non-discarded consensus report for the current
    /// reference slot, i.e. can be called multiple times in succession.
    ///
    function discardConsensusReport(uint256 refSlot) external {
        _checkSenderIsConsensusContract();

        ConsensusReport memory submittedReport = _storageConsensusReport().value;
        if (refSlot < submittedReport.refSlot) {
            revert RefSlotCannotDecrease(refSlot, submittedReport.refSlot);
        } else if (refSlot > submittedReport.refSlot) {
            return;
        }

        uint256 lastProcessingRefSlot = LAST_PROCESSING_REF_SLOT_POSITION.getStorageUint256();
        if (refSlot <= lastProcessingRefSlot) {
            revert RefSlotAlreadyProcessing();
        }

        _storageConsensusReport().value.hash = bytes32(0);
        _handleConsensusReportDiscarded(submittedReport);

        emit ReportDiscarded(submittedReport.refSlot, submittedReport.hash);
    }

    /// @notice Returns the last reference slot for which processing of the report was started.
    ///
    function getLastProcessingRefSlot() external view returns (uint256) {
        return LAST_PROCESSING_REF_SLOT_POSITION.getStorageUint256();
    }

    ///
    /// Descendant contract interface
    ///

    /// @notice Initializes the contract storage. Must be called by a descendant
    /// contract as part of its initialization.
    ///
    function _initialize(
        address consensusContract,
        uint256 consensusVersion,
        uint256 lastProcessingRefSlot
    ) internal virtual {
        _initializeContractVersionTo(1);
        _setConsensusContract(consensusContract, lastProcessingRefSlot);
        _setConsensusVersion(consensusVersion);
        LAST_PROCESSING_REF_SLOT_POSITION.setStorageUint256(lastProcessingRefSlot);
        _storageConsensusReport().value.refSlot = lastProcessingRefSlot.toUint64();
    }

    /// @notice Returns whether the given address is a member of the oracle committee.
    ///
    function _isConsensusMember(address addr) internal view returns (bool) {
        address consensus = CONSENSUS_CONTRACT_POSITION.getStorageAddress();
        return IConsensusContract(consensus).getIsMember(addr);
    }

    /// @notice Called when the oracle gets a new consensus report from the HashConsensus contract.
    ///
    /// Keep in mind that, until you call `_startProcessing`, the oracle committee is free to
    /// reach consensus on another report for the same reporting frame and re-submit it using
    /// this function, or lose consensus on the report and ask to discard it by calling the
    /// `_handleConsensusReportDiscarded` function.
    ///
    function _handleConsensusReport(
        ConsensusReport memory report,
        uint256 prevSubmittedRefSlot,
        uint256 prevProcessingRefSlot
    ) internal virtual;

    /// @notice Called when the HashConsensus contract loses consensus on a previously submitted
    /// report that is not processing yet and asks to discard this report. Only called if there is
    /// no new consensus report at the moment; otherwise, `_handleConsensusReport` is called instead.
    ///
    function _handleConsensusReportDiscarded(ConsensusReport memory report) internal virtual {}

    /// @notice May be called by a descendant contract to check if the received data matches
    /// the currently submitted consensus report. Reverts otherwise.
    ///
    function _checkConsensusData(uint256 refSlot, uint256 consensusVersion, bytes32 hash)
        internal view
    {
        ConsensusReport memory report = _storageConsensusReport().value;
        if (refSlot != report.refSlot) {
            revert UnexpectedRefSlot(report.refSlot, refSlot);
        }

        uint256 expectedConsensusVersion = CONSENSUS_VERSION_POSITION.getStorageUint256();
        if (consensusVersion != expectedConsensusVersion) {
            revert UnexpectedConsensusVersion(expectedConsensusVersion, consensusVersion);
        }

        if (hash != report.hash) {
            revert UnexpectedDataHash(report.hash, hash);
        }
    }

    /// @notice Called by a descendant contract to mark the current consensus report
    /// as being processed. Returns the last ref. slot which processing was started
    /// before the call.
    ///
    /// Before this function is called, the oracle committee is free to reach consensus
    /// on another report for the same reporting frame. After this function is called,
    /// the consensus report for the current frame is guaranteed to remain the same.
    ///
    function _startProcessing() internal returns (uint256) {
        ConsensusReport memory report = _storageConsensusReport().value;
        if (report.hash == bytes32(0)) {
            revert NoConsensusReportToProcess();
        }

        _checkProcessingDeadline(report.processingDeadlineTime);

        uint256 prevProcessingRefSlot = LAST_PROCESSING_REF_SLOT_POSITION.getStorageUint256();
        if (prevProcessingRefSlot == report.refSlot) {
            revert RefSlotAlreadyProcessing();
        }

        LAST_PROCESSING_REF_SLOT_POSITION.setStorageUint256(report.refSlot);

        emit ProcessingStarted(report.refSlot, report.hash);
        return prevProcessingRefSlot;
    }

    /// @notice Reverts if the processing deadline for the current consensus report is missed.
    ///
    function _checkProcessingDeadline() internal view {
        _checkProcessingDeadline(_storageConsensusReport().value.processingDeadlineTime);
    }

    function _checkProcessingDeadline(uint256 deadlineTime) internal view {
        if (_getTime() > deadlineTime) revert ProcessingDeadlineMissed(deadlineTime);
    }

    /// @notice Returns the reference slot for the current frame.
    ///
    function _getCurrentRefSlot() internal view returns (uint256) {
        address consensusContract = CONSENSUS_CONTRACT_POSITION.getStorageAddress();
        (uint256 refSlot, ) = IConsensusContract(consensusContract).getCurrentFrame();
        return refSlot;
    }

    ///
    /// Implementation & helpers
    ///

    function _setConsensusVersion(uint256 version) internal {
        uint256 prevVersion = CONSENSUS_VERSION_POSITION.getStorageUint256();
        if (version == prevVersion) revert VersionCannotBeSame();
        CONSENSUS_VERSION_POSITION.setStorageUint256(version);
        emit ConsensusVersionSet(version, prevVersion);
    }

    function _setConsensusContract(address addr, uint256 lastProcessingRefSlot) internal {
        if (addr == address(0)) revert AddressCannotBeZero();

        address prevAddr = CONSENSUS_CONTRACT_POSITION.getStorageAddress();
        if (addr == prevAddr) revert AddressCannotBeSame();

        (, uint256 secondsPerSlot, uint256 genesisTime) = IConsensusContract(addr).getChainConfig();
        if (secondsPerSlot != SECONDS_PER_SLOT || genesisTime != GENESIS_TIME) {
            revert UnexpectedChainConfig();
        }

        uint256 initialRefSlot = IConsensusContract(addr).getInitialRefSlot();
        if (initialRefSlot < lastProcessingRefSlot) {
            revert InitialRefSlotCannotBeLessThanProcessingOne(initialRefSlot, lastProcessingRefSlot);
        }

        CONSENSUS_CONTRACT_POSITION.setStorageAddress(addr);
        emit ConsensusHashContractSet(addr, prevAddr);
    }

    function _checkSenderIsConsensusContract() internal view {
        if (_msgSender() != CONSENSUS_CONTRACT_POSITION.getStorageAddress()) {
            revert SenderIsNotTheConsensusContract();
        }
    }

    function _getTime() internal virtual view returns (uint256) {
        return block.timestamp; // solhint-disable-line not-rely-on-time
    }

    ///
    /// Storage helpers
    ///

    struct StorageConsensusReport {
        ConsensusReport value;
    }

    function _storageConsensusReport() internal pure returns (StorageConsensusReport storage r) {
        bytes32 position = CONSENSUS_REPORT_POSITION;
        assembly { r.slot := position }
    }
}
