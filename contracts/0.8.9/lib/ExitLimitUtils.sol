// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

struct ExitRequestLimitData {
    uint32 maxExitRequestsLimit; // Maximum limit
    uint32 prevExitRequestsLimit; // Limit left after previous requests
    uint32 prevTimestamp; // Timestamp of the last update
    uint32 frameDurationInSec; // Seconds that should pass to restore part of exits
    uint32 exitsPerFrame; // Restored exits per frame
}

library ExitLimitUtilsStorage {
    struct DataStorage {
        ExitRequestLimitData _exitRequestLimitData;
    }

    function getStorageExitRequestLimit(bytes32 _position) internal view returns (ExitRequestLimitData memory) {
        return _getDataStorage(_position)._exitRequestLimitData;
    }

    function setStorageExitRequestLimit(bytes32 _position, ExitRequestLimitData memory _data) internal {
        _getDataStorage(_position)._exitRequestLimitData = _data;
    }

    function _getDataStorage(bytes32 _position) private pure returns (DataStorage storage $) {
        assembly {
            $.slot := _position
        }
    }
}

library ExitLimitUtils {
    /// @notice Error when new value for remaining limit exceeds maximum limit.
    error LimitExceeded();

    /// @notice Error when max exit request limit exceeds uint32 max.
    error TooLargeMaxExitRequestsLimit();

    /// @notice Error when frame duration exceeds uint32 max.
    error TooLargeFrameDuration();

    /// @notice Error when exits per frame exceed the maximum exit request limit.
    error TooLargeExitsPerFrame();

    /// @notice Error when frame duration is zero.
    error ZeroFrameDuration();

    function calculateCurrentExitLimit(
        ExitRequestLimitData memory _data,
        uint256 timestamp
    ) internal pure returns (uint256 currentLimit) {
        uint256 secondsPassed = timestamp - _data.prevTimestamp;

        if (secondsPassed < _data.frameDurationInSec || _data.exitsPerFrame == 0) {
            return _data.prevExitRequestsLimit;
        }

        uint256 framesPassed = secondsPassed / _data.frameDurationInSec;
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
        if (_data.maxExitRequestsLimit < newExitRequestLimit) revert LimitExceeded();

        uint256 secondsPassed = timestamp - _data.prevTimestamp;
        uint256 framesPassed = secondsPassed / _data.frameDurationInSec;
        uint32 passedTime = uint32(framesPassed) * _data.frameDurationInSec;

        _data.prevExitRequestsLimit = uint32(newExitRequestLimit);
        _data.prevTimestamp += passedTime;

        return _data;
    }

    function setExitLimits(
        ExitRequestLimitData memory _data,
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec,
        uint256 timestamp
    ) internal pure returns (ExitRequestLimitData memory) {
        if (maxExitRequestsLimit > type(uint32).max) revert TooLargeMaxExitRequestsLimit();
        if (frameDurationInSec > type(uint32).max) revert TooLargeFrameDuration();
        if (exitsPerFrame > maxExitRequestsLimit) revert TooLargeExitsPerFrame();
        if (frameDurationInSec == 0) revert ZeroFrameDuration();

        _data.exitsPerFrame = uint32(exitsPerFrame);
        _data.frameDurationInSec = uint32(frameDurationInSec);

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
