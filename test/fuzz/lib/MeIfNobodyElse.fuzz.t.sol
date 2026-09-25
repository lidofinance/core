// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.25;

/**
 * @title  MeIfNobodyElse Fuzz Suite
 * @notice Local-only Foundry fuzz/property tests for the MeIfNobodyElse mapping library.
 *         This library is used by PredepositGuarantee to manage validator fee recipients
 *         with an identity default (return the key itself when no override is set).
 *
 *  Properties verified:
 *
 *  MINE-1  Default: fresh mapping always returns the key itself
 *          getValueOrKey(fresh, key) == key
 *
 *  MINE-2  Set: after setOrReset(key, value) where value != key, getValueOrKey returns value
 *
 *  MINE-3  Self-set resets to default: setOrReset(key, key) → getValueOrKey(key) == key
 *
 *  MINE-4  Zero-value-set acts as delete: setOrReset(key, 0) → getValueOrKey(key) == key
 *          (only meaningful when key != address(0))
 *
 *  MINE-5  Overwrite: set(key, v1) then set(key, v2 != key) → getValueOrKey(key) == v2
 *
 *  MINE-6  Roundtrip: set(key, v) then reset(key) → getValueOrKey(key) == key
 *
 *  MINE-7  Different keys are independent: set(k1, v) does not affect getValueOrKey(k2)
 *          when k1 != k2
 */

import {Test} from "forge-std/Test.sol";
import {MeIfNobodyElse} from
    "contracts/0.8.25/vaults/predeposit_guarantee/MeIfNobodyElse.sol";

contract MeIfNobodyElseFuzzTest is Test {
    using MeIfNobodyElse for mapping(address => address);

    mapping(address => address) internal _map;

    // ── MINE-1: default returns key ───────────────────────────────────────────

    /**
     * @notice  On an un-touched mapping, getValueOrKey(key) is always key.
     *          Broken default would silently redirect fee recipients to address(0).
     */
    function testFuzz_default_returnsKey(address key) external view {
        assertEq(_map.getValueOrKey(key), key, "MINE-1: default must return key");
    }

    // ── MINE-2: set stores and retrieves the value ────────────────────────────

    /**
     * @notice  After setOrReset(key, value) where value != key AND value != address(0),
     *          getValueOrKey must return value.
     *
     *  IMPORTANT: address(0) is the internal "unset" sentinel — it cannot be stored as a
     *  real override value.  Calling setOrReset(key, address(0)) silently clears the slot
     *  and causes getValueOrKey to fall back to returning key.  See MINE-2b.
     */
    function testFuzz_set_storesValue(address key, address value) external {
        vm.assume(value != key);
        vm.assume(value != address(0)); // address(0) is the "unset" sentinel — cannot store it
        _map.setOrReset(key, value);
        assertEq(_map.getValueOrKey(key), value, "MINE-2: stored value must be returned");
    }

    /**
     * @notice  MINE-2b — address(0) sentinel: setOrReset(key, address(0)) where key != 0
     *          acts as a silent clear.  getValueOrKey then returns key, NOT address(0).
     *          This means it is impossible to configure address(0) as a fee-recipient override.
     */
    function testFuzz_set_zero_isSentinel(address key) external {
        vm.assume(key != address(0)); // skip the degenerate key==0 case
        // prime with a non-zero value first
        address dummy = address(uint160(uint256(keccak256(abi.encode(key)))));
        if (dummy == key || dummy == address(0)) return;
        _map.setOrReset(key, dummy);

        // then write address(0) — should clear, not store
        _map.setOrReset(key, address(0));
        assertEq(_map.getValueOrKey(key), key,
            "MINE-2b: setOrReset(key,0) must clear to default, not store zero");
    }

    // ── MINE-3: self-set is a no-op (resets to default) ──────────────────────

    /**
     * @notice  Setting a key to itself must be equivalent to clearing it.
     *          The internal representation uses address(0) for cleared entries.
     */
    function testFuzz_selfSet_isReset(address key) external {
        _map.setOrReset(key, key);
        assertEq(_map.getValueOrKey(key), key, "MINE-3: self-set must return key (reset to default)");
    }

    // ── MINE-4: zero-value set acts as delete ─────────────────────────────────

    /**
     * @notice  Storing address(0) as the value clears the slot → getValueOrKey
     *          falls back to returning key.  This is the "delete" path.
     *          Edge: only meaningful when key != address(0); when key IS zero,
     *          getValueOrKey always returns zero regardless.
     */
    function testFuzz_setZero_clearsSlot(address key) external {
        // First store a non-zero, non-self value
        address dummy = address(uint160(key) ^ 1);
        if (dummy == key || dummy == address(0)) return; // skip degenerate inputs
        _map.setOrReset(key, dummy);

        // Then clear by storing zero
        _map.setOrReset(key, address(0));

        // getValueOrKey must now fall back to key
        assertEq(_map.getValueOrKey(key), key, "MINE-4: setting zero must clear slot");
    }

    // ── MINE-5: overwrite updates the stored value ────────────────────────────

    /**
     * @notice  Writing two different non-zero non-self values to the same key — the second write wins.
     *          Both values must differ from key and from address(0) (the sentinel).
     */
    function testFuzz_overwrite_latestValueWins(
        address key,
        address v1,
        address v2
    ) external {
        vm.assume(v1 != key);
        vm.assume(v2 != key);
        vm.assume(v1 != v2);
        vm.assume(v1 != address(0)); // address(0) is the unset sentinel
        vm.assume(v2 != address(0));

        _map.setOrReset(key, v1);
        _map.setOrReset(key, v2);

        assertEq(_map.getValueOrKey(key), v2, "MINE-5: overwrite must store the new value");
    }

    // ── MINE-6: set then reset roundtrip ─────────────────────────────────────

    /**
     * @notice  Set a value, then reset (self-set).  Must return to factory default.
     */
    function testFuzz_setThenReset_roundtrip(address key, address value) external {
        vm.assume(value != key);
        _map.setOrReset(key, value);     // set
        _map.setOrReset(key, key);       // reset via self-set
        assertEq(_map.getValueOrKey(key), key, "MINE-6: roundtrip must restore default");
    }

    // ── MINE-7: different keys are independent ────────────────────────────────

    /**
     * @notice  Writing to key k1 must not affect key k2 when they differ.
     */
    function testFuzz_isolation_betweenKeys(
        address k1,
        address k2,
        address value
    ) external {
        vm.assume(k1 != k2);
        vm.assume(value != k1);

        _map.setOrReset(k1, value);

        // k2 was never written — must still return k2 as default
        assertEq(_map.getValueOrKey(k2), k2, "MINE-7: set on k1 must not affect k2");
    }
}
