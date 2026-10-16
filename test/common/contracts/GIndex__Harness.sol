// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.25;

import {
    GIndex,
    toGIndex,
    fls,
    ceilLog2,
    staticListNodeGIndex,
    vectorNodeGIndex,
    progressiveListNodeGIndex
} from "contracts/common/lib/GIndex.sol";

/**
 * @dev Test contract for GIndex library in TypeScript tests
 */
contract GIndex__Harness {
    function wrap(uint256 value) external pure returns (GIndex) {
        return GIndex.wrap(value);
    }

    function unwrap(GIndex gIndex) external pure returns (uint256) {
        return gIndex.unwrap();
    }

    function toGIndex(uint256 gI) external pure returns (GIndex) {
        return toGIndex(gI);
    }

    function isRoot(GIndex gIndex) external pure returns (bool) {
        return gIndex.isRoot();
    }

    function concat(GIndex lhs, GIndex rhs) external pure returns (GIndex) {
        return lhs.concat(rhs);
    }

    function fls(uint256 x) external pure returns (uint256) {
        return fls(x);
    }

    function ceilLog2(uint256 x) external pure returns (uint256) {
        return ceilLog2(x);
    }

    function staticListNode(uint256 i, uint256 depth) external pure returns (GIndex) {
        return staticListNodeGIndex(i, depth);
    }

    function vectorNode(uint256 i, uint256 length) external pure returns (GIndex) {
        return vectorNodeGIndex(i, length);
    }

    function progressiveListNode(uint256 i) external pure returns (GIndex) {
        return progressiveListNodeGIndex(i);
    }
}

/**
 * @dev Library wrapper for testing error cases
 */
contract GIndexLibrary__Harness {
    function concat(GIndex lhs, GIndex rhs) public returns (GIndex) {
        return lhs.concat(rhs);
    }

    function staticListNode(uint256 i, uint256 depth) external pure returns (GIndex) {
        return staticListNodeGIndex(i, depth);
    }

    function vectorNode(uint256 i, uint256 length) external pure returns (GIndex) {
        return vectorNodeGIndex(i, length);
    }

    function progressiveListNode(uint256 i) external pure returns (GIndex) {
        return progressiveListNodeGIndex(i);
    }
}
