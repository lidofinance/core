// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";

uint256 constant CACHE_LENGTH = 2;

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
        Int112WithRefSlotCache[CACHE_LENGTH] storage _storage,
        IHashConsensus _consensus,
        int112 _increment
    ) internal view returns (Int112WithRefSlotCache[CACHE_LENGTH] memory) {
        (uint256 refSlot, ) = _consensus.getCurrentFrame();

        Int112WithRefSlotCache[CACHE_LENGTH] memory newStorage = _storage;
        uint256 activeCacheIndex = _activeCacheIndex(newStorage);

        if (newStorage[activeCacheIndex].refSlot != uint32(refSlot)) { // 32 bits is enough precision for this kind of comparison
            activeCacheIndex = _nextCacheIndex(activeCacheIndex);
            newStorage[activeCacheIndex].value = newStorage[_previousCacheIndex(activeCacheIndex)].value;
            newStorage[activeCacheIndex].valueOnRefSlot = newStorage[_previousCacheIndex(activeCacheIndex)].value;
            newStorage[activeCacheIndex].refSlot = uint32(refSlot);
        }

        newStorage[activeCacheIndex].value += _increment;

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

    /// @notice Returns the current value of the cache
    /// @param _storage the storage pointer for the array of cached values
    /// @return the current value of the cache
    function currentValue(Int112WithRefSlotCache[CACHE_LENGTH] memory _storage) internal view returns (int112) {
        return _storage[_activeCacheIndex(_storage)].value;
    }

    /// @notice Returns the value for the refSlot
    /// @param _storage the storage pointer for the cached value
    /// @param _refSlot the refSlot to get the value for
    /// @return the cached value if it's changed since the last refSlot, the current value otherwise
    /// @dev reverts if the cache was overwritten after target refSlot
    function getValueForRefSlot(
        Int112WithRefSlotCache[CACHE_LENGTH] memory _storage,
        uint32 _refSlot
    ) internal view returns (int112) {
        uint256 activeCacheIndex = _activeCacheIndex(_storage);

        if (_refSlot > _storage[activeCacheIndex].refSlot) {
            return _storage[activeCacheIndex].value;
        } else if (_refSlot > _storage[_previousCacheIndex(activeCacheIndex)].refSlot) {
            return _storage[activeCacheIndex].valueOnRefSlot;
        } else if (_refSlot == _storage[_previousCacheIndex(activeCacheIndex)].refSlot) {
            return _storage[_previousCacheIndex(activeCacheIndex)].valueOnRefSlot;
        } else {
            revert InOutDeltaCacheIsOverwritten();
        }
    }

    function _activeCacheIndex(Int112WithRefSlotCache[CACHE_LENGTH] memory _storage) private pure returns (uint256) {
        return _storage[0].refSlot >= _storage[1].refSlot ? 0 : 1;
    }

    function _previousCacheIndex(uint256 _cacheIndex) private pure returns (uint256) {
        return 1 - _cacheIndex;
    }

    function _nextCacheIndex(uint256 _cacheIndex) private pure returns (uint256) {
        return 1 - _cacheIndex;
    }

    error InOutDeltaCacheIsOverwritten();
}
