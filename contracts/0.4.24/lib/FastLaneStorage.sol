// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.4.24;

library FastLaneStorage {
    struct FastLaneData {
        /// @notice Depositable ether amount exceeding the currently existing withdrawal demand
        /// @dev gets replenished with each AccountingOracle frame
        uint256 maxAllowedAmount;
        /// @notice Accumulates deposited ether for each checkpoint
        /// @dev Checkpoints are correspond to the AccountingOracle frames
        mapping(uint256 => uint256) consumedAmount;
    }

    /// @dev Get maxAllowedAmount from unstructured storage
    function getMaxAllowedAmount(bytes32 _position) public view returns (uint256 value) {
        assembly {
            value := sload(_position)
        }
    }

    /// @dev Set maxAllowedAmount in unstructured storage
    function setMaxAllowedAmount(bytes32 _position, uint256 _value) public {
        assembly {
            sstore(_position, _value)
        }
    }

    /// @dev Get consumedAmount[_key] from unstructured storage
    function getConsumedAmount(bytes32 _position, uint256 _key) public view returns (uint256 value) {
        bytes32 slot;
        assembly {
            // mapping base slot = position + 1
            let mappingSlot := add(_position, 1)
            // hash (key, mappingSlot)
            mstore(0x00, _key)
            mstore(0x20, mappingSlot)
            slot := keccak256(0x00, 0x40)
            value := sload(slot)
        }
    }

    /// @dev Set consumedAmount[_key] in unstructured storage
    function setConsumedAmount(bytes32 _position, uint256 _key, uint256 _value) internal {
        bytes32 slot;
        assembly {
            // mapping base slot = position + 1
            let mappingSlot := add(_position, 1)
            // hash (key, mappingSlot)
            mstore(0x00, _key)
            mstore(0x20, mappingSlot)
            slot := keccak256(0x00, 0x40)
            sstore(slot, _value)
        }
    }

    /// @dev Get consumable amount (maxAmount - consumedAmount if consumedAmount < maxAmount)
    function getConsumableAmount(bytes32 _position, uint256 _refSlot) public view returns (uint256) {
        uint256 consumed = getConsumedAmount(_position, _refSlot);
        uint256 max = getMaxAllowedAmount(_position);
        return consumed < max ? max - consumed : 0;
    }

    /// @dev Add to consumedAmount[_key]
    function addConsumedAmount(bytes32 _position, uint256 _key, uint256 _amount) public {
        uint256 current = getConsumedAmount(_position, _key);
        setConsumedAmount(_position, _key, current + _amount);
    }
}
