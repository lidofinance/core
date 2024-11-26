// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {HashConsensus} from "contracts/0.8.9/oracle/HashConsensus.sol";

contract HashConsensus__Harness is HashConsensus {
    uint256 internal _time = 2513040315;

    constructor(
        uint256 slotsPerEpoch,
        uint256 secondsPerSlot,
        uint256 genesisTime,
        uint256 epochsPerFrame,
        uint256 fastLaneLengthSlots,
        address admin,
        address reportProcessor
    )
        HashConsensus(
            slotsPerEpoch,
            secondsPerSlot,
            genesisTime,
            epochsPerFrame,
            fastLaneLengthSlots,
            admin,
            reportProcessor
        )
    {
        require(genesisTime <= _time, "GENESIS_TIME_CANNOT_BE_MORE_THAN_MOCK_TIME");
    }

    function _getTime() internal view override returns (uint256) {
        return _time;
    }

    function getTime() external view returns (uint256) {
        return _time;
    }

    function getTimeInSlots() external view returns (uint256) {
        return _computeSlotAtTimestamp(_time);
    }

    function setTime(uint256 newTime) external {
        _time = newTime;
    }

    function setTimeInSlots(uint256 slot) external {
        _time = _computeTimestampAtSlot(slot);
    }

    function setTimeInEpochs(uint256 epoch) external {
        _time = _computeTimestampAtSlot(_computeStartSlotAtEpoch(epoch));
    }

    function advanceTimeBy(uint256 timeAdvance) external {
        _time += timeAdvance;
    }

    function advanceTimeToNextFrameStart() external {
        FrameConfig memory config = _frameConfig;
        uint256 epoch = _computeFrameStartEpoch(_time, config) + config.epochsPerFrame;
        _time = _computeTimestampAtSlot(_computeStartSlotAtEpoch(epoch));
    }

    function advanceTimeBySlots(uint256 numSlots) external {
        _time += SECONDS_PER_SLOT * numSlots;
    }

    function advanceTimeByEpochs(uint256 numEpochs) external {
        _time += SECONDS_PER_SLOT * SLOTS_PER_EPOCH * numEpochs;
    }

    function getConsensusVersion() external view returns (uint256) {
        return _getConsensusVersion();
    }
}
