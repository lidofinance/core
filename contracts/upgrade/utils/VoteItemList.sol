// contracts/upgrade/utils/VoteItemList.sol
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

import {OmnibusBase} from "./OmnibusBase.sol";

library VoteItemList {
    /// @notice Thrown when adding an item would exceed the allocated list capacity.
    /// @param cap Allocated list capacity.
    error ItemsCountOverflow(uint256 cap);

    /// @notice Thrown when the built list size differs from the expected item count.
    /// @param actual Actual number of items in the list.
    /// @param expected Expected number of items in the list.
    error InvalidItemsCount(uint256 actual, uint256 expected);

    /// @notice In-memory builder for a bounded list of vote items.
    /// @param items Preallocated vote item buffer.
    /// @param size Number of items currently written to the buffer.
    struct Builder {
        OmnibusBase.VoteItem[] items;
        uint256 size;
    }

    /// @notice Initializes a vote item list builder.
    /// @param cap Upper bound for the list size. It may exceed the final size; build trims unused slots.
    function init(uint256 cap) internal pure returns (Builder memory b) {
        b.items = new OmnibusBase.VoteItem[](cap);
    }

    /// @notice Appends a vote item to the builder.
    /// @param b Builder to append to.
    /// @param item Vote item to append.
    function push(Builder memory b, OmnibusBase.VoteItem memory item) internal pure {
        if (b.size >= b.items.length) revert ItemsCountOverflow(b.items.length);
        b.items[b.size++] = item;
    }

    /// @notice Builds the final vote item list.
    /// @dev Trims the buffer to the actual size and verifies it against the expected count.
    /// @param b Builder to finalize.
    /// @param expected Expected number of items in the list.
    /// @return items Final vote item list.
    function build(Builder memory b, uint256 expected) internal pure returns (OmnibusBase.VoteItem[] memory items) {
        uint256 size = b.size;
        if (size != expected) revert InvalidItemsCount(size, expected);
        items = b.items;
        if (items.length != size) {
            // Memory arrays can be shortened by updating the length stored in the first word.
            assembly { mstore(items, size) }
        }
    }
}
