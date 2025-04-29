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

// TODO: description
// dailyLimit 0 - exits unlimited
library ExitLimitUtils {
    /**
     * @notice Thrown when remaining exit requests limit is not enough to cover sender requests
     * @param requestsCount Amount of requests that were sent for processing
     * @param remainingLimit Amount of requests that still can be processed at current day
     */
    error ExitRequestsLimit(uint256 requestsCount, uint256 remainingLimit);

    /**
     * Method check limit and return how much can be processed
     * @param requestsCount Amount of requests for processing
     * @param currentTimestamp Block timestamp
     * @return limit Amount of requests that can be processed
     */
    function consumeLimit(
        ExitRequestLimitData memory data,
        uint256 requestsCount,
        uint256 currentTimestamp
    ) internal pure returns (uint256 limit) {
        uint64 currentDay = uint64(currentTimestamp / 1 days);

        // exits unlimited
        if (data.dailyLimit == 0) {
            return requestsCount;
        }

        if (data.currentDay != currentDay) {
            return data.dailyLimit >= requestsCount ? requestsCount : data.dailyLimit;
        }

        if (data.dailyExitCount >= data.dailyLimit) {
            revert ExitRequestsLimit(requestsCount, 0);
        }

        uint256 remainingLimit = data.dailyLimit - data.dailyExitCount;
        return remainingLimit >= requestsCount ? requestsCount : remainingLimit;
    }

    /**
     * Method check limit and revert if requests amount is more than limit
     * @param requestsCount Amount of requests for processing
     * @param currentTimestamp Block timestamp
     */
    function checkLimit(
        ExitRequestLimitData memory data,
        uint256 requestsCount,
        uint256 currentTimestamp
    ) internal pure {
        uint64 currentDay = uint64(currentTimestamp / 1 days);

        // exits unlimited
        if (data.dailyLimit == 0) return;

        if (data.currentDay != currentDay) return;

        if (data.dailyExitCount >= data.dailyLimit) {
            revert ExitRequestsLimit(requestsCount, 0);
        }

        uint256 remainingLimit = data.dailyLimit - data.dailyExitCount;

        if (requestsCount > remainingLimit) {
            revert ExitRequestsLimit(requestsCount, remainingLimit);
        }
    }

    /**
     * @notice Updates the current request counter and day in the exit limit data
     * @param data Exit request limit struct
     * @param newCount New requests amount spent during the day
     * @param currentTimestamp Block timestamp
     */
    function updateRequestsCounter(
        ExitRequestLimitData memory data,
        uint256 newCount,
        uint256 currentTimestamp
    ) internal pure returns (ExitRequestLimitData memory) {
        require(newCount <= type(uint96).max, "TOO_LARGE_REQUESTS_COUNT_LIMIT");

        // TODO: Should we count requests when exits are unlimited?
        // If a limit is set after a period of unlimited exits, should we account for the requests that already occurred?
        // if (data.dailyLimit == 0) return;

        uint64 currentDay = uint64(currentTimestamp / 1 days);

        if (data.currentDay != currentDay) {
            data.currentDay = currentDay;
            data.dailyExitCount = 0;
        }

        uint256 updatedCount = uint256(data.dailyExitCount) + newCount;
        require(updatedCount <= type(uint96).max, "DAILY_EXIT_COUNT_OVERFLOW");
        require(data.dailyLimit == 0 || updatedCount <= data.dailyLimit, "REQUESTS_COUNT_EXCEED_LIMIT");

        data.dailyExitCount = uint96(updatedCount);

        return data;
    }

    /**
     * @notice Update daily limit
     * @param data Exit request limit struct
     * @param limit Exit request limit per day
     * @param currentTimestamp Block timestamp
     */
    function setExitDailyLimit(
        ExitRequestLimitData memory data,
        uint256 limit,
        uint256 currentTimestamp
    ) internal pure returns (ExitRequestLimitData memory) {
        require(limit <= type(uint96).max, "TOO_LARGE_DAILY_LIMIT");

        uint64 day = uint64(currentTimestamp / 1 days);
        require(data.currentDay <= day, "INVALID_TIMESTAMP_BACKWARD");

        data.dailyLimit = uint96(limit);

        return data;
    }
}
