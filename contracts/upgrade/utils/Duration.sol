// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Timestamp, Timestamps} from "./Timestamp.sol";

// ---
// Type Definition
// ---

type Duration is uint32;

// ---
// Assign Global Operations
// ---

using {lt as <, lte as <=, eq as ==, neq as !=, gte as >=, gt as >} for Duration global;
using {addTo, plusSeconds, minusSeconds, multipliedBy, dividedBy, toSeconds} for Duration global;
using {plus as +, minus as -} for Duration global;

// ---
// Errors
// ---

error DivisionByZero();
error DurationOverflow();
error DurationUnderflow();

// ---
// Constants
// ---

/// @dev The maximum possible duration is approximately 136 years (assuming 365 days per year).
uint32 constant MAX_DURATION_VALUE = type(uint32).max;

// ---
// Comparison Operations
// ---

function lt(Duration d1, Duration d2) pure returns (bool) {
    return Duration.unwrap(d1) < Duration.unwrap(d2);
}

function lte(Duration d1, Duration d2) pure returns (bool) {
    return Duration.unwrap(d1) <= Duration.unwrap(d2);
}

function eq(Duration d1, Duration d2) pure returns (bool) {
    return Duration.unwrap(d1) == Duration.unwrap(d2);
}

function neq(Duration d1, Duration d2) pure returns (bool) {
    return Duration.unwrap(d1) != Duration.unwrap(d2);
}

function gte(Duration d1, Duration d2) pure returns (bool) {
    return Duration.unwrap(d1) >= Duration.unwrap(d2);
}

function gt(Duration d1, Duration d2) pure returns (bool) {
    return Duration.unwrap(d1) > Duration.unwrap(d2);
}

// ---
// Conversion Operations
// ---

function toSeconds(Duration d) pure returns (uint256) {
    return Duration.unwrap(d);
}

// ---
// Arithmetic Operations
// ---

function plus(Duration d1, Duration d2) pure returns (Duration) {
    unchecked {
        /// @dev Both `d1.toSeconds()` and `d2.toSeconds()` are <= type(uint32).max. Therefore, their
        ///      sum is <= type(uint256).max.
        return Durations.from(d1.toSeconds() + d2.toSeconds());
    }
}

function minus(Duration d1, Duration d2) pure returns (Duration) {
    uint256 d1Seconds = d1.toSeconds();
    uint256 d2Seconds = d2.toSeconds();

    if (d1Seconds < d2Seconds) {
        revert DurationUnderflow();
    }

    unchecked {
        /// @dev Subtraction is safe because `d1Seconds` >= `d2Seconds`.
        ///      Both `d1Seconds` and `d2Seconds` <= `type(uint32).max`, so the difference fits within `uint32`.
        return Duration.wrap(uint32(d1Seconds - d2Seconds));
    }
}

// ---
// Custom Operations
// ---

function plusSeconds(Duration d, uint256 secondsToAdd) pure returns (Duration) {
    return Durations.from(d.toSeconds() + secondsToAdd);
}

function minusSeconds(Duration d, uint256 secondsToSubtract) pure returns (Duration) {
    uint256 durationSeconds = d.toSeconds();

    if (durationSeconds < secondsToSubtract) {
        revert DurationUnderflow();
    }

    unchecked {
        /// @dev Subtraction is safe because `durationSeconds` >= `secondsToSubtract`.
        ///      Both `durationSeconds` and `secondsToSubtract` <= `type(uint32).max`,
        ///      so the difference fits within `uint32`.
        return Duration.wrap(uint32(durationSeconds - secondsToSubtract));
    }
}

function dividedBy(Duration d, uint256 divisor) pure returns (Duration) {
    if (divisor == 0) {
        revert DivisionByZero();
    }
    return Duration.wrap(uint32(d.toSeconds() / divisor));
}

function multipliedBy(Duration d, uint256 multiplicand) pure returns (Duration) {
    return Durations.from(multiplicand * d.toSeconds());
}

function addTo(Duration d, Timestamp t) pure returns (Timestamp) {
    unchecked {
        /// @dev Both `t.toSeconds()` <= `type(uint40).max` and `d.toSeconds()` <= `type(uint32).max`, so their
        ///      sum fits within `uint256`.
        return Timestamps.from(t.toSeconds() + d.toSeconds());
    }
}

// ---
// Namespaced Helper Methods
// ---

library Durations {
    Duration internal constant ZERO = Duration.wrap(0);

    function from(uint256 durationInSeconds) internal pure returns (Duration res) {
        if (durationInSeconds > MAX_DURATION_VALUE) {
            revert DurationOverflow();
        }
        /// @dev Casting `durationInSeconds` to `uint32` is safe as the check ensures it is less than or equal
        ///     to `MAX_DURATION_VALUE`, which fits within the `uint32`.
        res = Duration.wrap(uint32(durationInSeconds));
    }
}
