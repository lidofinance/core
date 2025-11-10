// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Durations, Duration} from "./Duration.sol";
import {Timestamps, Timestamp} from "./Timestamp.sol";

/// @title Time Constraints Contract
/// @notice Provides mechanisms to validate time-based constraints against the current
///     network time (`block.timestamp`). Can be used within a transaction to ensure
///     that time conditions are met.
/// @dev Supports the following types of time validations:
///     - Time windows within a day, including both standard (e.g., 09:00 – 17:00) and
///           overnight ranges (e.g., 20:00 – 06:00).
///     - A deadline: checks that the current time is before a specified timestamp.
///     - A start time: checks that the current time is after a specified timestamp.
contract TimeConstraints {
    // ---
    // Events
    // ---

    event TimeWithinDayTimeChecked(Duration startDayTime, Duration endDayTime);
    event TimeBeforeTimestampChecked(Timestamp timestamp);
    event TimeAfterTimestampChecked(Timestamp timestamp);

    // ---
    // Errors
    // ---

    error DayTimeOverflow();
    error DayTimeOutOfRange(Duration currentDayTime, Duration startDayTime, Duration endDayTime);
    error TimestampNotPassed(Timestamp timestamp);
    error TimestampPassed(Timestamp timestamp);

    // ---
    // Constants
    // ---

    /// @notice Total number of seconds in a day (24 hours).
    Duration public immutable DAY_DURATION = Durations.from(24 hours);

    // ---
    // Time Constraints Checks
    // ---

    /// @notice Checks that the current day time satisfies specific time range during the day.
    /// @dev Supports two types of time ranges:
    ///      1. Regular range: startDayTime <= endDayTime (e.g. [12:00, 18:00])
    ///      2. Overnight range: startDayTime > endDayTime (e.g. [18:00, 12:00], where the end time is on the next day)
    /// @param startDayTime The start time of the allowed range (inclusive) in seconds since midnight (UTC).
    /// @param endDayTime The end time of the allowed range (inclusive) in seconds since midnight (UTC).
    function checkTimeWithinDayTime(Duration startDayTime, Duration endDayTime) public view {
        _validateDayTime(startDayTime);
        _validateDayTime(endDayTime);

        Duration currentDayTime = getCurrentDayTime();
        bool isCurrentDayTimeOutOfRange = startDayTime <= endDayTime
            // Handle regular range within the same day:
            //   00:00:00          06:00:00      12:00:00           23:59:59
            //      │○○○○○○○○○○○○○○○○○│●●●●●●●●●●●●●●│○○○○○○○○○○○○○○○○○│
            //                  startDayTime     endDayTime
            ? currentDayTime < startDayTime || currentDayTime > endDayTime
            // Handle overnight range:
            //   00:00:00          06:00:00      12:00:00           23:59:59
            //      │●●●●●●●●●●●●●●●●●│○○○○○○○○○○○○○○│●●●●●●●●●●●●●●●●●│
            //                    endDayTime   startDayTime
            : currentDayTime < startDayTime && currentDayTime > endDayTime;

        if (isCurrentDayTimeOutOfRange) {
            revert DayTimeOutOfRange(currentDayTime, startDayTime, endDayTime);
        }
    }

    /// @notice Checks that the current network day time satisfies specific time range during the day and emits an event.
    /// @dev Supports two types of time ranges:
    ///      1. Regular range: startDayTime <= endDayTime (e.g. [12:00, 18:00])
    ///      2. Overnight range: startDayTime > endDayTime (e.g. [18:00, 12:00], where the end time is on the next day)
    /// @param startDayTime The start time of the allowed range (inclusive) in seconds since midnight (UTC).
    /// @param endDayTime The end time of the allowed range (inclusive) in seconds since midnight (UTC).
    function checkTimeWithinDayTimeAndEmit(Duration startDayTime, Duration endDayTime) external {
        checkTimeWithinDayTime(startDayTime, endDayTime);
        emit TimeWithinDayTimeChecked(startDayTime, endDayTime);
    }

    /// @notice Checks that the current network timestamp is after the given specific timestamp.
    /// @param timestamp The Unix timestamp after which the check is successful.
    function checkTimeAfterTimestamp(Timestamp timestamp) public view {
        if (Timestamps.now() <= timestamp) {
            revert TimestampNotPassed(timestamp);
        }
    }

    /// @notice Checks that the current network timestamp is after the given specific timestamp and emits an event.
    /// @param timestamp The Unix timestamp after which the check is successful.
    function checkTimeAfterTimestampAndEmit(Timestamp timestamp) external {
        checkTimeAfterTimestamp(timestamp);
        emit TimeAfterTimestampChecked(timestamp);
    }

    /// @notice Checks that the current network timestamp is before the given specific timestamp.
    /// @param timestamp The Unix timestamp before which the check is successful.
    function checkTimeBeforeTimestamp(Timestamp timestamp) public view {
        if (Timestamps.now() >= timestamp) {
            revert TimestampPassed(timestamp);
        }
    }

    /// @notice Checks that the current network timestamp is before the given specific timestamp and emits an event.
    /// @param timestamp The Unix timestamp before which the check is successful.
    function checkTimeBeforeTimestampAndEmit(Timestamp timestamp) external {
        checkTimeBeforeTimestamp(timestamp);
        emit TimeBeforeTimestampChecked(timestamp);
    }

    // ---
    // Getters
    // ---

    /// @notice Gets the current time in seconds since midnight (UTC).
    /// @return Current time of day in seconds since midnight (UTC).
    function getCurrentDayTime() public view returns (Duration) {
        return Durations.from(block.timestamp % DAY_DURATION.toSeconds());
    }

    // ---
    // Internal Methods
    // ---

    /// @notice Validates that a provided day time value is within the [0:00:00, 23:59:59] range.
    /// @param dayTime The day time value in seconds to validate.
    /// @dev Reverts with `DayTimeOverflow` if the value exceeds the number of seconds in a day.
    function _validateDayTime(Duration dayTime) internal view {
        if (dayTime >= DAY_DURATION) {
            revert DayTimeOverflow();
        }
    }
}
