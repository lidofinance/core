// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.25;

import {
    SlotDeposit,
    SlotDepositPacking,
    DepositsTracker
} from "contracts/common/lib/DepositsTracker.sol";
import {DepositedState} from "contracts/common/interfaces/DepositedState.sol";

contract SlotDepositPacking__Harness {
    function pack(uint64 slot, uint192 cumulative) external pure returns (uint256) {
        return SlotDepositPacking.pack(slot, cumulative);
    }

    function unpack(uint256 value) external pure returns (uint64 slot, uint192 cumulative) {
        return SlotDepositPacking.unpack(value);
    }
}

contract DepositsTracker__Harness {
    using SlotDepositPacking for SlotDeposit;
    using SlotDepositPacking for uint256;

    DepositedState private S;


    // bytes32 public constant TEST_POSITION = keccak256("deposits.tracker.test.position");

    function insertSlotDeposit(uint256 slot, uint256 amount) external {
        DepositsTracker.insertSlotDeposit(S, slot, amount);
    }

   function getDepositedEthUpToSlot(uint256 slot) external view returns (uint256) {
        return DepositsTracker.getDepositedEthUpToSlot(S, slot);
    }

    function getDepositedEthUpToLastSlot() external view returns (uint256) {
        return DepositsTracker.getDepositedEthUpToLastSlot(S);
    }

    function moveCursorToSlot(uint256 slot) external {
        DepositsTracker.moveCursorToSlot(S, slot);
    }

    // function moveCursorToLastSlot() external {
    //     DepositsTracker.moveCursorToLastSlot(TEST_POSITION);
    // }

    // === Helpers for assertions ===
    function getCursor() external view returns (uint256) {
        return S.cursor;
    }

    function getSlotsDepositsRaw() external view returns (uint256[] memory arr) {
        return S.slotsDeposits;
    }

    function getSlotsDepositsUnpacked() external view returns (uint64[] memory slots, uint192[] memory cumulatives) {
        uint256 len = S.slotsDeposits.length;
        slots = new uint64[](len);
        cumulatives = new uint192[](len);
        for (uint256 i = 0; i < len; ) {
            (uint64 slot_, uint192 cum_) = SlotDepositPacking.unpack(S.slotsDeposits[i]);
            slots[i] = slot_;
            cumulatives[i] = cum_;
            unchecked { ++i; }
        }
    }
}
