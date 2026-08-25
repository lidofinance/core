// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.25;

/**
 * @title  RefSlotCache Extended Invariant Suite
 * @notice Extends coverage beyond the original 2-invariant suite in refSlotCache.t.sol
 *         by exercising:
 *           - Large (multi-slot) refSlot jumps
 *           - Both positive and negative increments
 *           - Boundary conditions on getValueForRefSlot
 *
 *  Invariants verified:
 *    INV-1  active.refSlot >= prev.refSlot            (buffer ordering)
 *    INV-2  getValueForRefSlot(> active.refSlot) == currentValue()
 *                                                     (future-slot fallback)
 *    INV-3  getValueForRefSlot(prevRefSlot) ==
 *             prevCache.valueOnRefSlot                (snapshot consistency)
 *    INV-4  getValueForRefSlot(too-old) reverts       (overflow detection)
 *    INV-5  ghost cumulative sum matches currentValue()
 *             (net sum accounting)
 */

import "forge-std/Test.sol";
import {CommonBase}  from "forge-std/Base.sol";
import {StdCheats}   from "forge-std/StdCheats.sol";
import {StdUtils}    from "forge-std/StdUtils.sol";

import {DoubleRefSlotCache, DOUBLE_CACHE_LENGTH}
    from "contracts/0.8.25/vaults/lib/RefSlotCache.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";

// ──────────────────────────────────────────────────────────────────────────────
// Harness — mirrors DoubleRefSlotCacheExample but adds multi-slot jumps and
// exposes raw cache state for invariant inspection.
// ──────────────────────────────────────────────────────────────────────────────

contract RefSlotCacheHarness {
    using DoubleRefSlotCache for DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH];

    DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] public cacheStorage;

    uint256 public refSlot;

    // ── State-changing operations ─────────────────────────────────────────────

    /// Advance refSlot by exactly 1 (matches existing suite)
    function advanceSlotByOne() external {
        refSlot++;
    }

    /// Advance refSlot by a bounded amount (1-16) to exercise slot gaps
    function advanceSlotByN(uint256 n) external {
        n = n == 0 ? 1 : n > 16 ? 16 : n;
        refSlot += n;
    }

    /// Apply a delta to the current accumulated value
    function applyDelta(int104 delta) external
        returns (DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory)
    {
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory newStorage =
            cacheStorage.withValueIncrease(IHashConsensus(address(this)), delta);
        cacheStorage = newStorage;
        return newStorage;
    }

    // ── Read helpers ──────────────────────────────────────────────────────────

    function currentValue() external view returns (int104) {
        return cacheStorage.currentValue();
    }

    function getValueForRefSlot(uint256 slot) external view returns (int104) {
        return cacheStorage.getValueForRefSlot(uint48(slot));
    }

    function rawCache()
        external view
        returns (DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory)
    {
        return cacheStorage;
    }

    // IHashConsensus shim
    function getCurrentFrame() external view returns (uint256, uint256) {
        return (refSlot, refSlot + 1);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────────────

contract RefSlotCacheExtHandler is CommonBase, StdCheats, StdUtils {
    RefSlotCacheHarness public harness;

    // Ghost: net sum of all deltas applied since last slot change
    int256  public ghost_netDelta;
    // Ghost: value captured at slot boundary (value just before the first update on the new slot)
    int104  public ghost_valueAtLastSlotChange;
    // Ghost: whether at least one delta was applied on the current slot
    bool    public ghost_dirtyThisSlot;
    // Ghost: cumulative value (must always equal currentValue())
    int256  public ghost_cumulativeValue;

    constructor(RefSlotCacheHarness _harness) {
        harness = _harness;
    }

    // ── Handler: advance slot by 1 ────────────────────────────────────────────
    function handler_advanceOne() external {
        // Capture current value BEFORE slot advance (it will become the "checkpoint")
        // Note: slot advances do NOT call withValueIncrease, so the cache doesn't
        // update until the next applyDelta.
        ghost_dirtyThisSlot = false;
        harness.advanceSlotByOne();
    }

    // ── Handler: advance slot by N (1-16) ────────────────────────────────────
    function handler_advanceN(uint8 n) external {
        n = uint8(bound(uint256(n), 1, 16));
        ghost_dirtyThisSlot = false;
        harness.advanceSlotByN(n);
    }

    // ── Handler: apply a positive delta ──────────────────────────────────────
    function handler_applyPositiveDelta(uint8 rawAmount) external {
        int104 delta = int104(int256(bound(uint256(rawAmount), 1, 100))) * 1e15;  // in gwei-sized units
        _applyDelta(delta);
    }

    // ── Handler: apply a negative delta ──────────────────────────────────────
    function handler_applyNegativeDelta(uint8 rawAmount) external {
        int104 delta = -(int104(int256(bound(uint256(rawAmount), 1, 100))) * 1e15);
        _applyDelta(delta);
    }

    // ─────────────────────────────────────────────────────────────────────────

    function _applyDelta(int104 delta) internal {
        // Capture boundary checkpoint on first update of the new slot
        if (!ghost_dirtyThisSlot) {
            ghost_valueAtLastSlotChange = harness.currentValue();
            ghost_dirtyThisSlot = true;
        }
        harness.applyDelta(delta);
        ghost_cumulativeValue += int256(delta);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Invariant test
// ──────────────────────────────────────────────────────────────────────────────

contract RefSlotCacheExtInvariantTest is Test {
    RefSlotCacheHarness      harness;
    RefSlotCacheExtHandler   handler;

    function setUp() public {
        harness = new RefSlotCacheHarness();
        handler = new RefSlotCacheExtHandler(harness);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = RefSlotCacheExtHandler.handler_advanceOne.selector;
        selectors[1] = RefSlotCacheExtHandler.handler_advanceN.selector;
        selectors[2] = RefSlotCacheExtHandler.handler_applyPositiveDelta.selector;
        selectors[3] = RefSlotCacheExtHandler.handler_applyNegativeDelta.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ── INV-1: active.refSlot >= prev.refSlot ────────────────────────────────
    /**
     * @notice  The "active" buffer must always hold the latest refSlot.
     *          If inverted, _activeCacheIndex picks the wrong buffer and all
     *          subsequent reads return stale or incorrect data.
     *
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     */
    function invariant_activeRefSlotGeqPrev() external view {
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory cache = harness.rawCache();
        uint256 activeIdx = cache[0].refSlot >= cache[1].refSlot ? 0 : 1;
        uint256 prevIdx   = 1 - activeIdx;
        assertGe(
            uint256(cache[activeIdx].refSlot),
            uint256(cache[prevIdx].refSlot),
            "INV-1 violated: active slot < previous slot"
        );
    }

    // ── INV-2: future-slot query returns currentValue() ──────────────────────
    /**
     * @notice  Any query for a refSlot STRICTLY GREATER than the active refSlot
     *          must return the current accumulated value.
     *          Violated if a future query accidentally reads a stale snapshot.
     *
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     */
    function invariant_futureSlotReturnsCurrent() external view {
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory cache = harness.rawCache();
        uint256 activeIdx   = cache[0].refSlot >= cache[1].refSlot ? 0 : 1;
        uint256 activeSlot  = uint256(cache[activeIdx].refSlot);
        uint256 futureSlot  = activeSlot + 1;

        int104 expected = harness.currentValue();
        int104 actual   = harness.getValueForRefSlot(futureSlot);
        assertEq(actual, expected, "INV-2 violated: getValueForRefSlot(future) != currentValue()");
    }

    // ── INV-3: prev-slot query returns prev.valueOnRefSlot ───────────────────
    /**
     * @notice  Querying exactly the PREVIOUS buffer's refSlot must return that
     *          buffer's `valueOnRefSlot` (the checkpoint written when the slot
     *          was first activated).
     *          Violated if the checkpoint is overwritten or the wrong buffer
     *          lookup is used.
     *
     * Skip when prevRefSlot == activeRefSlot (startup, both buffers at slot 0).
     *
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     */
    function invariant_prevSlotReturnsCheckpoint() external view {
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory cache = harness.rawCache();
        uint256 activeIdx   = cache[0].refSlot >= cache[1].refSlot ? 0 : 1;
        uint256 prevIdx     = 1 - activeIdx;

        // Only meaningful once the two slots have diverged
        if (cache[activeIdx].refSlot == cache[prevIdx].refSlot) return;

        int104 expected = cache[prevIdx].valueOnRefSlot;
        int104 actual   = harness.getValueForRefSlot(cache[prevIdx].refSlot);
        assertEq(actual, expected, "INV-3 violated: getValueForRefSlot(prevSlot) != prevCache.valueOnRefSlot");
    }

    // ── INV-4: too-old refSlot query always reverts ──────────────────────────
    /**
     * @notice  Any query for a refSlot strictly older than prevRefSlot must
     *          revert with InOutDeltaCacheIsOverwritten (the data was evicted).
     *          Violated if the library silently returns a garbage value instead.
     *
     * Skip when prevRefSlot == 0 (cache not yet used / both at genesis).
     *
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     */
    function invariant_tooOldQueryReverts() external {
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory cache = harness.rawCache();
        uint256 activeIdx   = cache[0].refSlot >= cache[1].refSlot ? 0 : 1;
        uint256 prevIdx     = 1 - activeIdx;
        uint256 prevSlot    = uint256(cache[prevIdx].refSlot);

        // Only testable once both buffers have been written to (prevSlot > 0)
        if (prevSlot == 0) return;

        // Query one slot BEFORE prevSlot — must revert
        uint256 tooOldSlot = prevSlot - 1;
        try harness.getValueForRefSlot(tooOldSlot) returns (int104) {
            // Should not reach here
            assertTrue(false, "INV-4 violated: too-old slot query did not revert");
        } catch {
            // Expected: InOutDeltaCacheIsOverwritten()
        }
    }

    // ── INV-5: cumulative ghost matches on-chain currentValue() ──────────────
    /**
     * @notice  The sum of all deltas applied since genesis should equal
     *          currentValue().  Violated if withValueIncrease loses or
     *          double-counts a delta during a slot transition.
     *
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     */
    function invariant_cumulativeDeltaMatchesCurrent() external view {
        int104 current = harness.currentValue();
        assertEq(
            int256(current),
            handler.ghost_cumulativeValue(),
            "INV-5 violated: ghost cumulative delta != currentValue()"
        );
    }
}
