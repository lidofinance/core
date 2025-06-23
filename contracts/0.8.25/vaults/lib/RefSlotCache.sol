// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";

library RefSlotCache {
    struct Int112WithRefSlotCache {
        int112 value;
        int112 valueOnRefSlot;
        uint32 refSlot;
    }
    struct Uint112WithRefSlotCache {
        uint112 value;
        uint112 valueOnRefSlot;
        uint32 refSlot;
    }

    /// @notice Increases the value and caches the previous value for the current refSlot
    /// @param _storage The storage slot to update
    /// @param _consensus The consensus contract to get the current refSlot
    /// @param _increment increment the value by this amount
    /// @return the updated struct to be saved in storage
    function withValueIncrease(
        Uint112WithRefSlotCache storage _storage,
        IHashConsensus _consensus,
        uint112 _increment
    ) internal view returns (Uint112WithRefSlotCache memory) {
        (uint256 refSlot, ) = _consensus.getCurrentFrame();

        Uint112WithRefSlotCache memory newStorage = _storage;

        if (newStorage.refSlot != uint32(refSlot)) { // 32 bits is enough precision for this kind of comparison
            newStorage.valueOnRefSlot = _storage.value;
            newStorage.refSlot = uint32(refSlot);
        }

        newStorage.value += _increment;

        return newStorage;
    }

    /// @notice Increases the value and caches the previous value for the current refSlot
    /// @param _storage The storage slot to update
    /// @param _consensus The consensus contract to get the current refSlot
    /// @param _increment increment the value by this amount
    /// @return the updated struct to be saved in storage
    function withValueIncrease(
        Int112WithRefSlotCache storage _storage,
        IHashConsensus _consensus,
        int112 _increment
    ) internal view returns (Int112WithRefSlotCache memory) {
        (uint256 refSlot, ) = _consensus.getCurrentFrame();

        Int112WithRefSlotCache memory newStorage = _storage;

        if (newStorage.refSlot != uint32(refSlot)) { // 32 bits is enough precision for this kind of comparison
            newStorage.valueOnRefSlot = _storage.value;
            newStorage.refSlot = uint32(refSlot);
        }

        newStorage.value += _increment;

        return newStorage;
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

    /// @notice Returns the value for the current refSlot
    /// @param _storage the storage pointer for the cached value
    /// @param _consensus the consensus contract to get the current refSlot
    /// @return the cached value if it's changed since the last refSlot, the current value otherwise
    function getValueForLastRefSlot(
        Int112WithRefSlotCache storage _storage,
        IHashConsensus _consensus
    ) internal view returns (int112) {
        (uint256 refSlot, ) = _consensus.getCurrentFrame();
        if (uint32(refSlot) > _storage.refSlot) {
            return _storage.value;
        } else {
            return _storage.valueOnRefSlot;
        }
    }
}
