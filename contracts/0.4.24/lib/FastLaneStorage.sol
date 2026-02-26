// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.4.24;

library FastLaneStorage {
    /// @dev Storage layout struct (for documentation purposes):
    ///      Slot (position):     maxAllowedAmount (uint256)
    ///      Slot (position + 1): lastRefSlot (uint256)
    ///      Slot (position + 2): consumedAmount (uint256)
    ///
    ///      NOTE: This struct is used for documentation only. We use assembly
    ///      for storage access because Solidity 0.4.24 does not support the
    ///      `s.slot := position` syntax for storage pointer assignment.
    // struct Storage {
    //     uint256 maxAllowedAmount;
    //     uint256 lastRefSlot;
    //     uint256 consumedAmount;
    // }

    /// @dev Get maxAllowedAmount from storage
    function getMaxAllowedAmount(bytes32 _position) internal view returns (uint256 value) {
        assembly {
            value := sload(_position)
        }
    }

    /// @dev Set maxAllowedAmount in storage
    function setMaxAllowedAmount(bytes32 _position, uint256 _value) internal {
        assembly {
            sstore(_position, _value)
        }
    }

    /// @dev Get lastRefSlot from storage (position + 1)
    function getLastRefSlot(bytes32 _position) internal view returns (uint256 value) {
        assembly {
            value := sload(add(_position, 1))
        }
    }

    /// @dev Set lastRefSlot in storage (position + 1)
    function setLastRefSlot(bytes32 _position, uint256 _value) internal {
        assembly {
            sstore(add(_position, 1), _value)
        }
    }

    /// @dev Get consumedAmount from storage (position + 2)
    function getConsumedAmount(bytes32 _position) internal view returns (uint256 value) {
        assembly {
            value := sload(add(_position, 2))
        }
    }

    /// @dev Set consumedAmount in storage (position + 2)
    function setConsumedAmount(bytes32 _position, uint256 _value) internal {
        assembly {
            sstore(add(_position, 2), _value)
        }
    }

    /// @dev Get consumable amount for the current refSlot.
    ///      Auto-reset (returns full maxAllowedAmount) only occurs when refSlot > lastRefSlot (new slot).
    ///      If refSlot <= lastRefSlot, the consumed amount is NOT reset.
    ///      When reset: returns full maxAllowedAmount.
    /// @dev The consumed amount may exceed the maximum allowed, which means that the
    ///      limit for the current slot has been exhausted
    function getConsumableAmount(bytes32 _position, uint256 _refSlot) internal view returns (uint256) {
        uint256 max = getMaxAllowedAmount(_position);
        uint256 lastSlot = getLastRefSlot(_position);

        // simulate Auto-reset on new slot
        if (_refSlot > lastSlot) {
            return max;
        }

        // Same or older refSlot: return remaining amount
        uint256 consumed = getConsumedAmount(_position);
        return consumed < max ? max - consumed : 0;
    }

    /// @dev Add to consumedAmount for the current refSlot.
    ///      Auto-reset only occurs when refSlot > lastRefSlot (new slot).
    ///      If refSlot <= lastRefSlot, the consumed amount accumulates without reset.
    function addConsumedAmount(bytes32 _position, uint256 _refSlot, uint256 _amount) internal {
        uint256 lastSlot = getLastRefSlot(_position);

        if (_refSlot > lastSlot) {
            // New refSlot (greater than last): reset tracking
            setLastRefSlot(_position, _refSlot);
            setConsumedAmount(_position, _amount);
        } else {
            // Same or older refSlot: accumulate without reset
            uint256 current = getConsumedAmount(_position);
            setConsumedAmount(_position, current + _amount);
        }
    }
}
