// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

// ---
// Type Definition
// ---

type Timestamp is uint40;

// ---
// Assign Global Operations
// ---

using {lt as <, lte as <=, eq as ==, neq as !=, gte as >=, gt as >} for Timestamp global;
using {isZero, isNotZero, toSeconds} for Timestamp global;

// ---
// Errors
// ---

error TimestampOverflow();

// ---
// Constants
// ---

/// @dev The maximum value for a `Timestamp`, corresponding to approximately the year 36812.
uint40 constant MAX_TIMESTAMP_VALUE = type(uint40).max;

// ---
// Comparison Operations
// ---

function lt(Timestamp t1, Timestamp t2) pure returns (bool) {
    return Timestamp.unwrap(t1) < Timestamp.unwrap(t2);
}

function lte(Timestamp t1, Timestamp t2) pure returns (bool) {
    return Timestamp.unwrap(t1) <= Timestamp.unwrap(t2);
}

function eq(Timestamp t1, Timestamp t2) pure returns (bool) {
    return Timestamp.unwrap(t1) == Timestamp.unwrap(t2);
}

function neq(Timestamp t1, Timestamp t2) pure returns (bool) {
    return Timestamp.unwrap(t1) != Timestamp.unwrap(t2);
}

function gte(Timestamp t1, Timestamp t2) pure returns (bool) {
    return Timestamp.unwrap(t1) >= Timestamp.unwrap(t2);
}

function gt(Timestamp t1, Timestamp t2) pure returns (bool) {
    return Timestamp.unwrap(t1) > Timestamp.unwrap(t2);
}

// ---
// Conversion Operations
// ---

function toSeconds(Timestamp t) pure returns (uint256) {
    return Timestamp.unwrap(t);
}

// ---
// Custom Operations
// ---

function isZero(Timestamp t) pure returns (bool) {
    return Timestamp.unwrap(t) == 0;
}

function isNotZero(Timestamp t) pure returns (bool) {
    return Timestamp.unwrap(t) > 0;
}

// ---
// Namespaced Helper Methods
// ---

library Timestamps {
    Timestamp internal constant ZERO = Timestamp.wrap(0);

    function from(uint256 timestampInSeconds) internal pure returns (Timestamp res) {
        if (timestampInSeconds > MAX_TIMESTAMP_VALUE) {
            revert TimestampOverflow();
        }

        /// @dev Casting `timestampInSeconds` to `uint40` is safe as the check ensures it is less than or equal
        ///     to `MAX_TIMESTAMP_VALUE`, which fits within the `uint40`.
        return Timestamp.wrap(uint40(timestampInSeconds));
    }

    function now() internal view returns (Timestamp res) {
        /// @dev Skipping the check that `block.timestamp` <= `MAX_TIMESTAMP_VALUE` for gas efficiency.
        ///      Overflow is possible only after approximately 34,000 years from the Unix epoch.
        res = Timestamp.wrap(uint40(block.timestamp));
    }

    function max(Timestamp t1, Timestamp t2) internal pure returns (Timestamp) {
        return t1 > t2 ? t1 : t2;
    }
}
