// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.9;

/// @dev Represents the state of a single deposited ether slot
struct DepositedEtherSlotState {
    // slot number
    uint64 slot;
    // total amount of ether deposited in this slot (128 bits)
    uint128 amount;
}

struct DepositedEtherState {
    // accumulated sum of all saved slot items
    uint128 totalAmount;
    // packed slot and amount
    uint256[] slotStates;
}

library DepositedEtherSlotStatePackedLib {
    function pack(DepositedEtherSlotState memory s) internal pure returns (uint256) {
        return (uint256(s.slot) << 128) | uint256(s.amount);
    }

    function unpack(uint256 value) public pure returns (DepositedEtherSlotState memory s) {
        s.slot = uint64(value >> 128);
        s.amount = uint128(value);
    }
}

library DepositedEtherStateLib {
    using DepositedEtherSlotStatePackedLib for uint256;
    using DepositedEtherSlotStatePackedLib for DepositedEtherSlotState;
    using DepositedEtherStateLib for bytes32;

    struct DataStorage {
        DepositedEtherState _data;
    }

    // function insertDepositedEther(bytes32 _position, uint64 _slot, uint128 _amount) internal {
    //     return insertDepositedEther(getDepositedEtherStateStorage(_position), _slot, _amount);
    // }

    // function getDepositedEther(bytes32 _position) internal view returns (uint256) {
    //     return getDepositedEther(getDepositedEtherStateStorage(_position));
    // }

    // function sliceDepositedEther(bytes32 _position, uint64 _slot) internal view returns (uint128 _amount, uint256 _count) {
    //     return sliceDepositedEther(getDepositedEtherStateStorage(_position), _slot);
    // }

    // function extractDepositedEther(bytes32 _position, uint64 _slot) internal returns (uint128 _amount) {
    //     return extractDepositedEther(getDepositedEtherStateStorage(_position), _slot);
    // }

    // function getDepositedEtherStates(DepositedEtherState storage _state)
    //     internal
    //     view
    //     returns (DepositedEtherSlotState[] memory slotStates)
    // {
    //     uint256 length = _state.slotStates.length;
    //     slotStates = new DepositedEtherSlotState[](length);
    //     for (uint256 i = 0; i < length; ++i) {
    //         slotStates[i] = _state.slotStates[i].unpack();
    //     }
    //     return slotStates;
    // }

    function getDepositedEther(DepositedEtherState storage _state) internal view returns (uint256) {
        return _state.totalAmount;
    }

    function insertDepositedEther(DepositedEtherState storage _state, uint64 _slot, uint128 _amount) internal {
        uint256 length = _state.slotStates.length;
        if (length > 0) {
            unchecked {
                length -= 1; // Get the last index
            }
            // check if the last slot state matches the new slot
            // if it does, just add the amount to the last state
            // otherwise, add a new state with the new slot and amount
            DepositedEtherSlotState memory lastState = _state.slotStates[length].unpack();
            if (lastState.slot == _slot) {
                lastState.amount += _amount;
                _state.slotStates[length] = lastState.pack();
                // increase total amount
                _state.totalAmount += _amount;
                return;
            }
            // if new slot
            assert(lastState.slot < _slot); // Ensure slots are in ascending order
        }
        _state.slotStates.push(DepositedEtherSlotState({slot: _slot, amount: _amount}).pack());
        // increase total amount
        _state.totalAmount += _amount;
    }

    function sliceDepositedEther(DepositedEtherState storage _state, uint64 _slot)
        internal
        view
        returns (uint128 _amount, uint256 _count)
    {
        uint256 length = _state.slotStates.length;
        if (length == 0) {
            return (0, 0);
        }
        // iterate slot from first to last and calc sum of amounts
        for (_count = 0; _count < length; ++_count) {
            DepositedEtherSlotState memory state = _state.slotStates[_count].unpack();
            if (state.slot > _slot) {
                // stop if we reach a slot greater than the requested one
                break;
            }
            // accumulate the amount for all slots less than or equal to the requested slot
            _amount += state.amount;
        }
    }

    function extractDepositedEther(DepositedEtherState storage _state, uint64 _slot)
        internal
        returns (uint128 _amount)
    {
        uint256 count;
        (_amount, count) = sliceDepositedEther(_state, _slot);
        if (count == 0) {
            // No deposits for the requested slot
            return 0;
        }

        // shrink processed slot states, keeping only those with slots greater than the requested slot
        uint256 length;
        unchecked {
            // count < _state.slotStates.length
            length = _state.slotStates.length - count;
        }
        uint256[] memory slotStates = new uint256[](length);
        for (uint256 j = 0; j < length; ++j) {
            unchecked {
                slotStates[j] = _state.slotStates[j + count];
            }
        }

        // replace array in storage
        _state.slotStates = slotStates;
        // update total amount by subtracting the extracted amount
        _state.totalAmount -= _amount;
    }

    function getDepositedEtherStateStorage(bytes32 _position) internal view returns (DepositedEtherState storage) {
        return _getDataStorage(_position)._data;
    }

    function _getDataStorage(bytes32 _position) private pure returns (DataStorage storage $) {
        assembly {
            $.slot := _position
        }
    }
}
