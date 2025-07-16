// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";

uint256 constant DOUBLE_CACHE_LENGTH = 2;

library RefSlotCache {
    struct Uint112WithCache {
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
        Uint112WithCache storage _storage,
        IHashConsensus _consensus,
        uint112 _increment
    ) internal view returns (Uint112WithCache memory) {
        (uint256 refSlot, ) = _consensus.getCurrentFrame();

        Uint112WithCache memory newCache = _storage;

        if (newCache.refSlot != uint32(refSlot)) { // 32 bits is enough precision for this kind of comparison
            newCache.valueOnRefSlot = _storage.value;
            newCache.refSlot = uint32(refSlot);
        }

        newCache.value += _increment;

        return newCache;
    }

    /// @notice Returns the value for the current refSlot
    /// @param _storage the storage pointer for the cached value
    /// @param _consensus the consensus contract to get the current refSlot
    /// @return the cached value if it's changed since the last refSlot, the current value otherwise
    function getValueForLastRefSlot(
        Uint112WithCache storage _storage,
        IHashConsensus _consensus
    ) internal view returns (uint112) {
        (uint256 refSlot, ) = _consensus.getCurrentFrame();
        if (uint32(refSlot) != _storage.refSlot) {
            return _storage.value;
        } else {
            return _storage.valueOnRefSlot;
        }
    }
}

library DoubleRefSlotCache {
    struct Int112WithCache {
        int112 value;
        int112 valueOnRefSlot;
        uint32 refSlot;
    }

    /// @notice Initializes the cache with the given value
    /// @param _value the value to initialize the cache with
    /// @return the initialized cache
    function InitializeInt112DoubleCache(int112 _value) internal pure returns (Int112WithCache[DOUBLE_CACHE_LENGTH] memory) {
        return [
            Int112WithCache({
                value: _value,
                valueOnRefSlot: 0,
                refSlot: 0 // first cache slot is active by default (as >= used in _activeCacheIndex)
            }),
            Int112WithCache(0, 0, 0)
        ];
    }

    /// @notice Increases the value and caches the previous value for the current refSlot
    /// @param _storage The storage slot to update
    /// @param _consensus The consensus contract to get the current refSlot
    /// @param _increment increment the value by this amount
    /// @return the updated struct to be saved in storage
    function withValueIncrease(
        Int112WithCache[DOUBLE_CACHE_LENGTH] storage _storage,
        IHashConsensus _consensus,
        int112 _increment
    ) internal view returns (Int112WithCache[DOUBLE_CACHE_LENGTH] memory) {
        (uint256 refSlot, ) = _consensus.getCurrentFrame();

        Int112WithCache[DOUBLE_CACHE_LENGTH] memory newCache = _storage;
        uint256 activeCacheIndex = _activeCacheIndex(newCache);

        if (newCache[activeCacheIndex].refSlot != uint32(refSlot)) { // 32 bits is enough precision for this kind of comparison
            uint256 previousCacheIndex = activeCacheIndex;
            activeCacheIndex = 1 - activeCacheIndex;
            newCache[activeCacheIndex].value = newCache[previousCacheIndex].value;
            newCache[activeCacheIndex].valueOnRefSlot = newCache[previousCacheIndex].value;
            newCache[activeCacheIndex].refSlot = uint32(refSlot);
        }

        newCache[activeCacheIndex].value += _increment;

        return newCache;
    }

    /// @notice Returns the current value of the cache
    /// @param _cache the storage pointer for the array of cached values
    /// @return the current value of the cache
    function currentValue(Int112WithCache[DOUBLE_CACHE_LENGTH] memory _cache) internal pure returns (int112) {
        return _cache[_activeCacheIndex(_cache)].value;
    }

    /// @notice Returns the value for the refSlot
    /// @param _cache the storage pointer for the cached value
    /// @param _refSlot the refSlot to get the value for
    /// @return the cached value if it's changed since the last refSlot, the current value otherwise
    /// @dev reverts if the cache was overwritten after target refSlot
    function getValueForRefSlot(
        Int112WithCache[DOUBLE_CACHE_LENGTH] memory _cache,
        uint32 _refSlot
    ) internal pure returns (int112) {
        uint256 activeCacheIndex = _activeCacheIndex(_cache);

        // 1. refSlot is more than activeRefSlot
        if (_refSlot > _cache[activeCacheIndex].refSlot) {
            return _cache[activeCacheIndex].value;
        }

        uint256 previousCacheIndex = 1 - activeCacheIndex;
        // 2. refSlot is in (prevRefSlot, activeRefSlot]
        if (_refSlot > _cache[previousCacheIndex].refSlot) {
            return _cache[activeCacheIndex].valueOnRefSlot;
        }

        // 3. refSlot is equal to prevRefSlot
        if (_refSlot == _cache[previousCacheIndex].refSlot) {
            return _cache[previousCacheIndex].valueOnRefSlot;
        }

        // 4. refSlot is less than prevRefSlot
        revert InOutDeltaCacheIsOverwritten();
    }

    /// @dev There is a limitation on the refSlot value: it must be less than 2^32.
    /// If it exceeds this limit, the refSlot will be truncated to 32 bits.
    /// _activeCacheIndex may work incorrectly if one refSlot value is truncated and the other is not,
    /// because the non-truncated value will always be greater than the truncated one,
    /// causing incorrect activeIndex determination.
    function _activeCacheIndex(Int112WithCache[DOUBLE_CACHE_LENGTH] memory _cache) private pure returns (uint256) {
        return _cache[0].refSlot >= _cache[1].refSlot ? 0 : 1;
    }

    error InOutDeltaCacheIsOverwritten();
}
