// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/*
 GIndex library from CSM
 original: https://github.com/lidofinance/community-staking-module/blob/7071c2096983a7780a5f147963aaa5405c0badb1/src/lib/GIndex.sol
*/

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

/// @dev A plain generalized index of a node in a binary Merkle tree, see
///      https://github.com/ethereum/consensus-specs/blob/dev/ssz/merkle-proofs.md#generalized-merkle-tree-index
type GIndex is uint256;

using {isRoot, concat, unwrap} for GIndex global;

error IndexOutOfRange();

uint256 constant GINDEX_BIT_SIZE = 256;

function unwrap(GIndex self) pure returns (uint256) {
    return GIndex.unwrap(self);
}

function toGIndex(uint256 gI) pure returns (GIndex) {
    return GIndex.wrap(gI);
}

function isRoot(GIndex self) pure returns (bool) {
    return self.unwrap() == 1;
}

// See https://github.com/protolambda/remerkleable/blob/91ed092d08ef0ba5ab076f0a34b0b371623db728/remerkleable/tree.py#L46
function concat(GIndex lhs, GIndex rhs) pure returns (GIndex) {
    uint256 lindex = lhs.unwrap();
    uint256 rindex = rhs.unwrap();

    uint256 lhsMSbIndex = fls(lindex);
    uint256 rhsMSbIndex = fls(rindex);

    if (lhsMSbIndex + 1 + rhsMSbIndex > GINDEX_BIT_SIZE) {
        revert IndexOutOfRange();
    }

    return toGIndex((lindex << rhsMSbIndex) | (rindex ^ (1 << rhsMSbIndex)));
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

/// @return r The exponent of the smallest power of two greater than or equal to `x`.
function ceilLog2(uint256 x) pure returns (uint256 r) {
    if (x < 2) return 0;

    unchecked {
        return fls(x - 1) + 1;
    }
}

/// @param i Index of a node in the List[type, N].
/// @param depth Depth of the List[type, N] data tree, so N = 2 ** depth.
/// @return gI Generalized index of the ith node relative to the root of the List[type, N].
function staticListNodeGIndex(uint256 i, uint256 depth) pure returns (GIndex gI) {
    if (depth + 2 > GINDEX_BIT_SIZE) revert IndexOutOfRange();
    if (i >= 1 << depth) revert IndexOutOfRange();

    // Start with the left node under the root (sibling of the length node).
    uint256 p = 2;

    // Down to the first node in the very bottom layer.
    p = p << depth;
    // Shift right to the node requested.
    p = p + i;

    gI = toGIndex(p);
}

/// @param i Index of a node in the Vector[type, N].
/// @param length Length N of the vector.
/// @return gI Generalized index of the ith node relative to the root of the Vector[type, N].
function vectorNodeGIndex(uint256 i, uint256 length) pure returns (GIndex gI) {
    if (i >= length) revert IndexOutOfRange();
    uint256 p = ceilLog2(length);
    if (p >= GINDEX_BIT_SIZE) revert IndexOutOfRange();
    unchecked {
        gI = toGIndex((1 << p) + i);
    }
}

/// @param i Index of a node in the ProgressiveList[type].
/// @return gI Generalized index of the ith node relative to the root of the ProgressiveList[type].
function progressiveListNodeGIndex(uint256 i) pure returns (GIndex gI) {
    if (i > (type(uint256).max - 1) / 3) {
        revert IndexOutOfRange();
    }

    // Progressive-list chunk sizes are powers of four. The geometric series
    // identifies the chunk containing i without walking every preceding chunk.
    uint256 k = fls(i * 3 + 1) >> 1;

    unchecked {
        if (3 * k + 3 > GINDEX_BIT_SIZE) revert IndexOutOfRange();
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
    }
}
