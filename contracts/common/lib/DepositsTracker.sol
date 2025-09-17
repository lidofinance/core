// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line
pragma solidity >=0.8.9 <0.9.0;

/// @notice Deposit information between two slots
/// Pack slots information
struct DepositedEthState {
    /// tightly packed deposit data ordered from older to newer by slot
    uint256[] slotsDeposits;
    /// Index of next element to read
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
        return (uint256(deposit.slot) << 192) | uint256(deposit.cumulativeEth);
    }

    function unpack(uint256 value) internal pure returns (SlotDeposit memory slotDeposit) {
        slotDeposit.slot = uint64(value >> 192);
        slotDeposit.cumulativeEth = uint192(value);
    }
}

/// @notice library for tracking deposits for some period of time
library DepositsTracker {
    using SlotDepositPacking for uint256;
    using SlotDepositPacking for SlotDeposit;

    error SlotOutOfOrder();
    error SlotTooLarge(uint256 slot);
    error DepositAmountTooLarge(uint256 depositAmount);
    error ZeroValue(string depositAmount);
    error SlotOutOfRange();

    /// @notice Add new deposit information in deposit state
    ///
    /// @param _depositedEthStatePosition - slot in storage
    /// @param currentSlot - slot of deposit // Maybe it is more secure to calculate current slot in this method
    /// @param depositAmount - Eth deposit amount
    function insertSlotDeposit(bytes32 _depositedEthStatePosition, uint256 currentSlot, uint256 depositAmount) public {
        if (currentSlot > type(uint64).max) revert SlotTooLarge(currentSlot);
        if (depositAmount > type(uint128).max) revert DepositAmountTooLarge(depositAmount);
        if (depositAmount == 0) revert ZeroValue("depositAmount");

        DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);

        uint256 depositsEntryAmount = state.slotsDeposits.length;

        if (depositsEntryAmount == 0) {
            state.slotsDeposits.push(SlotDeposit(uint64(currentSlot), uint192(depositAmount)).pack());
            return;
        }

        // last deposit
        SlotDeposit memory lastDeposit = state.slotsDeposits[depositsEntryAmount - 1].unpack();

        // if last tracked deposit's slot newer than currentSlot, than such attempt should be reverted
        if (lastDeposit.slot > currentSlot) {
            revert SlotOutOfOrder();
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
    function getDepositedEthUpToSlot(bytes32 _depositedEthStatePosition, uint256 _slot)
        public
        view
        returns (uint256 total)
    {
        DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);
        uint256 depositsEntryAmount = state.slotsDeposits.length;
        if (depositsEntryAmount == 0) return 0;
        // data in tracker was already read
        if (state.cursor == depositsEntryAmount) return 0;

        // define cursor start
        uint256 startIndex = state.cursor;
        SlotDeposit memory startDeposit = state.slotsDeposits[state.cursor].unpack();
        // TODO: maybe error should be LessThanCursorValue or smth
        if (startDeposit.slot > _slot) revert SlotOutOfRange();

        uint256 endIndex = type(uint256).max;
        for (uint256 i = startIndex; i < depositsEntryAmount;) {
            SlotDeposit memory d = state.slotsDeposits[i].unpack();
            if (d.slot > _slot) break;

            endIndex = i;
            unchecked {
                ++i;
            }
        }
        uint256 endCumulative = state.slotsDeposits[endIndex].unpack().cumulativeEth;

        if (startIndex == 0) {
            return endCumulative;
        }

        uint256 lastCumulative = state.slotsDeposits[startIndex - 1].unpack().cumulativeEth;
        return endCumulative - lastCumulative;
    }

    /// @notice Return the total ETH deposited since slot that corresponce to cursor to last slot in tracker
    ///
    /// @param _depositedEthStatePosition - slot in storage
    /// @dev this method will use cursor for start reading data
    function getDepositedEthUpToLastSlot(bytes32 _depositedEthStatePosition) public view returns (uint256 total) {
        DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);
        uint256 depositsEntryAmount = state.slotsDeposits.length;
        if (depositsEntryAmount == 0) return 0;
        // data in tracker was already read
        if (state.cursor == depositsEntryAmount) return 0;

        SlotDeposit memory endSlot = state.slotsDeposits[depositsEntryAmount - 1].unpack();

        if (state.cursor == 0) {
            return endSlot.cumulativeEth;
        }

        SlotDeposit memory startSlot = state.slotsDeposits[state.cursor - 1].unpack();
        return endSlot.cumulativeEth - startSlot.cumulativeEth;
    }

    /// @notice Move cursor to next slot after provided
    /// @dev Rules:
    ///      - Cursor only moves to the right;
    ///      - _slot must be >= slot at current cursor;
    ///      - Search only in the suffix (cursor, len);
    ///      - Find index of first element that higher than _slot;
    ///      - max value that can have cursor is depositsEntryAmount
    ///      - Method will revert only if _slot is less than cursor slot, as if there are no entries in tracker > _slot we think everything was read and set cursor to length of slotsDeposits
    function moveCursorToSlot(bytes32 _depositedEthStatePosition, uint256 _slot) public {
        if (_slot > type(uint64).max) revert SlotTooLarge(_slot);

        DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);
        uint256 depositsEntryAmount = state.slotsDeposits.length;
        if (depositsEntryAmount == 0) return;

        SlotDeposit memory lastSlot = state.slotsDeposits[depositsEntryAmount - 1].unpack();

        if (_slot >= lastSlot.slot) {
            state.cursor = depositsEntryAmount;
            return;
        }

        if (state.cursor == depositsEntryAmount) return;
        SlotDeposit memory cursorSlot = state.slotsDeposits[state.cursor].unpack();

        if (_slot < cursorSlot.slot) revert SlotOutOfOrder();

        if (cursorSlot.slot == _slot) {
            state.cursor = state.cursor + 1;
            return;
        }

        uint256 startIndex = state.cursor + 1;

        for (uint256 i = startIndex; i < depositsEntryAmount;) {
            SlotDeposit memory d = state.slotsDeposits[i].unpack();
            if (d.slot > _slot) {
                state.cursor = i;
                break;
            }

            unchecked {
                ++i;
            }
        }
    }

    function moveCursorToLastSlot(bytes32 _depositedEthStatePosition) public {
        DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);
        uint256 depositsEntryAmount = state.slotsDeposits.length;
        // here cursor will have default value
        if (depositsEntryAmount == 0) return;
        // everything was read
        state.cursor = depositsEntryAmount;
    }

    function _getDataStorage(bytes32 _position) private pure returns (DepositedEthState storage $) {
        assembly {
            $.slot := _position
        }
    }
}
