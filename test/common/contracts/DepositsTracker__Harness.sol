// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.25;

import {
    DepositedEthState,
    SlotDeposit,
    SlotDepositPacking,
    DepositsTracker
} from "contracts/common/lib/DepositsTracker.sol";

contract SlotDepositPacking__Harness {
    function pack(uint64 slot, uint192 cumulative) external pure returns (uint256) {
        return SlotDepositPacking.pack(SlotDeposit(slot, cumulative));
    }

    function unpack(uint256 value) external pure returns (SlotDeposit memory slotDeposit) {
        return SlotDepositPacking.unpack(value);
    }
}

contract DepositsTracker__Harness {
    using SlotDepositPacking for SlotDeposit;
    using SlotDepositPacking for uint256;

    bytes32 public constant TEST_POSITION = keccak256("deposits.tracker.test.position");

    function insertSlotDeposit(uint256 slot, uint256 amount) external {
        DepositsTracker.insertSlotDeposit(TEST_POSITION, slot, amount);
    }

    function getDepositedEthUpToSlot(uint256 slot) external view returns (uint256) {
        return DepositsTracker.getDepositedEthUpToSlot(TEST_POSITION, slot);
    }

    function getDepositedEthUpToLastSlot() external view returns (uint256) {
        return DepositsTracker.getDepositedEthUpToLastSlot(TEST_POSITION);
    }

    function moveCursorToSlot(uint256 slot) external {
        DepositsTracker.moveCursorToSlot(TEST_POSITION, slot);
    }

    function moveCursorToLastSlot() external {
        DepositsTracker.moveCursorToLastSlot(TEST_POSITION);
    }

    // === Helpers for assertions ===
    function getCursor() external view returns (uint256) {
        return _getDataStorage(TEST_POSITION).cursor;
    }

    function getSlotsDepositsRaw() external view returns (uint256[] memory arr) {
        return _getDataStorage(TEST_POSITION).slotsDeposits;
    }

    function getSlotsDepositsUnpacked() external view returns (uint64[] memory slots, uint192[] memory cumulatives) {
        DepositedEthState storage s = _getDataStorage(TEST_POSITION);
        uint256 len = s.slotsDeposits.length;
        slots = new uint64[](len);
        cumulatives = new uint192[](len);
        for (uint256 i = 0; i < len; ) {
            SlotDeposit memory d = s.slotsDeposits[i].unpack();
            slots[i] = d.slot;
            cumulatives[i] = d.cumulativeEth;
            unchecked {
                ++i;
            }
        }
    }

    function _getDataStorage(bytes32 _position) private pure returns (DepositedEthState storage $) {
        assembly {
            $.slot := _position
        }
    }
}
