// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.5.0;

import {IReportAsyncProcessor} from "./IReportAsyncProcessor.sol";

interface IBaseOracle is IReportAsyncProcessor {
    // Constants
    function MANAGE_CONSENSUS_CONTRACT_ROLE() external view returns (bytes32);
    function MANAGE_CONSENSUS_VERSION_ROLE() external view returns (bytes32);
    function SECONDS_PER_SLOT() external view returns (uint256);
    function GENESIS_TIME() external view returns (uint256);

    // Admin functions
    function getConsensusContract() external view returns (address);
    function setConsensusContract(address addr) external;
    function getConsensusVersion() external view returns (uint256);
    function setConsensusVersion(uint256 version) external;

    // Data provider interface
    function getConsensusReport() external view returns (
        bytes32 hash,
        uint256 refSlot,
        uint256 processingDeadlineTime,
        bool processingStarted
    );

    // Errors
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

    // Events
    event ConsensusHashContractSet(address indexed addr, address indexed prevAddr);
    event ConsensusVersionSet(uint256 indexed version, uint256 indexed prevVersion);
    event ReportSubmitted(uint256 indexed refSlot, bytes32 hash, uint256 processingDeadlineTime);
    event ReportDiscarded(uint256 indexed refSlot, bytes32 hash);
    event ProcessingStarted(uint256 indexed refSlot, bytes32 hash);
    event WarnProcessingMissed(uint256 indexed refSlot);

    // Structs
    struct ConsensusReport {
        bytes32 hash;
        uint64 refSlot;
        uint64 processingDeadlineTime;
    }
}