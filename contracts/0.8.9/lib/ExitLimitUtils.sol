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

/// @notice Gwei-based limit data structure for exit requests
/// @dev Uses uint64 fields to support large Gwei values (max 18.4 million ETH per field)
struct ExitBalanceLimitData {
    uint64 maxExitBalanceGwei; // Maximum balance limit in Gwei
    uint64 prevExitBalanceGwei; // Balance limit left after previous requests in Gwei
    uint32 prevTimestamp; // Timestamp of the last update
    uint32 frameDurationInSec; // Seconds that should pass to restore part of balance
    uint64 balancePerFrame; // Restored balance in Gwei per frame
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

        uint256 passedTime = timestamp - _data.prevTimestamp;
        passedTime -= passedTime % _data.frameDurationInSec;

        _data.prevExitRequestsLimit = uint32(newExitRequestLimit);
        _data.prevTimestamp += uint32(passedTime);

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

        if (_data.maxExitRequestsLimit == 0) {
            // no limit was set before, set the new limit
            _data.prevExitRequestsLimit = uint32(maxExitRequestsLimit);
        } else {
            uint256 currentLimit = calculateCurrentExitLimit(_data, timestamp);
            // update current limit proportionally as `newLimit - exitsUsed`
            // where `exitsUsed` is relative to the previous limit
            uint32 exitsUsed = _data.maxExitRequestsLimit - uint32(currentLimit);
            if (exitsUsed >= maxExitRequestsLimit) {
                _data.prevExitRequestsLimit = 0;
            } else {
                _data.prevExitRequestsLimit = uint32(maxExitRequestsLimit - exitsUsed);
            }
        }

        _data.exitsPerFrame = uint32(exitsPerFrame);
        _data.frameDurationInSec = uint32(frameDurationInSec);
        _data.maxExitRequestsLimit = uint32(maxExitRequestsLimit);
        _data.prevTimestamp = uint32(timestamp);

        return _data;
    }

    function isExitLimitSet(ExitRequestLimitData memory _data) internal pure returns (bool) {
        return _data.maxExitRequestsLimit != 0;
    }
}

/// @notice Storage utilities for ExitBalanceLimitData (Gwei-based limits)
library ExitBalanceLimitStorage {
    struct DataStorage {
        ExitBalanceLimitData _exitBalanceLimitData;
    }

    function getStorageExitBalanceLimit(bytes32 _position) internal view returns (ExitBalanceLimitData memory) {
        return _getDataStorage(_position)._exitBalanceLimitData;
    }

    function setStorageExitBalanceLimit(bytes32 _position, ExitBalanceLimitData memory _data) internal {
        _getDataStorage(_position)._exitBalanceLimitData = _data;
    }

    function _getDataStorage(bytes32 _position) private pure returns (DataStorage storage $) {
        assembly {
            $.slot := _position
        }
    }
}

/// @notice Utility functions for Gwei-based exit balance limits
library ExitBalanceLimitUtils {
    /// @notice Error when new value for remaining balance limit exceeds maximum limit.
    error BalanceLimitExceeded();

    /// @notice Error when max exit balance limit exceeds uint64 max.
    error TooLargeMaxExitBalanceLimit();

    /// @notice Error when frame duration exceeds uint32 max.
    error TooLargeFrameDuration();

    /// @notice Error when balance per frame exceeds the maximum exit balance limit.
    error TooLargeBalancePerFrame();

    /// @notice Error when frame duration is zero.
    error ZeroFrameDuration();

    function calculateCurrentExitBalanceLimit(
        ExitBalanceLimitData memory _data,
        uint256 timestamp
    ) internal pure returns (uint256 currentLimit) {
        uint256 secondsPassed = timestamp - _data.prevTimestamp;

        if (secondsPassed < _data.frameDurationInSec || _data.balancePerFrame == 0) {
            return _data.prevExitBalanceGwei;
        }

        uint256 framesPassed = secondsPassed / _data.frameDurationInSec;
        uint256 restoredLimit = framesPassed * _data.balancePerFrame;

        uint256 newLimit = _data.prevExitBalanceGwei + restoredLimit;
        if (newLimit > _data.maxExitBalanceGwei) {
            newLimit = _data.maxExitBalanceGwei;
        }

        return newLimit;
    }

    function updatePrevExitBalanceLimit(
        ExitBalanceLimitData memory _data,
        uint256 newExitBalanceLimit,
        uint256 timestamp
    ) internal pure returns (ExitBalanceLimitData memory) {
        if (_data.maxExitBalanceGwei < newExitBalanceLimit) revert BalanceLimitExceeded();

        uint256 passedTime = timestamp - _data.prevTimestamp;
        passedTime -= passedTime % _data.frameDurationInSec;

        _data.prevExitBalanceGwei = uint64(newExitBalanceLimit);
        _data.prevTimestamp += uint32(passedTime);

        return _data;
    }

    function setExitBalanceLimits(
        ExitBalanceLimitData memory _data,
        uint256 maxExitBalanceGwei,
        uint256 balancePerFrame,
        uint256 frameDurationInSec,
        uint256 timestamp
    ) internal pure returns (ExitBalanceLimitData memory) {
        if (maxExitBalanceGwei > type(uint64).max) revert TooLargeMaxExitBalanceLimit();
        if (frameDurationInSec > type(uint32).max) revert TooLargeFrameDuration();
        if (balancePerFrame > maxExitBalanceGwei) revert TooLargeBalancePerFrame();
        if (frameDurationInSec == 0) revert ZeroFrameDuration();

        if (_data.maxExitBalanceGwei == 0) {
            // no limit was set before, set the new limit
            _data.prevExitBalanceGwei = uint64(maxExitBalanceGwei);
        } else {
            uint256 currentLimit = calculateCurrentExitBalanceLimit(_data, timestamp);
            // update current limit proportionally as `newLimit - balanceUsed`
            // where `balanceUsed` is relative to the previous limit
            uint64 balanceUsed = _data.maxExitBalanceGwei - uint64(currentLimit);
            if (balanceUsed >= maxExitBalanceGwei) {
                _data.prevExitBalanceGwei = 0;
            } else {
                _data.prevExitBalanceGwei = uint64(maxExitBalanceGwei - balanceUsed);
            }
        }

        _data.balancePerFrame = uint64(balancePerFrame);
        _data.frameDurationInSec = uint32(frameDurationInSec);
        _data.maxExitBalanceGwei = uint64(maxExitBalanceGwei);
        _data.prevTimestamp = uint32(timestamp);

        return _data;
    }

    function isExitBalanceLimitSet(ExitBalanceLimitData memory _data) internal pure returns (bool) {
        return _data.maxExitBalanceGwei != 0;
    }
}
