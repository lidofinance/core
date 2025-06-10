// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

interface IHashConsensus {
    function getCurrentFrame() external view returns (uint256 refSlot, uint256);
}

library RefSlotCache {
    struct Uint112WithRefSlotCache {
        uint112 value;
        uint112 valueOnRefSlot;
        uint32 refSlot;
    }

    /// @notice Increases the value and caches the previous value for the current refSlot
    /// @param _storage The storage slot to update
    /// @param _consensus The consensus contract to get the current refSlot
    /// @param _increment increment the value by this amount
    function updateCacheAndIncreaseValue(
        Uint112WithRefSlotCache storage _storage,
        IHashConsensus _consensus,
        uint112 _increment
    ) internal {
        (uint256 refSlot, ) = _consensus.getCurrentFrame();

        uint112 currentValue = _storage.value;
        if (_storage.refSlot != uint32(refSlot)) { // 32 bits is enough precision for this kind of comparison
            _storage.valueOnRefSlot = currentValue;
            _storage.refSlot = uint32(refSlot);
        }

        _storage.value = currentValue + _increment;
    }

    /// @notice Returns the value for the current refSlot
    /// @param _storage the storage pointer for the cached value
    /// @param _consensus the consensus contract to get the current refSlot
    /// @return the cached value if it's changed since the last refSlot, the current value otherwise
    function getValueForLastRefSlot(
        Uint112WithRefSlotCache storage _storage,
        IHashConsensus _consensus
    ) internal view returns (uint112) {
        (uint256 refSlot, ) = _consensus.getCurrentFrame();
        if (uint32(refSlot) > _storage.refSlot) {
            return _storage.value;
        } else {
            return _storage.valueOnRefSlot;
        }
    }
}