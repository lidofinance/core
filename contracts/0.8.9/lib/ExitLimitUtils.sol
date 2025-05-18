// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {UnstructuredStorage} from "./UnstructuredStorage.sol";

// MSB ---------------------------------------------------------------------------------------> LSB
// 160___________________128_____________________96______________64_____________32_______________ 0
// |______________________|_______________________|_______________|_______________|_______________|
// | maxExitRequestsLimit | prevExitRequestsLimit | prevTimestamp | frameDuration | exitsPerFrame |
// |<------ 32 bits ----->|<------ 32 bits ------>|<-- 32 bits -->|<-- 32 bits -->|<-- 32 bits -->|
//

struct ExitRequestLimitData {
    uint32 maxExitRequestsLimit; // Maximum limit
    uint32 prevExitRequestsLimit; // Limit left after previous requests
    uint32 prevTimestamp; // Timestamp of the last update
    uint32 frameDuration; // Seconds that should pass to restore part of exits
    uint32 exitsPerFrame; // Restored exits per frame
}

library ExitLimitUtilsStorage {
    using UnstructuredStorage for bytes32;

    uint256 internal constant EXITS_PER_FRAME_OFFSET = 0;
    uint256 internal constant FRAME_DURATION_OFFSET = 32;
    uint256 internal constant PREV_TIMESTAMP_OFFSET = 64;
    uint256 internal constant PREV_EXIT_REQUESTS_LIMIT_OFFSET = 96;
    uint256 internal constant MAX_EXIT_REQUESTS_LIMIT_OFFSET = 128;

    function getStorageExitRequestLimit(bytes32 _position) internal view returns (ExitRequestLimitData memory data) {
        uint256 slot = _position.getStorageUint256();

        data.exitsPerFrame = uint32(slot >> EXITS_PER_FRAME_OFFSET);
        data.frameDuration = uint32(slot >> FRAME_DURATION_OFFSET);
        data.prevTimestamp = uint32(slot >> PREV_TIMESTAMP_OFFSET);
        data.prevExitRequestsLimit = uint32(slot >> PREV_EXIT_REQUESTS_LIMIT_OFFSET);
        data.maxExitRequestsLimit = uint32(slot >> MAX_EXIT_REQUESTS_LIMIT_OFFSET);
    }

    function setStorageExitRequestLimit(bytes32 _position, ExitRequestLimitData memory _data) internal {
        uint256 value = (uint256(_data.exitsPerFrame) << EXITS_PER_FRAME_OFFSET) |
            (uint256(_data.frameDuration) << FRAME_DURATION_OFFSET) |
            (uint256(_data.prevTimestamp) << PREV_TIMESTAMP_OFFSET) |
            (uint256(_data.prevExitRequestsLimit) << PREV_EXIT_REQUESTS_LIMIT_OFFSET) |
            (uint256(_data.maxExitRequestsLimit) << MAX_EXIT_REQUESTS_LIMIT_OFFSET);

        _position.setStorageUint256(value);
    }
}

library ExitLimitUtils {
    // What should happen with limits if pause is enabled
    function calculateCurrentExitLimit(
        ExitRequestLimitData memory _data,
        uint256 timestamp
    ) internal pure returns (uint256 currentLimit) {
        uint256 secondsPassed = timestamp - _data.prevTimestamp;

        if (secondsPassed < _data.frameDuration || _data.exitsPerFrame == 0) {
            return _data.prevExitRequestsLimit;
        }

        uint256 framesPassed = secondsPassed / _data.frameDuration;
        uint256 restoredLimit = framesPassed * _data.exitsPerFrame;

        uint256 newLimit = _data.prevExitRequestsLimit + restoredLimit;
        if (newLimit > _data.maxExitRequestsLimit) {
            newLimit = _data.maxExitRequestsLimit;
        }

        return newLimit;
    }

    function updatePrevExitLimit(
        ExitRequestLimitData memory _data,
        uint256 newExitRequestLimit,
        uint256 timestamp
    ) internal pure returns (ExitRequestLimitData memory) {
        require(_data.maxExitRequestsLimit >= newExitRequestLimit, "LIMIT_EXCEEDED");

        uint256 secondsPassed = timestamp - _data.prevTimestamp;
        uint256 framesPassed = secondsPassed / _data.frameDuration;
        uint32 passedTime = uint32(framesPassed) * _data.frameDuration;

        _data.prevExitRequestsLimit = uint32(newExitRequestLimit);
        _data.prevTimestamp += passedTime;

        return _data;
    }

    function setExitLimits(
        ExitRequestLimitData memory _data,
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDuration,
        uint256 timestamp
    ) internal pure returns (ExitRequestLimitData memory) {
        // TODO: restrictions on parameters?
        // require(maxExitRequests != 0, "ZERO_MAX_LIMIT");
        // require(frameDuration != 0, "ZERO_FRAME_DURATION");
        require(maxExitRequestsLimit <= type(uint32).max, "TOO_LARGE_MAX_EXIT_REQUESTS_LIMIT");
        require(exitsPerFrame <= type(uint32).max, "TOO_LARGE_EXITS_PER_FRAME");
        require(frameDuration <= type(uint32).max, "TOO_LARGE_FRAME_DURATION");

        _data.exitsPerFrame = uint32(exitsPerFrame);
        _data.frameDuration = uint32(frameDuration);

        if (
            // new maxExitRequestsLimit is smaller than prev remaining limit
            maxExitRequestsLimit < _data.prevExitRequestsLimit ||
            // previously exits were unlimited
            _data.maxExitRequestsLimit == 0
        ) {
            _data.prevExitRequestsLimit = uint32(maxExitRequestsLimit);
        }

        _data.maxExitRequestsLimit = uint32(maxExitRequestsLimit);
        _data.prevTimestamp = uint32(timestamp);

        return _data;
    }

    function isExitLimitSet(ExitRequestLimitData memory _data) internal pure returns (bool) {
        return _data.maxExitRequestsLimit != 0;
    }
}
