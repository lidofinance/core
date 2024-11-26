// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {SafeCast} from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";

import {IConsensusContract} from "contracts/0.8.9/oracle/BaseOracle.sol";
import {IReportAsyncProcessor} from "contracts/0.8.9/oracle/HashConsensus.sol";

contract ConsensusContract__Mock is IConsensusContract {
    using SafeCast for uint256;

    uint64 internal immutable SLOTS_PER_EPOCH;
    uint64 internal immutable SECONDS_PER_SLOT;
    uint64 internal immutable GENESIS_TIME;

    address internal _reportProcessor;

    mapping(address => uint256) internal _memberIndices1b;

    struct ConsensusFrame {
        uint256 index;
        uint256 refSlot;
        uint256 reportProcessingDeadlineSlot;
    }

    struct FrameConfig {
        uint64 initialEpoch;
        uint64 epochsPerFrame;
        uint64 fastLaneLengthSlots;
    }

    FrameConfig internal _frameConfig;
    ConsensusFrame internal _consensusFrame;
    uint256 internal _initialRefSlot;

    constructor(
        uint256 slotsPerEpoch,
        uint256 secondsPerSlot,
        uint256 genesisTime,
        uint256 epochsPerFrame,
        uint256 initialEpoch,
        uint256 fastLaneLengthSlots,
        address mockMember
    ) {
        SLOTS_PER_EPOCH = slotsPerEpoch.toUint64();
        SECONDS_PER_SLOT = secondsPerSlot.toUint64();
        GENESIS_TIME = genesisTime.toUint64();

        _setFrameConfig(initialEpoch, epochsPerFrame, fastLaneLengthSlots);
        _memberIndices1b[mockMember] = 1;

        _consensusFrame.index = 10;
        _consensusFrame.refSlot = 1;
        _consensusFrame.reportProcessingDeadlineSlot = 7001;

        _initialRefSlot = initialEpoch * slotsPerEpoch - 1;
    }

    function getIsMember(address addr) external view returns (bool) {
        return _memberIndices1b[addr] != 0;
    }

    function getCurrentFrame() external view returns (uint256 refSlot, uint256 reportProcessingDeadlineSlot) {
        return (_consensusFrame.refSlot, _consensusFrame.reportProcessingDeadlineSlot);
    }

    function setCurrentFrame(uint256 index, uint256 refSlot, uint256 reportProcessingDeadlineSlot) external {
        _consensusFrame.index = index;
        _consensusFrame.refSlot = refSlot;
        _consensusFrame.reportProcessingDeadlineSlot = reportProcessingDeadlineSlot;
    }

    function setInitialRefSlot(uint256 initialRefSlot) external {
        _initialRefSlot = initialRefSlot;
    }

    function getChainConfig()
        external
        view
        returns (uint256 slotsPerEpoch, uint256 secondsPerSlot, uint256 genesisTime)
    {
        return (SLOTS_PER_EPOCH, SECONDS_PER_SLOT, GENESIS_TIME);
    }

    function getFrameConfig() external view returns (uint256 initialEpoch, uint256 epochsPerFrame) {
        return (_frameConfig.initialEpoch, _frameConfig.epochsPerFrame);
    }

    function getInitialRefSlot() external view returns (uint256) {
        return _initialRefSlot;
    }

    function _setFrameConfig(uint256 initialEpoch, uint256 epochsPerFrame, uint256 fastLaneLengthSlots) internal {
        _frameConfig = FrameConfig(initialEpoch.toUint64(), epochsPerFrame.toUint64(), fastLaneLengthSlots.toUint64());
    }

    //
    // IReportAsyncProcessor relevant mocks&handels
    //

    function setAsyncProcessor(address reportProcessor) external {
        _reportProcessor = reportProcessor;
    }

    function submitReportAsConsensus(bytes32 reportHash, uint256 refSlot, uint256 deadline) external {
        IReportAsyncProcessor(_reportProcessor).submitConsensusReport(reportHash, refSlot, deadline);
    }

    function discardReportAsConsensus(uint256 refSlot) external {
        IReportAsyncProcessor(_reportProcessor).discardConsensusReport(refSlot);
    }
}
