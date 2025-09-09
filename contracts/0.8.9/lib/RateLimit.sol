// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

struct LimitData {
    uint32 maxLimit; // Maximum limit
    uint32 prevLimit; // Limit left after previous operations
    uint32 prevTimestamp; // Timestamp of the last update
    uint32 frameDurationInSec; // Seconds that should pass to restore part of the limit
    uint32 itemsPerFrame; // Restored items per frame
}

library RateLimitStorage {
    struct DataStorage {
        LimitData _limitData;
    }

    function getStorageLimit(bytes32 _position) internal view returns (LimitData memory) {
        return _getDataStorage(_position)._limitData;
    }

    function setStorageLimit(bytes32 _position, LimitData memory _data) internal {
        _getDataStorage(_position)._limitData = _data;
    }

    function _getDataStorage(bytes32 _position) private pure returns (DataStorage storage $) {
        assembly {
            $.slot := _position
        }
    }
}

// A replenishing quota per time frame
library RateLimit {
    /// @notice Error when new value for remaining limit exceeds maximum limit.
    error LimitExceeded();

    /// @notice Error when max limit exceeds uint32 max.
    error TooLargeMaxLimit();

    /// @notice Error when frame duration exceeds uint32 max.
    error TooLargeFrameDuration();

    /// @notice Error when items per frame exceed the maximum limit.
    error TooLargeItemsPerFrame();

    /// @notice Error when frame duration is zero.
    error ZeroFrameDuration();

    function calculateCurrentLimit(
        LimitData memory _data,
        uint256 timestamp
    ) internal pure returns (uint256 currentLimit) {
        uint256 secondsPassed = timestamp - _data.prevTimestamp;

        if (secondsPassed < _data.frameDurationInSec || _data.itemsPerFrame == 0) {
            return _data.prevLimit;
        }

        uint256 framesPassed = secondsPassed / _data.frameDurationInSec;
        uint256 restoredLimit = framesPassed * _data.itemsPerFrame;

        uint256 newLimit = _data.prevLimit + restoredLimit;
        if (newLimit > _data.maxLimit) {
            newLimit = _data.maxLimit;
        }

        return newLimit;
    }

    function updatePrevLimit(
        LimitData memory _data,
        uint256 newLimit,
        uint256 timestamp
    ) internal pure returns (LimitData memory) {
        if (_data.maxLimit < newLimit) revert LimitExceeded();

        uint256 secondsPassed = timestamp - _data.prevTimestamp;
        uint256 framesPassed = secondsPassed / _data.frameDurationInSec;
        uint32 passedTime = uint32(framesPassed) * _data.frameDurationInSec;

        _data.prevLimit = uint32(newLimit);
        _data.prevTimestamp += passedTime;

        return _data;
    }

    function setLimits(
        LimitData memory _data,
        uint256 maxLimit,
        uint256 itemsPerFrame,
        uint256 frameDurationInSec,
        uint256 timestamp
    ) internal pure returns (LimitData memory) {
        if (maxLimit > type(uint32).max) revert TooLargeMaxLimit();
        if (frameDurationInSec > type(uint32).max) revert TooLargeFrameDuration();
        if (itemsPerFrame > maxLimit) revert TooLargeItemsPerFrame();
        if (frameDurationInSec == 0) revert ZeroFrameDuration();

        _data.itemsPerFrame = uint32(itemsPerFrame);
        _data.frameDurationInSec = uint32(frameDurationInSec);

        if (
            // new maxLimit is smaller than prev remaining limit
            maxLimit < _data.prevLimit ||
            // previously items were unlimited
            _data.maxLimit == 0
        ) {
            _data.prevLimit = uint32(maxLimit);
        }

        _data.maxLimit = uint32(maxLimit);
        _data.prevTimestamp = uint32(timestamp);

        return _data;
    }

    function isLimitSet(LimitData memory _data) internal pure returns (bool) {
        return _data.maxLimit != 0;
    }
}
