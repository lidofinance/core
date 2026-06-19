// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.25;

import {LimitData, RateLimitStorage, RateLimit} from "contracts/common/lib/RateLimit.sol";

contract RateLimitStorage__Harness {
    using RateLimitStorage for bytes32;

    bytes32 public constant TEST_POSITION = keccak256("rate.limit.test.position");

    function getStorageLimit() external view returns (LimitData memory data) {
        return TEST_POSITION.getStorageLimit();
    }

    function setStorageLimit(LimitData memory _data) external {
        TEST_POSITION.setStorageLimit(_data);
    }
}

contract RateLimit__Harness {
    using RateLimit for LimitData;

    LimitData public state;

    function harness_setState(
        uint32 maxLimit,
        uint32 prevLimit,
        uint32 itemsPerFrame,
        uint32 frameDurationInSec,
        uint32 timestamp
    ) external {
        state.maxLimit = maxLimit;
        state.itemsPerFrame = itemsPerFrame;
        state.frameDurationInSec = frameDurationInSec;
        state.prevLimit = prevLimit;
        state.prevTimestamp = timestamp;
    }

    function harness_getState() external view returns (LimitData memory) {
        return
            LimitData(
                state.maxLimit,
                state.prevLimit,
                state.prevTimestamp,
                state.frameDurationInSec,
                state.itemsPerFrame
            );
    }

    function calculateCurrentLimit(uint256 currentTimestamp) external view returns (uint256) {
        return state.calculateCurrentLimit(currentTimestamp);
    }

    function updatePrevLimit(uint256 newLimit, uint256 timestamp) external view returns (LimitData memory) {
        return state.updatePrevLimit(newLimit, timestamp);
    }

    function setLimits(
        uint256 maxLimit,
        uint256 itemsPerFrame,
        uint256 frameDurationInSec,
        uint256 timestamp
    ) external view returns (LimitData memory) {
        return state.setLimits(maxLimit, itemsPerFrame, frameDurationInSec, timestamp);
    }

    function isLimitSet() external view returns (bool) {
        return state.isLimitSet();
    }
}
