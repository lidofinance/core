// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line
pragma solidity >=0.8.9 <0.9.0;

/// @notice Deposit information between two slots
/// Pack slots information
struct DepositedEthState {
    /// tightly packed deposit data ordered from older to newer by slot
    uint256[] slotsDeposits;
    /// Index of the last read
    uint256 cursor;
}

/// @notice Deposit in slot
struct SlotDeposit {
    /// Ethereum slot
    uint64 slot;
    /// cumulative sum up to and including this slot
    uint192 cumulativeEth;
}

library SlotDepositPacking {
    function pack(SlotDeposit memory deposit) internal pure returns (uint256) {
        // return (uint256(deposit.slot) << 128) | uint256(deposit.depositedEth);
        return (uint256(deposit.slot) << 192) | uint256(deposit.cumulativeEth);
    }

    function unpack(uint256 value) internal pure returns (SlotDeposit memory slotDeposit) {
        slotDeposit.slot = uint64(value >> 192);
        // slotDeposit.depositedEth = uint128(value);
        slotDeposit.cumulativeEth = uint192(value);
    }
}

/// @notice library for tracking deposits for some period of time
library DepositsTracker {
    using SlotDepositPacking for uint256;
    using SlotDepositPacking for SlotDeposit;

    // TODO: description, order of arguments
    error SlotOutOfOrder(uint256 lastSlotInStorage, uint256 slotToTrack);
    error SlotTooLarge(uint256 slot);
    error DepositAmountTooLarge(uint256 depositAmount);
    error ZeroValue(bytes depositAmount);
    error SlotOutOfRange(uint256 leftBoundSlot, uint256 currentSlot);
    error InvalidCursor(uint256 startIndex, uint256 depositsEntryAmount);
    error NoSlotWithCumulative(uint256 upToSlot, uint256 cumulative);
    error InvalidCumulativeSum(uint256 providedCumulative, uint256 cursorCumulativeSum);

    /// @notice Add new deposit information in deposit state
    ///
    /// @param _depositedEthStatePosition - slot in storage
    /// @param currentSlot - slot of deposit
    /// @param depositAmount - Eth deposit amount
    function insertSlotDeposit(bytes32 _depositedEthStatePosition, uint256 currentSlot, uint256 depositAmount) public {
        if (currentSlot > type(uint64).max) revert SlotTooLarge(currentSlot);
        if (depositAmount > type(uint128).max) revert DepositAmountTooLarge(depositAmount);
        // or maybe write this attempt to call tracker like we we call SR.deposit even if msg.value == 0
        if (depositAmount == 0) revert ZeroValue("depositAmount");

        DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);

        uint256 depositsEntryAmount = state.slotsDeposits.length;

        if (depositsEntryAmount == 0) {
            state.slotsDeposits.push(SlotDeposit(uint64(currentSlot), uint192(depositAmount)).pack());

            state.cursor = type(uint256).max;
            return;
        }

        // last deposit
        SlotDeposit memory lastDeposit = state.slotsDeposits[depositsEntryAmount - 1].unpack();

        // if last tracked deposit's slot newer than currentSlot, than such attempt should be reverted
        if (lastDeposit.slot > currentSlot) {
            revert SlotOutOfOrder(lastDeposit.slot, currentSlot);
        }

        // if it is the same block, increase amount
        if (lastDeposit.slot == currentSlot) {
            lastDeposit.cumulativeEth += uint192(depositAmount);
            state.slotsDeposits[depositsEntryAmount - 1] = lastDeposit.pack();

            return;
        }

        state.slotsDeposits.push(
            SlotDeposit(uint64(currentSlot), lastDeposit.cumulativeEth + uint192(depositAmount)).pack()
        );
    }

    /// @notice Return the total ETH deposited before slot, inclusive slot
    ///
    /// @param _depositedEthStatePosition - slot in storage
    /// @param _slot - Upper bound slot
    /// @dev this method will use cursor for start reading data
    function getDepositedEthUpToSlot(
        bytes32 _depositedEthStatePosition,
        uint256 _slot
    ) public view returns (uint256 total) {
        DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);
        uint256 depositsEntryAmount = state.slotsDeposits.length;
        if (depositsEntryAmount == 0) return 0;

        // define cursor start
        uint256 startIndex = 0;
        uint256 leftBoundCumulativeSum = 0;

        // if it was initialized earlier
        if (state.cursor != type(uint256).max) {
            if (state.cursor >= depositsEntryAmount) revert InvalidCursor(state.cursor, depositsEntryAmount);

            SlotDeposit memory leftBoundDeposit = state.slotsDeposits[state.cursor].unpack();
            if (leftBoundDeposit.slot > _slot) revert SlotOutOfRange(leftBoundDeposit.slot, _slot);

            if (state.cursor == depositsEntryAmount - 1) return 0;

            startIndex = state.cursor;

            leftBoundCumulativeSum = leftBoundDeposit.cumulativeEth;
        }

        uint256 endIndex = type(uint256).max;
        for (uint256 i = startIndex; i < depositsEntryAmount; ) {
            SlotDeposit memory d = state.slotsDeposits[i].unpack();
            if (d.slot > _slot) break;

            endIndex = i;
            unchecked {
                ++i;
            }
        }

        if (endIndex == type(uint256).max) return 0;

        uint256 rightCumulative = state.slotsDeposits[endIndex].unpack().cumulativeEth;

        return rightCumulative - leftBoundCumulativeSum;
    }

    /// @notice Move cursor to slot with the same cumulative sum
    /// @dev Rules:
    ///      - Cursor only moves to the right: _slot must be >= slot at current cursor (if cursor is set).
    ///      - Search only in the suffix [cursor, len) (or [0, len) if cursor is not initialized).
    ///      - Among entries with slot <= _slot, find index whose cumulative equals `cumulativeSum`,
    ///        and move the cursor to that index.
    ///      - If no such entry exists, revert.
    function moveCursorToSlot(bytes32 _depositedEthStatePosition, uint256 _slot, uint256 _cumulativeSum) public {
        if (_slot > type(uint64).max) revert SlotTooLarge(_slot);
        if (_cumulativeSum > type(uint192).max) revert DepositAmountTooLarge(_cumulativeSum);

        DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);
        uint256 depositsEntryAmount = state.slotsDeposits.length;

        if (depositsEntryAmount == 0) {
            state.slotsDeposits.push(SlotDeposit(uint64(_slot), uint192(_cumulativeSum)).pack());
            state.cursor = 0;
            return;
        }

        uint256 startIndex = 0;

        if (state.cursor != type(uint256).max) {
            if (state.cursor >= depositsEntryAmount) revert InvalidCursor(state.cursor, depositsEntryAmount);

            SlotDeposit memory cursorSlotDeposit = state.slotsDeposits[state.cursor].unpack();

            if (_slot < cursorSlotDeposit.slot) revert SlotOutOfRange(cursorSlotDeposit.slot, _slot);

            if (_cumulativeSum < cursorSlotDeposit.cumulativeEth)
                revert InvalidCumulativeSum(_cumulativeSum, cursorSlotDeposit.cumulativeEth);

            startIndex = state.cursor;
        }

        for (uint256 i = startIndex; i < depositsEntryAmount; ) {
            SlotDeposit memory d = state.slotsDeposits[i].unpack();
            if (d.slot > _slot) break;

            if (d.cumulativeEth == _cumulativeSum) {
                state.cursor = i;
                return;
            }

            unchecked {
                ++i;
            }
        }

        revert NoSlotWithCumulative(_slot, _cumulativeSum);
    }

    function _getDataStorage(bytes32 _position) private pure returns (DepositedEthState storage $) {
        assembly {
            $.slot := _position
        }
    }
}
