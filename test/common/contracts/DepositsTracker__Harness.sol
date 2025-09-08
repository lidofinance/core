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
    function pack(uint64 slot, uint128 amount) external pure returns (uint256) {
        return SlotDepositPacking.pack(SlotDeposit(slot, amount));
    }

    function unpack(uint256 value) external pure returns (SlotDeposit memory slotDeposit) {
        return SlotDepositPacking.unpack(value);
    }
}

contract DepositsTracker__Harness {
    using SlotDepositPacking for SlotDeposit;
    using SlotDepositPacking for uint256;

    // Dedicated storage position for tests
    bytes32 public constant TEST_POSITION = keccak256("deposits.tracker.test.position");

    // Expose the library functions
    function insertSlotDeposit(uint256 slot, uint256 amount) external {
        DepositsTracker.insertSlotDeposit(TEST_POSITION, slot, amount);
    }

    function getDepositedEth(uint256 slot) external returns (uint256) {
        return DepositsTracker.getDepositedEth(TEST_POSITION, slot);
    }

    function getIndexOfLastRead() external view returns (uint256) {
        return _getDataStorage(TEST_POSITION).indexOfLastRead;
    }
    // helpers

    function getTotalAmount() external view returns (uint256 total) {
        return _getDataStorage(TEST_POSITION).totalAmount;
    }

    function getSlotsDepositsRaw() external view returns (uint256[] memory arr) {
        return _getDataStorage(TEST_POSITION).slotsDeposits;
    }

    function getSlotsDepositsUnpacked() external view returns (uint64[] memory slots, uint128[] memory amounts) {
        DepositedEthState storage s = _getDataStorage(TEST_POSITION);
        uint256 len = s.slotsDeposits.length;
        slots = new uint64[](len);
        amounts = new uint128[](len);
        for (uint256 i = 0; i < len; ) {
            SlotDeposit memory d = s.slotsDeposits[i].unpack();
            slots[i] = d.slot;
            amounts[i] = d.depositedEth;
            unchecked {
                ++i;
            }
        }
    }

    // Internal reader to the same storage slot
    // function _readState() private view returns (DepositedEthState storage s, uint256 total, uint256[] storage arr) {
    //     bytes32 pos = TEST_POSITION;
    //     assembly {
    //         s.slot := pos
    //     }
    //     return (s, s.totalAmount, s.slotsDeposits);
    // }

    function _getDataStorage(bytes32 _position) private pure returns (DepositedEthState storage $) {
        assembly {
            $.slot := _position
        }
    }
}
