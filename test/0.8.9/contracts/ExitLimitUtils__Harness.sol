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

    event CheckLimitDone();

    ExitRequestLimitData public state;

    function harness_setState(uint96 dailyLimit, uint96 dailyExitCount, uint64 currentDay) external {
        state.dailyLimit = dailyLimit;
        state.dailyExitCount = dailyExitCount;
        state.currentDay = currentDay;
    }

    function harness_getState() external view returns (ExitRequestLimitData memory) {
        return ExitRequestLimitData(state.dailyLimit, state.dailyExitCount, state.currentDay);
    }

    function consumeLimit(uint256 requestsCount, uint256 currentTimestamp) external view returns (uint256 limit) {
        return state.consumeLimit(requestsCount, currentTimestamp);
    }

    function checkLimit(uint256 requestsCount, uint256 currentTimestamp) external {
        state.checkLimit(requestsCount, currentTimestamp);

        emit CheckLimitDone();
    }

    function updateRequestsCounter(
        uint256 newCount,
        uint256 currentTimestamp
    ) external view returns (ExitRequestLimitData memory) {
        return state.updateRequestsCounter(newCount, currentTimestamp);
    }

    function setExitDailyLimit(
        uint256 limit,
        uint256 currentTimestamp
    ) external view returns (ExitRequestLimitData memory) {
        return state.setExitDailyLimit(limit, currentTimestamp);
    }
}
