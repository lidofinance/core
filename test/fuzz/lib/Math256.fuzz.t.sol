// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.25;

/**
 * @title  Math256 Property Fuzz Suite
 * @notice Local-only Foundry fuzz/property tests for the Math256 library.
 *
 *  Properties verified:
 *
 *  M256-1  max(a,b) returns the larger value
 *          result >= a  &&  result >= b
 *          result == a  ||  result == b
 *
 *  M256-2  min(a,b) returns the smaller value
 *          result <= a  &&  result <= b
 *          result == a  ||  result == b
 *
 *  M256-3  max / min are commutative
 *          max(a,b) == max(b,a)
 *          min(a,b) == min(b,a)
 *
 *  M256-4  max(a,a) == a   and   min(a,a) == a  (idempotence)
 *
 *  M256-5  ceilDiv(a, b) >= a / b   (ceiling is at least floor)
 *          ceilDiv(a, b) <= a / b + 1  (ceiling is at most floor + 1)
 *
 *  M256-6  ceilDiv(a, b) * b >= a   (covers a; bounded inputs prevent overflow)
 *
 *  M256-7  ceilDiv(0, b) == 0  for any b > 0
 *
 *  M256-8  absDiff(a, b) == absDiff(b, a)  (symmetry)
 *
 *  M256-9  absDiff(a, b) == (a >= b ? a - b : b - a)  (specification match)
 *
 *  M256-10 absDiff(a, a) == 0  (self-distance is zero)
 *
 *  M256-i1 max(int256, int256) correctness and commutativity
 *  M256-i2 min(int256, int256) correctness and commutativity
 */

import {Test} from "forge-std/Test.sol";
import {Math256} from "contracts/common/lib/Math256.sol";

contract Math256FuzzTest is Test {

    // ── M256-1: max(uint256) ──────────────────────────────────────────────────

    /**
     * @notice  max(a,b) must be >= both operands and equal to one of them.
     */
    function testFuzz_max_uint(uint256 a, uint256 b) external pure {
        uint256 m = Math256.max(a, b);
        assertGe(m, a, "M256-1: max must be >= a");
        assertGe(m, b, "M256-1: max must be >= b");
        assertTrue(m == a || m == b, "M256-1: max must equal a or b");
    }

    // ── M256-2: min(uint256) ──────────────────────────────────────────────────

    /**
     * @notice  min(a,b) must be <= both operands and equal to one of them.
     */
    function testFuzz_min_uint(uint256 a, uint256 b) external pure {
        uint256 m = Math256.min(a, b);
        assertLe(m, a, "M256-2: min must be <= a");
        assertLe(m, b, "M256-2: min must be <= b");
        assertTrue(m == a || m == b, "M256-2: min must equal a or b");
    }

    // ── M256-3: commutativity ─────────────────────────────────────────────────

    function testFuzz_max_commutative(uint256 a, uint256 b) external pure {
        assertEq(Math256.max(a, b), Math256.max(b, a), "M256-3: max must be commutative");
    }

    function testFuzz_min_commutative(uint256 a, uint256 b) external pure {
        assertEq(Math256.min(a, b), Math256.min(b, a), "M256-3: min must be commutative");
    }

    // ── M256-4: idempotence ───────────────────────────────────────────────────

    function testFuzz_max_idempotent(uint256 a) external pure {
        assertEq(Math256.max(a, a), a, "M256-4: max(a,a) must be a");
    }

    function testFuzz_min_idempotent(uint256 a) external pure {
        assertEq(Math256.min(a, a), a, "M256-4: min(a,a) must be a");
    }

    // ── M256-5: ceilDiv bounds ────────────────────────────────────────────────

    /**
     * @notice  ceilDiv(a, b) exactly equals ⌊a/b⌋ when b divides a evenly,
     *          or ⌊a/b⌋+1 otherwise.
     *          b=0 is excluded (would panic).
     *          Note: the unconditional `a/b + 1` form overflows when a=uint256.max, b=1,
     *          so we split into the two precise cases instead.
     */
    function testFuzz_ceilDiv_boundsFloor(uint256 a, uint256 b) external pure {
        b = bound(b, 1, type(uint256).max);
        uint256 c = Math256.ceilDiv(a, b);
        uint256 floor = a / b;
        if (a % b == 0) {
            assertEq(c, floor,     "M256-5: exact division: ceilDiv must equal floor");
        } else {
            assertEq(c, floor + 1, "M256-5: non-exact:      ceilDiv must equal floor+1");
        }
    }

    // ── M256-6: ceilDiv(a, b) * b >= a  (capped inputs to prevent overflow) ──

    /**
     * @notice  ceilDiv(a,b)*b must be >= a.
     *          Inputs bounded to [0, 2^128] so the multiplication cannot overflow.
     */
    function testFuzz_ceilDiv_productCoversA(uint128 rawA, uint128 rawB) external pure {
        uint256 a = uint256(rawA);
        uint256 b = bound(uint256(rawB), 1, type(uint128).max);
        uint256 c = Math256.ceilDiv(a, b);
        // product is at most (2^128 + 1) * 2^128 which is within uint256
        assertGe(c * b, a, "M256-6: ceilDiv(a,b)*b must cover a");
    }

    // ── M256-7: ceilDiv(0, b) == 0 ───────────────────────────────────────────

    function testFuzz_ceilDiv_zeroNumerator(uint256 b) external pure {
        b = bound(b, 1, type(uint256).max);
        assertEq(Math256.ceilDiv(0, b), 0, "M256-7: ceilDiv(0, b) must be 0");
    }

    // ── M256-8: absDiff symmetry ──────────────────────────────────────────────

    function testFuzz_absDiff_symmetric(uint256 a, uint256 b) external pure {
        assertEq(Math256.absDiff(a, b), Math256.absDiff(b, a), "M256-8: absDiff must be symmetric");
    }

    // ── M256-9: absDiff specification match ──────────────────────────────────

    function testFuzz_absDiff_specMatch(uint256 a, uint256 b) external pure {
        uint256 expected = a >= b ? a - b : b - a;
        assertEq(Math256.absDiff(a, b), expected, "M256-9: absDiff must match spec");
    }

    // ── M256-10: absDiff(a, a) == 0 ──────────────────────────────────────────

    function testFuzz_absDiff_selfIsZero(uint256 a) external pure {
        assertEq(Math256.absDiff(a, a), 0, "M256-10: absDiff(a,a) must be 0");
    }

    // ── M256-i1: max(int256) ──────────────────────────────────────────────────

    function testFuzz_max_int_correctness(int256 a, int256 b) external pure {
        int256 m = Math256.max(a, b);
        assertTrue(m >= a,        "M256-i1: max must be >= a");
        assertTrue(m >= b,        "M256-i1: max must be >= b");
        assertTrue(m == a || m == b, "M256-i1: max must equal a or b");
    }

    function testFuzz_max_int_commutative(int256 a, int256 b) external pure {
        assertEq(Math256.max(a, b), Math256.max(b, a), "M256-i1: max must be commutative");
    }

    // ── M256-i2: min(int256) ──────────────────────────────────────────────────

    function testFuzz_min_int_correctness(int256 a, int256 b) external pure {
        int256 m = Math256.min(a, b);
        assertTrue(m <= a,        "M256-i2: min must be <= a");
        assertTrue(m <= b,        "M256-i2: min must be <= b");
        assertTrue(m == a || m == b, "M256-i2: min must equal a or b");
    }

    function testFuzz_min_int_commutative(int256 a, int256 b) external pure {
        assertEq(Math256.min(a, b), Math256.min(b, a), "M256-i2: min must be commutative");
    }
}
