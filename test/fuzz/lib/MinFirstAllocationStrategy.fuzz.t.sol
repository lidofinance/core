// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.25;

/**
 * @title  MinFirstAllocationStrategy Invariant Fuzz Suite
 * @notice Local-only Foundry fuzz/property tests for MinFirstAllocationStrategy.
 *
 *  The library allocates a budget of tokens across N buckets (each with a
 *  current fill level and a capacity cap), preferring to fill the least-filled
 *  buckets first.
 *
 *  Invariants verified:
 *
 *  MFAS-1  Budget conservation: actual allocated == Σ(finalBuckets - initialBuckets)
 *
 *  MFAS-2  Never over-allocates the budget: allocated <= allocationSize
 *
 *  MFAS-3  Capacity respected: forall i, finalBuckets[i] <= capacities[i]
 *
 *  MFAS-4  Monotone: buckets never decrease: forall i, finalBuckets[i] >= initialBuckets[i]
 *
 *  MFAS-5  Zero budget: allocate(buckets, caps, 0) returns 0 and leaves buckets unchanged
 *
 *  MFAS-6  Full-bucket skip: already-full buckets are never modified
 *
 *  MFAS-7  Maximum throughput: allocated == min(allocationSize, totalFreeSpace)
 *          where totalFreeSpace == Σ max(0, capacities[i] - buckets[i])
 */

import {Test} from "forge-std/Test.sol";
import {MinFirstAllocationStrategy} from "contracts/common/lib/MinFirstAllocationStrategy.sol";

contract MinFirstAllocationStrategyFuzzTest is Test {

    /// @dev Maximum number of buckets in a single fuzz call (keeps run times reasonable)
    uint256 constant MAX_N = 8;

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Build a valid (buckets, capacities) pair of length n.
     *      Each capacity is in [0, 2^32] and each bucket is in [0, capacity].
     *      Uses rawCaps and rawBuckets as seed material.
     */
    function _buildInputs(
        uint8    rawN,
        uint64[] memory rawCaps,
        uint64[] memory rawBuckets
    ) internal pure returns (
        uint256[] memory buckets,
        uint256[] memory capacities,
        uint256 totalFree
    ) {
        uint256 n = bound(uint256(rawN), 1, MAX_N);

        // Extend seed arrays if too short by wrapping (avoid empty-array panics)
        uint256 seedLen = rawCaps.length < n ? n : rawCaps.length;
        buckets    = new uint256[](n);
        capacities = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            uint256 capRaw = seedLen > 0 ? uint256(rawCaps[i % rawCaps.length]) : 0;
            uint256 cap    = bound(capRaw, 0, type(uint32).max);
            uint256 bucRaw = rawBuckets.length > 0 ? uint256(rawBuckets[i % rawBuckets.length]) : 0;
            uint256 buc    = bound(bucRaw, 0, cap); // buc <= cap is a pre-condition
            buckets[i]    = buc;
            capacities[i] = cap;
            totalFree     += cap - buc;
        }
    }

    /// @dev Return a deep copy of a uint256[] (allocated)
    function _copy(uint256[] memory src) internal pure returns (uint256[] memory dst) {
        dst = new uint256[](src.length);
        for (uint256 i = 0; i < src.length; i++) dst[i] = src[i];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MFAS-1 + MFAS-2 + MFAS-3 + MFAS-4: core allocation properties
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice  Fuzz across n, capacities, bucket fills, and allocation sizes.
     *          Verifies conservation, budget cap, per-bucket cap, and monotonicity.
     */
    function testFuzz_allocate_coreInvariants(
        uint8    rawN,
        uint64[] memory rawCaps,
        uint64[] memory rawBuckets,
        uint64   rawAlloc
    ) external pure {
        // Seed arrays must have at least 1 element or _buildInputs wraps safely
        if (rawCaps.length == 0) return;

        (uint256[] memory buckets, uint256[] memory capacities, ) =
            _buildInputs(rawN, rawCaps, rawBuckets);

        uint256 allocationSize = uint256(rawAlloc);
        uint256[] memory initialBuckets = _copy(buckets);

        (uint256 allocated, uint256[] memory finalBuckets) =
            MinFirstAllocationStrategy.allocate(buckets, capacities, allocationSize);

        // MFAS-1: conservation — actual delta matches returned `allocated`
        uint256 delta = 0;
        for (uint256 i = 0; i < finalBuckets.length; i++) {
            delta += finalBuckets[i] - initialBuckets[i];
        }
        assertEq(delta, allocated, "MFAS-1: delta must equal allocated");

        // MFAS-2: no over-allocation of the supplied budget
        assertLe(allocated, allocationSize, "MFAS-2: allocated must <= allocationSize");

        // MFAS-3 + MFAS-4: per-bucket constraints
        for (uint256 i = 0; i < finalBuckets.length; i++) {
            assertLe(finalBuckets[i], capacities[i],    "MFAS-3: bucket must <= capacity");
            assertGe(finalBuckets[i], initialBuckets[i], "MFAS-4: buckets must not decrease");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MFAS-5: zero-budget leaves everything unchanged
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzz_allocate_zeroBudget_noChange(
        uint8    rawN,
        uint64[] memory rawCaps,
        uint64[] memory rawBuckets
    ) external pure {
        if (rawCaps.length == 0) return;

        (uint256[] memory buckets, uint256[] memory capacities, ) =
            _buildInputs(rawN, rawCaps, rawBuckets);

        uint256[] memory initialBuckets = _copy(buckets);

        (uint256 allocated, uint256[] memory finalBuckets) =
            MinFirstAllocationStrategy.allocate(buckets, capacities, 0);

        assertEq(allocated, 0, "MFAS-5: zero budget must return allocated==0");
        for (uint256 i = 0; i < finalBuckets.length; i++) {
            assertEq(finalBuckets[i], initialBuckets[i], "MFAS-5: zero budget must not change buckets");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MFAS-6: already-full buckets are never changed
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzz_allocate_fullBuckets_unchanged(
        uint8    rawN,
        uint64[] memory rawCaps,
        uint64[] memory rawBuckets,
        uint64   rawAlloc
    ) external pure {
        if (rawCaps.length == 0) return;

        (uint256[] memory buckets, uint256[] memory capacities, ) =
            _buildInputs(rawN, rawCaps, rawBuckets);

        uint256 allocationSize = uint256(rawAlloc);
        uint256[] memory initialBuckets = _copy(buckets);

        (, uint256[] memory finalBuckets) =
            MinFirstAllocationStrategy.allocate(buckets, capacities, allocationSize);

        for (uint256 i = 0; i < finalBuckets.length; i++) {
            if (initialBuckets[i] == capacities[i]) {
                assertEq(finalBuckets[i], initialBuckets[i],
                    "MFAS-6: full bucket must remain unchanged");
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MFAS-7: maximum throughput — never leaves free space unused unnecessarily
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice  The strategy absorbs min(allocationSize, totalFreeSpace).
     *          Anything less means the algorithm stopped early without justification.
     */
    function testFuzz_allocate_fullThroughput(
        uint8    rawN,
        uint64[] memory rawCaps,
        uint64[] memory rawBuckets,
        uint64   rawAlloc
    ) external pure {
        if (rawCaps.length == 0) return;

        (uint256[] memory buckets, uint256[] memory capacities, uint256 totalFree) =
            _buildInputs(rawN, rawCaps, rawBuckets);

        uint256 allocationSize = uint256(rawAlloc);
        uint256 expected = allocationSize < totalFree ? allocationSize : totalFree;

        (uint256 allocated, ) =
            MinFirstAllocationStrategy.allocate(buckets, capacities, allocationSize);

        assertEq(allocated, expected, "MFAS-7: must fill min(budget, totalFreeSpace)");
    }
}
