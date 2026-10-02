// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.25;

/**
 * @title  GIndex Arithmetic Fuzz Suite
 * @notice Local-only Foundry fuzz/property tests for the GIndex library.
 *
 *  Properties verified:
 *
 *  FF-1  pack / roundtrip
 *        index(pack(gI, p)) == gI  &&  pow(pack(gI, p)) == p
 *
 *  FF-2  width == 2^p
 *        width(pack(gI, p)) == 2^p
 *
 *  FF-3  isRoot iff index == 1
 *        pack(1, any) isRoot;  pack(n>1, any) is not root
 *
 *  FF-4  shr is the inverse of shl when both are in range
 *        g.shr(n).shl(n) == g  (when both ops are in bounds)
 *
 *  FF-5  shl is the inverse of shr when both are in range
 *        g.shl(n).shr(n) == g  (when both ops are in bounds)
 *
 *  FF-6  shr(n) index == index + n
 *        index(g.shr(n)) == index(g) + n  (when in bounds)
 *
 *  FF-7  shl(n) index == index - n
 *        index(g.shl(n)) == index(g) - n  (when in bounds)
 *
 *  FF-8  shr / shl depth preservation
 *        pow is unchanged by shr/shl
 *
 *  FF-9  shr out-of-bounds reverts with IndexOutOfRange
 *
 *  FF-10 shl out-of-bounds reverts with IndexOutOfRange
 *
 *  FF-11 pack overflow (gI > uint248.max) reverts with IndexOutOfRange
 *
 *  FF-12 fls(0) == 256  (Solady LibBit contract)
 *
 *  FF-13 fls(2^k) == k  for k in [0, 247]
 */

import {Test} from "forge-std/Test.sol";
import {GIndex, pack, unwrap, index, pow, width, shr, shl, isRoot, concat}
    from "contracts/common/lib/GIndex.sol";

// ── expose the private fls helper so we can fuzz it ──────────────────────────
function fls_exposed(uint256 x) pure returns (uint256 r) {
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

// ──────────────────────────────────────────────────────────────────────────────
// External call helper — required because vm.expectRevert only intercepts reverts
// that bubble up from a sub-call; direct calls to free pure functions revert in
// the same frame and cannot be caught with expectRevert.
// ──────────────────────────────────────────────────────────────────────────────

contract GIndexCallHelper {
    function callPack(uint256 gI, uint8 p) external pure returns (GIndex) {
        return pack(gI, p);
    }
    function callShr(GIndex g, uint256 n) external pure returns (GIndex) {
        return g.shr(n);
    }
    function callShl(GIndex g, uint256 n) external pure returns (GIndex) {
        return g.shl(n);
    }
}

// ─────────────────────────────────────────────────────────────────────────────

contract GIndexFuzzTest is Test {
    GIndexCallHelper helper;

    function setUp() external {
        helper = new GIndexCallHelper();
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    /// Build a valid GIndex: index in [2^p, 2^(p+1)) so it is a legal leaf at depth p.
    /// Returns (GIndex, constrainedGI, constrainedP)
    function _validGI(uint248 rawGI, uint8 rawP)
        internal pure
        returns (GIndex g, uint256 gI, uint8 p)
    {
        // Depth: 1–20 (avoids degenerate p==0 root-only edge cases where index must be 1)
        p   = uint8(bound(uint256(rawP), 1, 20));
        // Index: anything in [2^p, 2^(p+1) - 1]
        gI  = bound(uint256(rawGI), 1 << p, (1 << (p + 1)) - 1);
        g   = pack(gI, p);
    }

    // ── FF-1: pack / roundtrip ────────────────────────────────────────────────

    /**
     * @notice  pack then unpack must recover the original index and depth.
     *          A bug here corrupts every downstream calculation.
     */
    function testFuzz_packRoundtrip(uint248 rawGI, uint8 rawP) external pure {
        (, uint256 gI, uint8 p) = _validGI(rawGI, rawP);
        GIndex g = pack(gI, p);
        assertEq(index(g), gI, "FF-1: index roundtrip failed");
        assertEq(pow(g),   p,  "FF-1: pow roundtrip failed");
    }

    // ── FF-2: width == 2^p ───────────────────────────────────────────────────

    /**
     * @notice  width() must return 2^p.  Broken width() would corrupt every
     *          bounds check in shr/shl.
     */
    function testFuzz_widthIs2PowP(uint248 rawGI, uint8 rawP) external pure {
        (GIndex g, , uint8 p) = _validGI(rawGI, rawP);
        assertEq(width(g), uint256(1) << p, "FF-2: width != 2^p");
    }

    // ── FF-3: isRoot iff index == 1 ──────────────────────────────────────────

    /**
     * @notice  isRoot is true only when index == 1.
     *          Must be true for pack(1, p) and false for any index > 1.
     */
    function testFuzz_isRoot_trueOnlyForIndex1(uint8 rawP) external pure {
        uint8 p = uint8(bound(uint256(rawP), 0, 20));
        GIndex g = pack(1, p);
        assertTrue(isRoot(g), "FF-3: pack(1,p) should be root");
    }

    function testFuzz_isRoot_falseForIndex2Plus(uint248 rawGI, uint8 rawP) external pure {
        (, uint256 gI, uint8 p) = _validGI(rawGI, rawP);
        if (gI == 1) return; // skip root degenerate case
        GIndex g = pack(gI, p);
        assertFalse(isRoot(g), "FF-3: non-root index should not be root");
    }

    // ── FF-4 / FF-5: shr and shl are mutual inverses ─────────────────────────

    /**
     * @notice  g.shr(n).shl(n) == g  whenever both ops are in bounds.
     *          A violation means shr and shl are not consistent with each other.
     */
    function testFuzz_shrThenShl_identity(
        uint248 rawGI,
        uint8   rawP,
        uint32  rawN
    ) external pure {
        (GIndex g, uint256 gI, uint8 p) = _validGI(rawGI, rawP);
        uint256 w = uint256(1) << p;
        // position of gI within its row: 0-indexed
        uint256 pos = gI % w;
        uint256 remaining = w - 1 - pos;
        if (remaining == 0) return; // nothing to shr

        uint256 n = bound(uint256(rawN), 1, remaining);

        GIndex shifted = g.shr(n);
        GIndex back    = shifted.shl(n);

        assertEq(unwrap(back), unwrap(g), "FF-4: shr->shl should be identity");
    }

    /**
     * @notice  g.shl(n).shr(n) == g  whenever both ops are in bounds.
     */
    function testFuzz_shlThenShr_identity(
        uint248 rawGI,
        uint8   rawP,
        uint32  rawN
    ) external pure {
        (GIndex g, uint256 gI, uint8 p) = _validGI(rawGI, rawP);
        uint256 w = uint256(1) << p;
        uint256 pos = gI % w;
        if (pos == 0) return; // already at left edge

        uint256 n = bound(uint256(rawN), 1, pos);

        GIndex shifted = g.shl(n);
        GIndex back    = shifted.shr(n);

        assertEq(unwrap(back), unwrap(g), "FF-5: shl->shr should be identity");
    }

    // ── FF-6: shr(n) increments index by n ───────────────────────────────────

    function testFuzz_shrIncrementsIndex(
        uint248 rawGI,
        uint8   rawP,
        uint32  rawN
    ) external pure {
        (GIndex g, uint256 gI, uint8 p) = _validGI(rawGI, rawP);
        uint256 w = uint256(1) << p;
        uint256 pos = gI % w;
        uint256 remaining = w - 1 - pos;
        if (remaining == 0) return;

        uint256 n = bound(uint256(rawN), 1, remaining);
        GIndex shifted = g.shr(n);

        assertEq(index(shifted), gI + n, "FF-6: shr did not add n to index");
    }

    // ── FF-7: shl(n) decrements index by n ───────────────────────────────────

    function testFuzz_shlDecrementsIndex(
        uint248 rawGI,
        uint8   rawP,
        uint32  rawN
    ) external pure {
        (GIndex g, uint256 gI, uint8 p) = _validGI(rawGI, rawP);
        uint256 w = uint256(1) << p;
        uint256 pos = gI % w;
        if (pos == 0) return;

        uint256 n = bound(uint256(rawN), 1, pos);
        GIndex shifted = g.shl(n);

        assertEq(index(shifted), gI - n, "FF-7: shl did not subtract n from index");
    }

    // ── FF-8: shr/shl preserve depth ─────────────────────────────────────────

    function testFuzz_shrPreservesDepth(
        uint248 rawGI,
        uint8   rawP,
        uint32  rawN
    ) external pure {
        (GIndex g, uint256 gI, uint8 p) = _validGI(rawGI, rawP);
        uint256 w = uint256(1) << p;
        uint256 pos = gI % w;
        uint256 remaining = w - 1 - pos;
        if (remaining == 0) return;

        uint256 n = bound(uint256(rawN), 1, remaining);
        assertEq(pow(g.shr(n)), p, "FF-8: shr changed depth");
    }

    function testFuzz_shlPreservesDepth(
        uint248 rawGI,
        uint8   rawP,
        uint32  rawN
    ) external pure {
        (GIndex g, uint256 gI, uint8 p) = _validGI(rawGI, rawP);
        uint256 w = uint256(1) << p;
        uint256 pos = gI % w;
        if (pos == 0) return;

        uint256 n = bound(uint256(rawN), 1, pos);
        assertEq(pow(g.shl(n)), p, "FF-8: shl changed depth");
    }

    // ── FF-9: shr out-of-bounds reverts ──────────────────────────────────────

    /**
     * @notice  shr by any amount that would step past the right edge of the row
     *          must revert with IndexOutOfRange.
     */
    function testFuzz_shr_revertsOutOfBounds(
        uint248 rawGI,
        uint8   rawP,
        uint32  rawExcess
    ) external {
        (GIndex g, uint256 gI, uint8 p) = _validGI(rawGI, rawP);
        uint256 w = uint256(1) << p;
        uint256 pos = gI % w;
        uint256 remaining = w - 1 - pos;

        // n must exceed the remaining space
        uint256 n = remaining + 1 + bound(uint256(rawExcess), 0, 1_000_000);

        vm.expectRevert(bytes4(keccak256("IndexOutOfRange()")));
        helper.callShr(g, n);
    }

    // ── FF-10: shl out-of-bounds reverts ─────────────────────────────────────

    function testFuzz_shl_revertsOutOfBounds(
        uint248 rawGI,
        uint8   rawP,
        uint32  rawExcess
    ) external {
        (GIndex g, uint256 gI, uint8 p) = _validGI(rawGI, rawP);
        uint256 w = uint256(1) << p;
        uint256 pos = gI % w;

        // n must exceed the current left position
        uint256 n = pos + 1 + bound(uint256(rawExcess), 0, 1_000_000);

        vm.expectRevert(bytes4(keccak256("IndexOutOfRange()")));
        helper.callShl(g, n);
    }

    // ── FF-11: pack overflows revert ─────────────────────────────────────────

    /**
     * @notice  Any gI > type(uint248).max must revert with IndexOutOfRange.
     *          Values beyond uint248 would silently truncate the packed index.
     */
    function testFuzz_pack_revertsOnOverflow(uint256 rawGI, uint8 p) external {
        // Force rawGI above uint248 max
        uint256 gI = bound(rawGI, uint256(type(uint248).max) + 1, type(uint256).max);
        vm.expectRevert(bytes4(keccak256("IndexOutOfRange()")));
        helper.callPack(gI, p);
    }

    // ── FF-12: fls(0) == 256 ─────────────────────────────────────────────────

    /**
     * @notice  The LibBit fls(0) contract: returns 256 for the zero input.
     *          A regression here would corrupt concat() bounds checking.
     */
    function test_fls_zero() external pure {
        assertEq(fls_exposed(0), 256, "FF-12: fls(0) should be 256");
    }

    // ── FF-13: fls(2^k) == k for k in [0, 247] ───────────────────────────────

    /**
     * @notice  fls must return the position of the highest set bit.
     *          Broken fls would corrupt concat's depth arithmetic.
     */
    function testFuzz_fls_powerOfTwo(uint8 rawK) external pure {
        uint8 k = uint8(bound(uint256(rawK), 0, 247));
        uint256 x = uint256(1) << k;
        assertEq(fls_exposed(x), k, "FF-13: fls(2^k) should return k");
    }

    // ── FF-bonus: concat depth == rhs depth ──────────────────────────────────

    /**
     * @notice  concat(lhs, rhs).pow == rhs.pow.
     *          The depth of the composed path is governed by the rhs subtree.
     */
    function testFuzz_concat_depthIsRhsDepth(
        uint248 rawLGI, uint8 rawLP,
        uint248 rawRGI, uint8 rawRP
    ) external pure {
        // Keep depths small to avoid IndexOutOfRange from concat's 248-bit cap
        (, uint256 lGI, uint8 lP) = _validGI(rawLGI, uint8(bound(uint256(rawLP), 1, 10)));
        (, uint256 rGI, uint8 rP) = _validGI(rawRGI, uint8(bound(uint256(rawRP), 1, 10)));

        // Heuristic guard: skip if combined bit-width would overflow 248 bits
        uint256 lBits = fls_exposed(lGI) + 1;
        uint256 rBits = fls_exposed(rGI);
        if (lBits + rBits > 248) return;

        GIndex lhs = pack(lGI, lP);
        GIndex rhs = pack(rGI, rP);
        GIndex composed = lhs.concat(rhs);

        assertEq(pow(composed), rP, "FF-bonus: concat depth should equal rhs depth");
    }
}
