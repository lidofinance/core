// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line
pragma solidity >=0.8.9 <0.9.0;

import {DepositedState} from "contracts/common/interfaces/DepositedState.sol";


/// @notice Deposit in slot
struct SlotDeposit {
    /// Ethereum slot
    uint64 slot;
    /// cumulative sum up to and including this slot
    uint192 cumulativeEth;
}

library SlotDepositPacking {
    function pack(uint64 slot, uint192 cumulativeEth) internal pure returns (uint256) {
        return (uint256(slot) << 192) | uint256(cumulativeEth);
    }

    function unpack(uint256 value) internal pure returns (uint64 slot, uint192 cumulativeEth) {
        slot = uint64(value >> 192);
        cumulativeEth = uint192(value);
    }
}

/// @notice library for tracking deposits for some period of time
library DepositsTracker {
    using SlotDepositPacking for uint256;

    error SlotOutOfOrder();
    error SlotTooLarge(uint256 slot);
    error DepositAmountTooLarge(uint256 depositAmount);
    error ZeroValue(string depositAmount);
    error SlotOutOfRange();

    /// @notice Add new deposit information in deposit state
    ///
    /// @param state - deposited wei state
    /// @param currentSlot - slot of deposit // Maybe it is more secure to calculate current slot in this method
    /// @param depositAmount - Eth deposit amount
    function insertSlotDeposit(DepositedState storage state, uint256 currentSlot, uint256 depositAmount) internal {
        if (currentSlot > type(uint64).max) revert SlotTooLarge(currentSlot);
        if (depositAmount > type(uint128).max) revert DepositAmountTooLarge(depositAmount);
        if (depositAmount == 0) revert ZeroValue("depositAmount");

        // DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);

        uint256 depositsEntryAmount = state.slotsDeposits.length;

        if (depositsEntryAmount == 0) {
            state.slotsDeposits.push( SlotDepositPacking.pack(uint64(currentSlot), uint192(depositAmount)));
            return;
        }

        // last deposit
        (uint64 lastDepositSlot, uint192 lastDepositCumulativeEth) = state.slotsDeposits[depositsEntryAmount - 1].unpack();

        // if last tracked deposit's slot newer than currentSlot, than such attempt should be reverted
        if (lastDepositSlot > currentSlot) {
            revert SlotOutOfOrder();
        }

        // if it is the same block, increase amount
        if (lastDepositSlot == currentSlot) {
            lastDepositCumulativeEth += uint192(depositAmount);
            state.slotsDeposits[depositsEntryAmount - 1] = SlotDepositPacking.pack(lastDepositSlot, lastDepositCumulativeEth);
            return;
        }

        state.slotsDeposits.push(
            SlotDepositPacking.pack(uint64(currentSlot), lastDepositCumulativeEth + uint192(depositAmount))
        );
    }

    /// @notice Return the total ETH deposited before slot, inclusive slot
    ///
    /// @param state - deposited wei state
    /// @param _slot - Upper bound slot
    /// @dev this method will use cursor for start reading data
    function getDepositedEthUpToSlot(DepositedState storage state, uint256 _slot)
        internal
        view
        returns (uint256 total)
    {
        // DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);
        uint256 depositsEntryAmount = state.slotsDeposits.length;
        if (depositsEntryAmount == 0) return 0;
        // data in tracker was already read
        if (state.cursor == depositsEntryAmount) return 0;

        // define cursor start
        uint256 startIndex = state.cursor;
        // SlotDeposit memory startDeposit = state.slotsDeposits[state.cursor].unpack();

        (uint64 startDepositSlot, ) = state.slotsDeposits[state.cursor].unpack();
        // TODO: maybe error should be LessThanCursorValue or smth
        if (startDepositSlot > _slot) revert SlotOutOfRange();

        uint256 endIndex = type(uint256).max;
        for (uint256 i = startIndex; i < depositsEntryAmount;) {
            // SlotDeposit memory d = state.slotsDeposits[i].unpack();
            (uint64 slot, ) = state.slotsDeposits[i].unpack();
            if (slot > _slot) break;

            endIndex = i;
            unchecked {
                ++i;
            }
        }
        (,uint192 endCumulativeEth) = state.slotsDeposits[endIndex].unpack();

        if (startIndex == 0) {
            return endCumulativeEth;
        }

        (,uint192 lastCumulativeEth) = state.slotsDeposits[startIndex - 1].unpack();
        return endCumulativeEth - lastCumulativeEth;
    }

    /// @notice Return the total ETH deposited since slot that correspondence to cursor to last slot in tracker
    ///
    /// @param state - deposited wei state
    /// @dev this method will use cursor for start reading data
    function getDepositedEthUpToLastSlot(DepositedState storage state) internal view returns (uint256 total) {
        // DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);
        uint256 depositsEntryAmount = state.slotsDeposits.length;
        if (depositsEntryAmount == 0) return 0;
        // data in tracker was already read
        if (state.cursor == depositsEntryAmount) return 0;

        (, uint192 endSlotCumulativeEth) = state.slotsDeposits[depositsEntryAmount - 1].unpack();

        if (state.cursor == 0) {
            return endSlotCumulativeEth;
        }

        (, uint192 startSlotCumulativeEth) = state.slotsDeposits[state.cursor - 1].unpack();
        return endSlotCumulativeEth - startSlotCumulativeEth;
    }

    /// @notice Move cursor to next slot after provided
    /// @param state - deposited wei state
    /// @param _slot - Upper bound slot
    /// @dev Rules:
    ///      - Cursor only moves to the right;
    ///      - _slot must be >= slot at current cursor;
    ///      - Search only in the suffix (cursor, len);
    ///      - Find index of first element that higher than _slot;
    ///      - max value that can have cursor is depositsEntryAmount
    ///      - Method will revert only if _slot is less than cursor slot, as if there are no entries in tracker > _slot we think everything was read and set cursor to length of slotsDeposits
    function moveCursorToSlot(DepositedState storage state, uint256 _slot) internal {
        if (_slot > type(uint64).max) revert SlotTooLarge(_slot);

        // DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);
        uint256 depositsEntryAmount = state.slotsDeposits.length;
        if (depositsEntryAmount == 0) return;

        // SlotDeposit memory lastSlot = state.slotsDeposits[depositsEntryAmount - 1].unpack();
        (uint64 lastDepositSlot,) = state.slotsDeposits[depositsEntryAmount - 1].unpack();


        if (_slot >= lastDepositSlot) {
            state.cursor = depositsEntryAmount;
            return;
        }

        if (state.cursor == depositsEntryAmount) return;
        // SlotDeposit memory cursorSlot = state.slotsDeposits[state.cursor].unpack();
         (uint64 cursorSlot, ) = state.slotsDeposits[state.cursor].unpack();


        if (_slot < cursorSlot) revert SlotOutOfOrder();

        if (cursorSlot == _slot) {
            state.cursor = state.cursor + 1;
            return;
        }

        uint256 startIndex = state.cursor + 1;

        for (uint256 i = startIndex; i < depositsEntryAmount;) {
            (uint64 slot, ) = state.slotsDeposits[i].unpack();
            if (slot > _slot) {
                state.cursor = i;
                break;
            }

            unchecked {
                ++i;
            }
        }
    }

    // function moveCursorToLastSlot(DepositedState storage state) public {
    //     // DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);
    //     uint256 depositsEntryAmount = state.slotsDeposits.length;
    //     // here cursor will have default value
    //     if (depositsEntryAmount == 0) return;
    //     // everything was read
    //     state.cursor = depositsEntryAmount;
    // }

    // function _getDataStorage(bytes32 _position) private pure returns (DepositedEthState storage $) {
    //     assembly {
    //         $.slot := _position
    //     }
    // }
}
