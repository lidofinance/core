// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT

// Copied from: https://github.com/OpenZeppelin/openzeppelin-contracts/blob/0457042d93d9dfd760dbaa06a4d2f1216fdbe297/contracts/utils/math/Math.sol

// See contracts/COMPILERS.md
// solhint-disable-next-line
pragma solidity ^0.4.24;

import {SafeMath} from "@aragon/os/contracts/lib/math/SafeMath.sol";

/// @notice Provides an interface for gas-efficient operations on four uint64 type
///         variables tightly packed into one uint256 variable stored in memory
library Packed64x4 {
    using SafeMath for uint256;
    using Packed64x4 for Packed64x4.Packed;

    uint256 internal constant UINT64_MAX = 0xFFFFFFFFFFFFFFFF;

    struct Packed {
        uint256 v;
    }

    /// @dev Returns uint64 variable stored on position `n` as uint256
    function get(Packed memory _self, uint8 n) internal pure returns (uint256 r) {
        r = (_self.v >> (64 * n)) & UINT64_MAX;
    }

    /// @dev Writes value stored in passed `x` variable on position `n`.
    ///      The passed value must be less or equal to UINT64_MAX.
    ///      If the passed value exceeds UINT64_MAX method will
    ///      revert with a "PACKED_OVERFLOW" error message
    function set(Packed memory _self, uint8 n, uint256 x) internal pure {
        require(x <= UINT64_MAX, "PACKED_OVERFLOW");
        _self.v = _self.v & ~(UINT64_MAX << (64 * n)) | ((x & UINT64_MAX) << (64 * n));
    }

    /// @dev Adds value stored in passed `x` variable to variable stored on position `n`
    ///      using SafeMath lib
    function add(Packed memory _self, uint8 n, uint256 x) internal pure {
        set(_self, n, get(_self, n).add(x));
    }

    /// @dev Subtract value stored in passed `x` variable from variable stored on position `n`
    ///      using SafeMath lib
    function sub(Packed memory _self, uint8 n, uint256 x) internal pure {
        set(_self, n, get(_self, n).sub(x));
    }
}
