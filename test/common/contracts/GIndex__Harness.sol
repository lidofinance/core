// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.25;

import {GIndex, pack, IndexOutOfRange, fls} from "contracts/common/lib/GIndex.sol";

/**
 * @dev Test contract for GIndex library in TypeScript tests
 */
contract GIndex__Harness {
    function wrap(bytes32 value) external pure returns (GIndex) {
        return GIndex.wrap(value);
    }

    function unwrap(GIndex gIndex) external pure returns (bytes32) {
        return gIndex.unwrap();
    }

    function pack(uint248 index, uint8 pow) external pure returns (GIndex) {
        return pack(index, pow);
    }

    function isRoot(GIndex gIndex) external pure returns (bool) {
        return gIndex.isRoot();
    }

    function isParentOf(GIndex lhs, GIndex rhs) external pure returns (bool) {
        return lhs.isParentOf(rhs);
    }

    function index(GIndex gIndex) external pure returns (uint256) {
        return gIndex.index();
    }

    function width(GIndex gIndex) external pure returns (uint256) {
        return gIndex.width();
    }

    function concat(GIndex lhs, GIndex rhs) external pure returns (GIndex) {
        return lhs.concat(rhs);
    }

    function shr(GIndex self, uint256 n) external pure returns (GIndex) {
        return self.shr(n);
    }

    function shl(GIndex self, uint256 n) external pure returns (GIndex) {
        return self.shl(n);
    }

    function fls(uint256 x) external pure returns (uint256) {
        return fls(x);
    }
}

/**
 * @dev Library wrapper for testing error cases
 */
contract GIndexLibrary__Harness {
    function concat(GIndex lhs, GIndex rhs) public returns (GIndex) {
        return lhs.concat(rhs);
    }

    function shr(GIndex self, uint256 n) public returns (GIndex) {
        return self.shr(n);
    }

    function shl(GIndex self, uint256 n) public returns (GIndex) {
        return self.shl(n);
    }
}
