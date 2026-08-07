// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/*
 GIndex library from CSM
 original: https://github.com/lidofinance/community-staking-module/blob/7071c2096983a7780a5f147963aaa5405c0badb1/src/lib/GIndex.sol
*/

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

type GIndex is bytes32;

using {isRoot, index, width, shr, shl, concat, unwrap, pow} for GIndex global;

error IndexOutOfRange();

uint256 constant INDEX_BIT_SIZE = 248;

/// @param gI Is a generalized index of a node in a tree.
/// @param p Is a power of a tree level the node belongs to.
/// @return GIndex
function pack(uint256 gI, uint8 p) pure returns (GIndex) {
    if (gI > type(uint248).max) {
        revert IndexOutOfRange();
    }

    // NOTE: We can consider adding additional metadata like a fork version.
    return GIndex.wrap(bytes32((gI << 8) | p));
}

function unwrap(GIndex self) pure returns (bytes32) {
    return GIndex.unwrap(self);
}

function isRoot(GIndex self) pure returns (bool) {
    return index(self) == 1;
}

function index(GIndex self) pure returns (uint256) {
    return uint256(unwrap(self)) >> 8;
}

function width(GIndex self) pure returns (uint256) {
    return 1 << pow(self);
}

function pow(GIndex self) pure returns (uint8) {
    return uint8(uint256(unwrap(self)));
}

/// @return Generalized index of the nth neighbor of the node to the right.
function shr(GIndex self, uint256 n) pure returns (GIndex) {
    uint256 i = index(self);
    uint256 w = width(self);

    if ((i % w) + n >= w) {
        revert IndexOutOfRange();
    }

    return pack(i + n, pow(self));
}

/// @return Generalized index of the nth neighbor of the node to the left.
function shl(GIndex self, uint256 n) pure returns (GIndex) {
    uint256 i = index(self);
    uint256 w = width(self);

    if (i % w < n) {
        revert IndexOutOfRange();
    }

    return pack(i - n, pow(self));
}

// See https://github.com/protolambda/remerkleable/blob/91ed092d08ef0ba5ab076f0a34b0b371623db728/remerkleable/tree.py#L46
function concat(GIndex lhs, GIndex rhs) pure returns (GIndex) {
    uint256 lindex = index(lhs);
    uint256 rindex = index(rhs);

    uint256 lhsMSbIndex = fls(lindex);
    uint256 rhsMSbIndex = fls(rindex);

    if (lhsMSbIndex + 1 + rhsMSbIndex > INDEX_BIT_SIZE) {
        revert IndexOutOfRange();
    }

    return pack((lindex << rhsMSbIndex) | (rindex ^ (1 << rhsMSbIndex)), pow(rhs));
}

/// @dev From Solady LibBit, see https://github.com/Vectorized/solady/blob/main/src/utils/LibBit.sol.
/// @dev Find last set.
/// Returns the index of the most significant bit of `x`,
/// counting from the least significant bit position.
/// If `x` is zero, returns 256.
function fls(uint256 x) pure returns (uint256 r) {
    // prettier-ignore
    /// @solidity memory-safe-assembly
    assembly {
        r := or(shl(8, iszero(x)), shl(7, lt(0xffffffffffffffffffffffffffffffff, x)))
        r := or(r, shl(6, lt(0xffffffffffffffff, shr(r, x))))
        r := or(r, shl(5, lt(0xffffffff, shr(r, x))))
        r := or(r, shl(4, lt(0xffff, shr(r, x))))
        r := or(r, shl(3, lt(0xff, shr(r, x))))
        r := or(r, byte(and(0x1f, shr(shr(r, x), 0x8421084210842108cc6318c6db6d54be)),
                0x0706060506020504060203020504030106050205030304010505030400000000))
    }
}

/// @param i Index of a node relative to the root of ProgressiveList[type].
function progressiveListNodeGIndex(uint256 i) pure returns (GIndex gI) {
    if (i > (type(uint256).max - 1) / 3) {
        revert IndexOutOfRange();
    }

    // Progressive-list chunk sizes are powers of four. The geometric series
    // identifies the chunk containing i without walking every preceding chunk.
    uint256 k = fls(i * 3 + 1) >> 1;

    unchecked {
        if (3 * k + 3 > INDEX_BIT_SIZE) revert IndexOutOfRange();
    }

    assembly ("memory-safe") {
        let twoK := shl(1, k)
        // Down to the chunk root (getting in binary something like this: 0x101(1)).
        gI := sub(shl(k, 3), 1)
        // One step to the left to the nodes.
        gI := shl(1, gI)
        // Down to the first node in the chunk.
        gI := shl(twoK, gI)
        // Using the geometric series formula we compute how many nodes we skipped to get the correct offset in the level.
        i := sub(i, div(sub(shl(twoK, 1), 1), 3))
        // To the right to the node we're looking for.
        gI := add(gI, i)
        // Shift to conform the current GIndex layout.
        gI := shl(8, gI)
    }
}
