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

    /// @notice Add new deposit information in deposit state
    ///
    /// @param state - deposited wei state
    /// @param currentSlot - slot of deposit
    /// @param depositAmount - Eth deposit amount
    function insertSlotDeposit(DepositedState storage state, uint256 currentSlot, uint256 depositAmount) internal {
        if (currentSlot > type(uint64).max) revert SlotTooLarge(currentSlot);
        if (depositAmount > type(uint128).max) revert DepositAmountTooLarge(depositAmount);
        if (depositAmount == 0) revert ZeroValue("depositAmount");

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
        uint256 depositsEntryAmount = state.slotsDeposits.length;
        if (depositsEntryAmount == 0) return 0;
        // data in tracker was already read, as cursor point to element that will be added later in state
        if (state.cursor == depositsEntryAmount) return 0;

        // define cursor start
        uint256 startIndex = state.cursor;

        (uint64 startDepositSlot, ) = state.slotsDeposits[state.cursor].unpack();
        if (startDepositSlot > _slot) return 0;

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

        // didnt move cursor yet
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
    /// @param state - Deposited wei state
    /// @param _slot - Upper bound slot
    /// @dev Rules:
    ///      - Cursor only moves to the right;
    ///      - _slot must be >= slot at current cursor;
    ///      - _slot < cursorSlot, don't move cursor
    ///      - Search only in the suffix (cursor, slotsDeposits.len);
    ///      - Find index of first element that higher than _slot;
    ///      - Cursor max value is depositsEntryAmount
    function moveCursorPastSlot(DepositedState storage state, uint256 _slot) internal {
        if (_slot > type(uint64).max) revert SlotTooLarge(_slot);

        uint256 depositsEntryAmount = state.slotsDeposits.length;
        if (depositsEntryAmount == 0) return;

        if (state.cursor == depositsEntryAmount) return;

        (uint64 lastDepositSlot,) = state.slotsDeposits[depositsEntryAmount - 1].unpack();

        // there are no deposits on slot higher than lastDepositSlot
        if (_slot >= lastDepositSlot) {
            state.cursor = depositsEntryAmount;
            return;
        }

        (uint64 cursorSlot, ) = state.slotsDeposits[state.cursor].unpack();

        if (_slot < cursorSlot) return;

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
}
