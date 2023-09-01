// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

library Math {
    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Tests if x ∈ [a, b) (mod n)
    ///
    function pointInHalfOpenIntervalModN(uint256 x, uint256 a, uint256 b, uint256 n)
        internal pure returns (bool)
    {
        return (x + n - a) % n < (b - a) % n;
    }

    /// @notice Tests if x ∈ [a, b] (mod n)
    ///
    function pointInClosedIntervalModN(uint256 x, uint256 a, uint256 b, uint256 n)
        internal pure returns (bool)
    {
        return (x + n - a) % n <= (b - a) % n;
    }
}
