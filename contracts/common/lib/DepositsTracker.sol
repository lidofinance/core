// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line
pragma solidity >=0.8.9 <0.9.0;

/// @notice Deposit information between two slots
/// Pack slots information
struct DepositedEthState {
    /// total amount of eth
    uint256 totalAmount;
    /// tightly packed deposit data ordered from older to newer by slot
    uint256[] slotsDeposits;
    /// total sum after each slotsDeposits[i] entry; slotsDeposits.length == cumulative.length
    uint256[] cumulative;
    /// Index of the last read
    uint256 indexOfLastRead;
}

/// @notice Deposit in slot
struct SlotDeposit {
    /// Ethereum slot
    uint64 slot;
    /// Can be limited by value that can be deposited in one block
    /// dependence on use case in one slot can be more than one deposit
    uint128 depositedEth;
}

library SlotDepositPacking {
    function pack(SlotDeposit memory deposit) internal pure returns (uint256) {
        return (uint256(deposit.slot) << 128) | uint256(deposit.depositedEth);
    }

    function unpack(uint256 value) internal pure returns (SlotDeposit memory slotDeposit) {
        slotDeposit.slot = uint64(value >> 128);
        slotDeposit.depositedEth = uint128(value);
    }
}

/// @notice library for tracking deposits for some period of time
library DepositsTracker {
    using SlotDepositPacking for uint256;
    using SlotDepositPacking for SlotDeposit;

    error SlotOutOfOrder(uint256 lastSlotInStorage, uint256 slotToTrack);
    error SlotTooLarge(uint256 slot);
    error DepositAmountTooLarge(uint256 depositAmount);
    error ZeroValue(bytes depositAmount);
    error SlotOutOfRange(uint256 leftBoundSlot, uint256 currentSlot);
    error InvalidCursor(uint256 startIndex, uint256 depositsEntryAmount);

    /// @notice Add new deposit information in deposit state
    ///
    /// @param _depositedEthStatePosition - slot in storage
    /// @param currentSlot - slot of deposit
    /// @param depositAmount - Eth deposit amount
    function insertSlotDeposit(bytes32 _depositedEthStatePosition, uint256 currentSlot, uint256 depositAmount) public {
        if (currentSlot > type(uint64).max) revert SlotTooLarge(currentSlot);
        if (depositAmount > type(uint128).max) revert DepositAmountTooLarge(depositAmount);
        if (depositAmount == 0) revert ZeroValue("depositAmount");

        DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);

        uint256 depositsEntryAmount = state.slotsDeposits.length;

        // SlotDeposit memory currentDeposit = SlotDeposit(uint64(currentSlot), uint128(depositAmount));

        if (depositsEntryAmount == 0) {
            state.slotsDeposits.push(SlotDeposit(uint64(currentSlot), uint128(depositAmount)).pack());
            state.cumulative.push(depositAmount);
            state.totalAmount += depositAmount;
            state.indexOfLastRead = type(uint256).max;
            return;
        }

        // last deposit
        SlotDeposit memory lastDeposit = state.slotsDeposits[depositsEntryAmount - 1].unpack();

        // if last tracked deposit's slot newer than currentSlot, than such attempt should be reverted
        if (lastDeposit.slot > currentSlot) {
            // TODO: maybe WrongSlotsOrder || WrongSlotsOrderSorting
            revert SlotOutOfOrder(lastDeposit.slot, currentSlot);
        }

        // if it is the same block, increase amount
        if (lastDeposit.slot == currentSlot) {
            lastDeposit.depositedEth += uint128(depositAmount);
            state.slotsDeposits[depositsEntryAmount - 1] = lastDeposit.pack();
            state.cumulative[depositsEntryAmount - 1] += depositAmount;
            state.totalAmount += depositAmount;
            return;
        }

        //if it is a new block, store new SlotDeposit value
        state.slotsDeposits.push(SlotDeposit(uint64(currentSlot), uint128(depositAmount)).pack());
        state.totalAmount += depositAmount;
        state.cumulative.push(state.cumulative[depositsEntryAmount - 1] + depositAmount);
    }

    /// @notice Return the total ETH deposited strictly before slot
    ///
    /// @param _depositedEthStatePosition - slot in storage
    /// @param _slot - Upper bound slot
    /// @dev this method will use cursor for start reading data
    /// In use case for ao it will read from one ref slot to another
    function getDepositedEth(bytes32 _depositedEthStatePosition, uint256 _slot) public returns (uint256) {
        DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);
        uint256 depositsEntryAmount = state.slotsDeposits.length;
        if (depositsEntryAmount == 0) return 0;

        // define cursor start
        uint256 startIndex = 0;
        uint256 leftBoundCumulativeSum = 0;

        // if it was initialized earlier
        if (state.indexOfLastRead != type(uint256).max) {
            if (state.indexOfLastRead >= depositsEntryAmount)
                revert InvalidCursor(state.indexOfLastRead, depositsEntryAmount);

            SlotDeposit memory leftBoundDeposit = state.slotsDeposits[state.indexOfLastRead].unpack();
            if (leftBoundDeposit.slot > _slot) revert SlotOutOfRange(leftBoundDeposit.slot, _slot);

            if (state.indexOfLastRead == depositsEntryAmount - 1) return 0;

            startIndex = state.indexOfLastRead + 1;

            // maybe use here state.indexOfLastRead
            // SlotDeposit memory leftBoundDeposit = state.slotsDeposits[startIndex].unpack();
            // if (leftBoundDeposit.slot > _slot) revert SlotOutOfRange(leftBoundDeposit.slot, _slot);

            leftBoundCumulativeSum = state.cumulative[state.indexOfLastRead];
        }

        uint256 endIndex = type(uint256).max;
        for (uint256 i = startIndex; i < depositsEntryAmount; ) {
            SlotDeposit memory d = state.slotsDeposits[i].unpack();
            if (d.slot > _slot) break; // inclusive upper bound: include deposits at _slot

            endIndex = i; // track last included index
            unchecked {
                ++i;
            }
        }

        // nothing matched
        if (endIndex == type(uint256).max) return 0;

        uint256 result = state.cumulative[endIndex] - leftBoundCumulativeSum;

        state.indexOfLastRead = endIndex;

        return result;
    }

    function _getDataStorage(bytes32 _position) private pure returns (DepositedEthState storage $) {
        assembly {
            $.slot := _position
        }
    }

    // /// @notice Return the total ETH deposited strictly before slot
    // ///
    // /// @param _depositedEthStatePosition - slot in storage
    // /// @param _slot - Upper bound slot
    // function getDepositedEthBefore(bytes32 _depositedEthStatePosition, uint256 _slot) public view returns (uint256) {
    //     DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);
    //     uint256 depositsEntryAmount = state.slotsDeposits.length;
    //     if (depositsEntryAmount == 0) return 0;

    //     (uint256 newerDepositsAmount, ) = _getDepositedEthAndDepositsCountAfter(state, _slot);

    //     return state.totalAmount - newerDepositsAmount;
    // }

    // /// @notice
    // /// @param _depositedEthStatePosition - slot in storage
    // /// @param _slot - Upper bound slot, included in result
    // function cleanAndGetDepositedEthBefore(bytes32 _depositedEthStatePosition, uint256 _slot) public returns (uint256) {
    //     if (_slot > type(uint64).max) revert SlotTooLarge(_slot);
    //     DepositedEthState storage state = _getDataStorage(_depositedEthStatePosition);
    //     uint256 depositsEntryAmount = state.slotsDeposits.length;
    //     if (depositsEntryAmount == 0) return 0;

    //     (uint256 newerDepositsAmount, uint256 newerDepositsCount) = _getDepositedEthAndDepositsCountAfter(state, _slot);

    //     uint256 depositsAmountBefore = state.totalAmount - newerDepositsAmount;

    //     // no deposits after 'slot', including slot
    //     if (newerDepositsCount == 0) {
    //         delete state.slotsDeposits;
    //         state.totalAmount = 0;
    //         return depositsAmountBefore;
    //     }

    //     // deposits amount after 'slot' and including slot equal
    //     if (newerDepositsCount == depositsEntryAmount) {
    //         return state.totalAmount;
    //     }

    //     uint256[] memory slotsDeposits = new uint256[](newerDepositsCount);
    //     for (uint256 i = 0; i < newerDepositsCount; ) {
    //         slotsDeposits[i] = state.slotsDeposits[depositsEntryAmount - newerDepositsCount + i];
    //         unchecked {
    //             ++i;
    //         }
    //     }

    //     state.totalAmount = newerDepositsAmount;
    //     // state.lastTrackerCleanSlot = uint64(_slot);
    //     state.slotsDeposits = slotsDeposits;

    //     return depositsAmountBefore;
    // }

    // function _getDepositedEthAndDepositsCountAfter(
    //     DepositedEthState memory state,
    //     uint256 _slot
    // ) private pure returns (uint256 newerDepositsAmount, uint256 newerDepositsCount) {
    //     if (_slot > type(uint64).max) revert SlotTooLarge(_slot);
    //     uint256 depositsEntryAmount = state.slotsDeposits.length;

    //     for (uint256 i = depositsEntryAmount; i > 0; ) {
    //         SlotDeposit memory d = state.slotsDeposits[i].unpack();

    //         if (d.slot <= _slot) {
    //             break;
    //         }

    //         unchecked {
    //             newerDepositsAmount += d.depositedEth;
    //             ++newerDepositsCount;
    //             --i;
    //         }
    //     }
    // }
}
