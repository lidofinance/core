// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {UnstructuredStorage} from "./UnstructuredStorage.sol";

// MSB -----------------------------------> LSB
// 256___________160_______________ 64______________ 0
// |_______________|________________|_______________|
// |   dailyLimit  | dailyExitCount |  currentDay   |
// |<-- 96 bits -->| <-- 96 bits -->|<-- 64 bits -->|
//

struct ExitRequestLimitData {
    uint96 dailyLimit;
    uint96 dailyExitCount;
    uint64 currentDay;
}

library ExitLimitUtilsStorage {
    using UnstructuredStorage for bytes32;

    uint256 internal constant DAILY_LIMIT_OFFSET = 160;
    uint256 internal constant DAILY_EXIT_COUNT_OFFSET = 64;
    uint256 internal constant CURRENT_DAY_OFFSET = 0;

    function getStorageExitRequestLimit(bytes32 _position) internal view returns (ExitRequestLimitData memory data) {
        uint256 slotValue = _position.getStorageUint256();

        data.currentDay = uint64(slotValue >> CURRENT_DAY_OFFSET);
        data.dailyExitCount = uint96(slotValue >> DAILY_EXIT_COUNT_OFFSET);
        data.dailyLimit = uint96(slotValue >> DAILY_LIMIT_OFFSET);
    }

    function setStorageExitRequestLimit(bytes32 _position, ExitRequestLimitData memory _data) internal {
        _position.setStorageUint256(
            (uint256(_data.currentDay) << CURRENT_DAY_OFFSET) |
                (uint256(_data.dailyExitCount) << DAILY_EXIT_COUNT_OFFSET) |
                (uint256(_data.dailyLimit) << DAILY_LIMIT_OFFSET)
        );
    }
}

library ExitLimitUtils {
    /**
     * @notice Returns the current limit for the current day
     * @param data Exit request limit struct
     * @param day Full days since the Unix epoch (block.timestamp / 1 days)
     */
    function remainingLimit(ExitRequestLimitData memory data, uint256 day) internal pure returns (uint256) {
        // TODO: uint64?
        if (data.currentDay != day) {
            return data.dailyLimit;
        }

        return data.dailyExitCount >= data.dailyLimit ? 0 : data.dailyLimit - data.dailyExitCount;
    }

    /**
     * @notice Updates the current request counter and day in the exit limit data
     * @param data Exit request limit struct
     * @param currentDay Full days since the Unix epoch (block.timestamp / 1 days)
     * @param newCount New requests amount spent during the day
     */
    function updateRequestsCounter(
        ExitRequestLimitData memory data,
        uint256 currentDay,
        uint256 newCount
    ) internal pure returns (ExitRequestLimitData memory) {
        if (data.currentDay != currentDay) {
            data.currentDay = uint64(currentDay);
            data.dailyExitCount = 0;
        }

        uint256 updatedCount = uint256(data.dailyExitCount) + newCount;
        require(updatedCount <= type(uint96).max, "DAILY_EXIT_COUNT_OVERFLOW");

        if (data.dailyLimit != 0) {
            require(updatedCount <= data.dailyLimit, "DAILY_LIMIT_REACHED");
        }

        data.dailyExitCount = uint96(updatedCount);

        return data;
    }

    /**
     * @notice check if max daily exit request limit is set. Otherwise there are no limits on exits
     */
    function isExitDailyLimitSet(ExitRequestLimitData memory data) internal pure returns (bool) {
        return data.dailyLimit != 0;
    }

    /**
     * @notice Update daily limit
     * @param data Exit request limit struct
     * @param limit Exit request limit per day
     * @dev  TODO: maybe we need use here uin96
     * what will happen if method got argument with bigger value than uint96?
     */
    function setExitDailyLimit(
        ExitRequestLimitData memory data,
        uint256 limit
    ) internal view returns (ExitRequestLimitData memory) {
        require(limit != 0, "ZERO_EXIT_REQUESTS_LIMIT");
        require(limit <= type(uint96).max, "TOO_LARGE_MAX_EXIT_REQUESTS_LIMIT");

        uint64 day = uint64(block.timestamp / 1 days);
        require(data.currentDay <= day, "INVALID_TIMESTAMP_BACKWARD");

        data.dailyLimit = uint96(limit);

        return data;
    }
}
