// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.25;

/**
 * @title  TriggerableWithdrawals Input-Validation Fuzz Suite
 * @notice Local-only Foundry fuzz/property tests for the TriggerableWithdrawals library.
 *
 *  The library drives EIP-7002 exit/withdrawal requests.  The fuzz campaign covers
 *  all input-validation paths that guard execution *before* the external precompile
 *  call, plus full happy-path coverage via a mock of the 0x00000961 precompile.
 *
 *  Properties verified:
 *
 *  TW-1  Malformed pubkeys (length % 48 != 0) always reverts with MalformedPubkeysArray
 *
 *  TW-2  Empty pubkeys always reverts with NoWithdrawalRequests
 *
 *  TW-3  addWithdrawalRequests: keysCount != amounts.length reverts with MismatchedArrayLengths
 *
 *  TW-4  addPartialWithdrawalRequests: any amounts[i] == 0 reverts with PartialWithdrawalRequired(i)
 *
 *  TW-5  getWithdrawalRequestFee: returns the value reported by the precompile (mock)
 *
 *  TW-6  addFullWithdrawalRequests: succeeds for valid n*48-byte pubkeys (mock)
 *
 *  TW-7  addPartialWithdrawalRequests: succeeds when all amounts > 0 (mock)
 *
 *  TW-8  _validateAndCountPubkeys: keysCount == pubkeys.length / 48 (indirectly verified
 *        through mismatched-lengths revert message and happy path)
 */

import {Test} from "forge-std/Test.sol";
import {TriggerableWithdrawals} from "contracts/common/lib/TriggerableWithdrawals.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Harness — exposes internal library functions as external so tests can call them
// ─────────────────────────────────────────────────────────────────────────────

contract TriggerableWithdrawalsHarness {
    function addFullWithdrawal(bytes calldata pubkeys, uint256 fee)
        external payable
    {
        TriggerableWithdrawals.addFullWithdrawalRequests(pubkeys, fee);
    }

    function addPartialWithdrawal(
        bytes calldata pubkeys,
        uint64[] calldata amounts,
        uint256 fee
    ) external payable {
        TriggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, fee);
    }

    function addWithdrawal(
        bytes calldata pubkeys,
        uint64[] calldata amounts,
        uint256 fee
    ) external payable {
        TriggerableWithdrawals.addWithdrawalRequests(pubkeys, amounts, fee);
    }

    function getFee() external view returns (uint256) {
        return TriggerableWithdrawals.getWithdrawalRequestFee();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock precompile — sits at the EIP-7002 address in local tests
//
//  Protocol:
//    staticcall("")             → returns abi.encoded fee (32 bytes)
//    call{value}(56-byte cdata) → succeeds, no return data
// ─────────────────────────────────────────────────────────────────────────────

contract MockTW7002Precompile {
    uint256 public fee;

    constructor(uint256 _fee) { fee = _fee; }

    fallback() external payable {
        if (msg.data.length == 0) {
            // Fee query via staticcall
            uint256 f = fee;
            assembly { mstore(0x00, f) return(0x00, 0x20) }
        }
        // Withdrawal submission — accept and succeed silently
    }
}

// ─────────────────────────────────────────────────────────────────────────────

contract TriggerableWithdrawalsFuzzTest is Test {
    /// EIP-7002 precompile address (constant from the library source)
    address constant PRECOMPILE = 0x00000961Ef480Eb55e80D19ad83579A64c007002;

    TriggerableWithdrawalsHarness harness;
    MockTW7002Precompile          mock;

    uint256 constant MOCK_FEE = 1000; // 1000 wei per request in the mock

    function setUp() external {
        harness = new TriggerableWithdrawalsHarness();
        mock    = new MockTW7002Precompile(MOCK_FEE);
        // Plant the mock at the EIP-7002 precompile address
        vm.etch(PRECOMPILE, address(mock).code);
        // The mock contract's state (fee storage) is separate from the etch'd code,
        // so we write the fee directly into the precompile address's storage slot 0.
        vm.store(PRECOMPILE, bytes32(uint256(0)), bytes32(MOCK_FEE));
    }

    // ── TW-1: malformed pubkeys always revert ────────────────────────────────

    /**
     * @notice  Any pubkeys byte array whose length is not a multiple of 48 must revert.
     *          This guards against accidental key-boundary misalignment.
     */
    function testFuzz_malformedPubkeys_reverts(
        bytes calldata pubkeys
    ) external {
        vm.assume(pubkeys.length % 48 != 0);
        // Validation reverts before any ETH is transferred — pass value 0
        vm.expectRevert(TriggerableWithdrawals.MalformedPubkeysArray.selector);
        harness.addFullWithdrawal(pubkeys, 0);
    }

    function testFuzz_malformedPubkeys_partial_reverts(
        bytes calldata pubkeys,
        uint64[] calldata amounts
    ) external {
        vm.assume(pubkeys.length % 48 != 0);
        // Validation reverts before any ETH is transferred — pass value 0
        vm.expectRevert(TriggerableWithdrawals.MalformedPubkeysArray.selector);
        harness.addWithdrawal(pubkeys, amounts, 0);
    }

    // ── TW-2: empty pubkeys always revert ───────────────────────────────────

    /**
     * @notice  A zero-length (or length-0) pubkeys array must revert with NoWithdrawalRequests.
     */
    function test_emptyPubkeys_reverts() external {
        vm.expectRevert(TriggerableWithdrawals.NoWithdrawalRequests.selector);
        harness.addFullWithdrawal(hex"", 1000);
    }

    function test_emptyPubkeys_withdrawal_reverts() external {
        uint64[] memory amounts = new uint64[](0);
        vm.expectRevert(TriggerableWithdrawals.NoWithdrawalRequests.selector);
        harness.addWithdrawal(hex"", amounts, 1000);
    }

    // ── TW-3: array length mismatch reverts ─────────────────────────────────

    /**
     * @notice  addWithdrawalRequests(pubkeys, amounts) where keysCount != amounts.length
     *          must revert with MismatchedArrayLengths.
     *          keysCount = pubkeys.length / 48.
     */
    function testFuzz_arrayLengthMismatch_reverts(
        uint8  rawKeyCount,
        uint8  rawAmountCount
    ) external {
        uint256 keyCount    = bound(uint256(rawKeyCount),    1, 8);
        uint256 amountCount = bound(uint256(rawAmountCount), 0, 8);
        vm.assume(keyCount != amountCount);

        // Build valid pubkeys (n * 48 zero bytes)
        bytes memory pubkeys = new bytes(keyCount * 48);
        uint64[] memory amounts = new uint64[](amountCount);

        // Validation reverts before any ETH is transferred — fee=0, no value
        vm.expectRevert(
            abi.encodeWithSelector(
                TriggerableWithdrawals.MismatchedArrayLengths.selector,
                keyCount,
                amountCount
            )
        );
        harness.addWithdrawal(pubkeys, amounts, 0);
    }

    // ── TW-4: zero amount in partial withdrawal reverts ──────────────────────

    /**
     * @notice  addPartialWithdrawalRequests with any amounts[i] == 0 must revert
     *          with PartialWithdrawalRequired(i).
     *          A zero amount means "full withdrawal" which is not allowed in the partial path.
     */
    function testFuzz_zeroAmountInPartial_reverts(
        uint8 rawKeyCount,
        uint8 rawZeroIndex
    ) external {
        uint256 n      = bound(uint256(rawKeyCount), 1, 8);
        uint256 zeroAt = bound(uint256(rawZeroIndex), 0, n - 1);

        bytes  memory pubkeys   = new bytes(n * 48);
        uint64[] memory amounts = new uint64[](n);

        // Fill all non-zero, then zero out one
        for (uint256 i = 0; i < n; i++) amounts[i] = 100;
        amounts[zeroAt] = 0;

        // Validation reverts before any ETH is transferred — fee=0, no value
        vm.expectRevert(
            abi.encodeWithSelector(
                TriggerableWithdrawals.PartialWithdrawalRequired.selector,
                zeroAt
            )
        );
        harness.addPartialWithdrawal(pubkeys, amounts, 0);
    }

    // ── TW-5: getWithdrawalRequestFee reads mock fee ─────────────────────────

    /**
     * @notice  getWithdrawalRequestFee() must return what the precompile reports.
     *          With our mock, this should always be MOCK_FEE.
     */
    function test_getFee_returnsMockValue() external view {
        uint256 fee = harness.getFee();
        assertEq(fee, MOCK_FEE, "TW-5: fee must match mock precompile value");
    }

    // ── TW-6: addFullWithdrawalRequests happy path ───────────────────────────

    /**
     * @notice  Valid n*48-byte pubkeys with sufficient value succeeds with the mock.
     */
    function testFuzz_fullWithdrawal_happyPath(uint8 rawKeyCount) external {
        uint256 n = bound(uint256(rawKeyCount), 1, 8);
        bytes memory pubkeys = new bytes(n * 48);
        uint256 totalFee = MOCK_FEE * n;

        // Fund the harness and call
        vm.deal(address(this), totalFee + 1 ether);
        harness.addFullWithdrawal{value: totalFee}(pubkeys, MOCK_FEE);
        // No revert means success
    }

    // ── TW-7: addPartialWithdrawalRequests happy path ────────────────────────

    /**
     * @notice  Valid pubkeys + non-zero amounts + sufficient fee succeeds with mock.
     */
    function testFuzz_partialWithdrawal_happyPath(
        uint8   rawKeyCount,
        uint64  rawAmount
    ) external {
        uint256 n      = bound(uint256(rawKeyCount), 1, 8);
        uint64  amount = uint64(bound(uint256(rawAmount), 1, type(uint64).max));

        bytes   memory pubkeys  = new bytes(n * 48);
        uint64[] memory amounts = new uint64[](n);
        for (uint256 i = 0; i < n; i++) amounts[i] = amount;

        uint256 totalFee = MOCK_FEE * n;
        vm.deal(address(this), totalFee + 1 ether);
        harness.addPartialWithdrawal{value: totalFee}(pubkeys, amounts, MOCK_FEE);
        // No revert means success
    }

    // ── TW-8: keysCount == pubkeys.length / 48 (indirectly via mismatch) ─────

    /**
     * @notice  The mismatch revert message encodes the actual keysCount derived from
     *          pubkeys.length / 48.  This verifies the counting logic is correct.
     */
    function testFuzz_keyCount_derivedFromLength(uint8 rawN) external {
        uint256 n = bound(uint256(rawN), 1, 20);
        bytes memory pubkeys    = new bytes(n * 48);
        uint64[] memory amounts = new uint64[](0); // intentional mismatch

        // Validation reverts before any ETH is transferred
        vm.expectRevert(
            abi.encodeWithSelector(
                TriggerableWithdrawals.MismatchedArrayLengths.selector,
                n,
                0
            )
        );
        harness.addWithdrawal(pubkeys, amounts, 0);
    }
}
