// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {IHashConsensus} from "contracts/0.4.24/oracle/LegacyOracle.sol";

contract HashConsensus__HarnessForLegacyOracle is IHashConsensus {
    uint256 internal _time = 2513040315;

    /// Chain specification
    uint256 internal SLOTS_PER_EPOCH;
    uint256 internal SECONDS_PER_SLOT;
    uint256 internal GENESIS_TIME;

    uint256 internal constant DEADLINE_SLOT_OFFSET = 0;

    struct FrameConfig {
        uint64 initialEpoch;
        uint64 epochsPerFrame;
        uint64 fastLaneLengthSlots;
    }

    struct ConsensusFrame {
        uint256 index;
        uint256 refSlot;
        uint256 reportProcessingDeadlineSlot;
    }

    FrameConfig internal _frameConfig;

    constructor(
        uint256 slotsPerEpoch,
        uint256 secondsPerSlot,
        uint256 genesisTime,
        uint256 initialEpoch,
        uint256 epochsPerFrame,
        uint256 fastLaneLengthSlots
    ) {
        require(genesisTime <= _time, "GENESIS_TIME_CANNOT_BE_MORE_THAN_MOCK_TIME");

        SLOTS_PER_EPOCH = slotsPerEpoch;
        SECONDS_PER_SLOT = secondsPerSlot;
        GENESIS_TIME = genesisTime;

        _setFrameConfig(initialEpoch, epochsPerFrame, fastLaneLengthSlots);
    }

    function _setFrameConfig(uint256 initialEpoch, uint256 epochsPerFrame, uint256 fastLaneLengthSlots) internal {
        _frameConfig = FrameConfig(uint64(initialEpoch), uint64(epochsPerFrame), uint64(fastLaneLengthSlots));
    }

    function setTime(uint256 newTime) external {
        _time = newTime;
    }

    function _getTime() internal view returns (uint256) {
        return _time;
    }

    function getTime() external view returns (uint256) {
        return _time;
    }

    function getChainConfig()
        external
        view
        returns (uint256 slotsPerEpoch, uint256 secondsPerSlot, uint256 genesisTime)
    {
        return (SLOTS_PER_EPOCH, SECONDS_PER_SLOT, GENESIS_TIME);
    }

    function getFrameConfig() external view returns (uint256 initialEpoch, uint256 epochsPerFrame) {
        FrameConfig memory config = _frameConfig;
        return (config.initialEpoch, config.epochsPerFrame);
    }

    function getCurrentFrame() external view returns (uint256 refSlot, uint256 reportProcessingDeadlineSlot) {
        ConsensusFrame memory frame = _getCurrentFrame();
        return (frame.refSlot, frame.reportProcessingDeadlineSlot);
    }

    function _getCurrentFrame() internal view returns (ConsensusFrame memory) {
        return _getFrameAtTimestamp(_getTime(), _frameConfig);
    }

    function _getFrameAtTimestamp(
        uint256 timestamp,
        FrameConfig memory config
    ) internal view returns (ConsensusFrame memory) {
        return _getFrameAtIndex(_computeFrameIndex(timestamp, config), config);
    }

    function _computeFrameIndex(uint256 timestamp, FrameConfig memory config) internal view returns (uint256) {
        uint256 epoch = _computeEpochAtTimestamp(timestamp);
        return (epoch - config.initialEpoch) / config.epochsPerFrame;
    }

    function _computeEpochAtTimestamp(uint256 timestamp) internal view returns (uint256) {
        return _computeEpochAtSlot(_computeSlotAtTimestamp(timestamp));
    }

    function _getFrameAtIndex(
        uint256 frameIndex,
        FrameConfig memory config
    ) internal view returns (ConsensusFrame memory) {
        uint256 frameStartEpoch = _computeStartEpochOfFrameWithIndex(frameIndex, config);
        uint256 frameStartSlot = _computeStartSlotAtEpoch(frameStartEpoch);
        uint256 nextFrameStartSlot = frameStartSlot + config.epochsPerFrame * SLOTS_PER_EPOCH;

        return
            ConsensusFrame({
                index: frameIndex,
                refSlot: uint64(frameStartSlot - 1),
                reportProcessingDeadlineSlot: uint64(nextFrameStartSlot - 1 - DEADLINE_SLOT_OFFSET)
            });
    }

    // Math

    function _computeSlotAtTimestamp(uint256 timestamp) internal view returns (uint256) {
        return (timestamp - GENESIS_TIME) / SECONDS_PER_SLOT;
    }

    function _computeEpochAtSlot(uint256 slot) internal view returns (uint256) {
        // See: github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#compute_epoch_at_slot
        return slot / SLOTS_PER_EPOCH;
    }

    function _computeStartSlotAtEpoch(uint256 epoch) internal view returns (uint256) {
        // See: github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#compute_start_slot_at_epoch
        return epoch * SLOTS_PER_EPOCH;
    }

    function _computeStartEpochOfFrameWithIndex(
        uint256 frameIndex,
        FrameConfig memory config
    ) internal pure returns (uint256) {
        return config.initialEpoch + frameIndex * config.epochsPerFrame;
    }

    function advanceTimeByEpochs(uint256 numEpochs) external {
        _time += SECONDS_PER_SLOT * SLOTS_PER_EPOCH * numEpochs;
    }
}
