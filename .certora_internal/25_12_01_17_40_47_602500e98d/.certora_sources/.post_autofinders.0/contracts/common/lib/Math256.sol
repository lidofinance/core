// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT

// Copied from: https://github.com/OpenZeppelin/openzeppelin-contracts/blob/0457042d93d9dfd760dbaa06a4d2f1216fdbe297/contracts/utils/math/Math.sol

// See contracts/COMPILERS.md
// solhint-disable-next-line
pragma solidity >=0.4.24 <0.9.0;

library Math256 {
    /// @dev Returns the largest of two numbers.
    function max(uint256 a, uint256 b) internal pure returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006e0000, 1037618708590) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006e0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006e1000, a) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006e1001, b) }
        return a > b ? a : b;
    }

    /// @dev Returns the smallest of two numbers.
    function min(uint256 a, uint256 b) internal pure returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006f0000, 1037618708591) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006f0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006f1000, a) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006f1001, b) }
        return a < b ? a : b;
    }

    /// @dev Returns the largest of two numbers.
    function max(int256 a, int256 b) internal pure returns (int256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00710000, 1037618708593) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00710001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00711000, a) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00711001, b) }
        return a > b ? a : b;
    }

    /// @dev Returns the smallest of two numbers.
    function min(int256 a, int256 b) internal pure returns (int256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00720000, 1037618708594) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00720001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00721000, a) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00721001, b) }
        return a < b ? a : b;
    }

    /// @dev Returns the ceiling of the division of two numbers.
    ///
    /// This differs from standard division with `/` in that it rounds up instead
    /// of rounding down.
    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00700000, 1037618708592) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00700001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00701000, a) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00701001, b) }
        // (a + b - 1) / b can overflow on addition, so we distribute.
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// @dev Returns absolute difference of two numbers.
    function absDiff(uint256 a, uint256 b) internal pure returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00730000, 1037618708595) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00730001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00731000, a) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00731001, b) }
        return a > b ? a - b : b - a;
    }
}
