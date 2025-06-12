// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.9;

import {ExitRequestLimitData, ExitLimitUtilsStorage, ExitLimitUtils} from "contracts/0.8.9/lib/ExitLimitUtils.sol";
import {UnstructuredStorage} from "contracts/0.8.9/lib/UnstructuredStorage.sol";

contract ExitLimitUtilsStorage__Harness {
    using ExitLimitUtilsStorage for bytes32;

    bytes32 public constant TEST_POSITION = keccak256("exit.limit.test.position");

    function getStorageExitRequestLimit() external view returns (ExitRequestLimitData memory data) {
        return TEST_POSITION.getStorageExitRequestLimit();
    }

    function setStorageExitRequestLimit(ExitRequestLimitData memory _data) external {
        TEST_POSITION.setStorageExitRequestLimit(_data);
    }
}

contract ExitLimitUtils__Harness {
    using ExitLimitUtils for ExitRequestLimitData;

    ExitRequestLimitData public state;

    function harness_setState(
        uint32 maxExitRequestsLimit,
        uint32 prevExitRequestsLimit,
        uint32 exitsPerFrame,
        uint32 frameDurationInSec,
        uint32 timestamp
    ) external {
        state.maxExitRequestsLimit = maxExitRequestsLimit;
        state.exitsPerFrame = exitsPerFrame;
        state.frameDurationInSec = frameDurationInSec;
        state.prevExitRequestsLimit = prevExitRequestsLimit;
        state.prevTimestamp = timestamp;
    }

    function harness_getState() external view returns (ExitRequestLimitData memory) {
        return
            ExitRequestLimitData(
                state.maxExitRequestsLimit,
                state.prevExitRequestsLimit,
                state.prevTimestamp,
                state.frameDurationInSec,
                state.exitsPerFrame
            );
    }

    function calculateCurrentExitLimit(uint256 currentTimestamp) external view returns (uint256) {
        return state.calculateCurrentExitLimit(currentTimestamp);
    }

    function updatePrevExitLimit(
        uint256 newExitRequestLimit,
        uint256 timestamp
    ) external view returns (ExitRequestLimitData memory) {
        return state.updatePrevExitLimit(newExitRequestLimit, timestamp);
    }

    function setExitLimits(
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec,
        uint256 timestamp
    ) external view returns (ExitRequestLimitData memory) {
        return state.setExitLimits(maxExitRequestsLimit, exitsPerFrame, frameDurationInSec, timestamp);
    }

    function isExitLimitSet() external view returns (bool) {
        return state.isExitLimitSet();
    }
}
