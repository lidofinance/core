// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable one-contract-per-file
pragma solidity 0.8.25;

import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";

uint256 constant DOUBLE_CACHE_LENGTH = 2;

// wrap external call in function to save bytecode
function _getCurrentRefSlot(IHashConsensus _consensus) view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000000, 1037618708480) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00001000, _consensus) }
    (uint256 refSlot, ) = _consensus.getCurrentFrame();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001013a,0)}
    return refSlot;
}

library RefSlotCache {
    struct Uint104WithCache {
        uint104 value;
        uint104 valueOnRefSlot;
        uint48 refSlot;
    }

    /// @notice Increases the value and caches the previous value for the current refSlot
    /// @param _storage The storage slot to update
    /// @param _consensus The consensus contract to get the current refSlot
    /// @param _increment increment the value by this amount
    /// @return the updated struct to be saved in storage
    function withValueIncrease(
        Uint104WithCache storage _storage,
        IHashConsensus _consensus,
        uint104 _increment
    ) internal view returns (Uint104WithCache memory) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006c0000, 1037618708588) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006c0001, 3) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006c1000, _storage.slot) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006c1001, _consensus) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006c1002, _increment) }
        uint256 refSlot = _getCurrentRefSlot(_consensus);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000013b,refSlot)}

        Uint104WithCache memory newCache = _storage;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001013c,0)}

        if (newCache.refSlot != uint48(refSlot)) {
            newCache.valueOnRefSlot = _storage.value;
            newCache.refSlot = uint48(refSlot);
        }

        newCache.value += _increment;uint104 certora_local323 = newCache.value;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000143,certora_local323)}

        return newCache;
    }

    /// @notice Returns the value for the current refSlot
    /// @param _storage the storage pointer for the cached value
    /// @param _consensus the consensus contract to get the current refSlot
    /// @return the cached value if it's changed since the last refSlot, the current value otherwise
    function getValueForLastRefSlot(
        Uint104WithCache storage _storage,
        IHashConsensus _consensus
    ) internal view returns (uint104) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006d0000, 1037618708589) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006d0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006d1000, _storage.slot) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006d1001, _consensus) }
        uint256 refSlot = _getCurrentRefSlot(_consensus);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000013d,refSlot)}
        if (uint48(refSlot) != _storage.refSlot) {
            return _storage.value;
        } else {
            return _storage.valueOnRefSlot;
        }
    }
}

library DoubleRefSlotCache {
    struct Int104WithCache {
        int104 value;
        int104 valueOnRefSlot;
        uint48 refSlot;
    }

    /// @notice Initializes the cache with the given value
    /// @param _value the value to initialize the cache with
    /// @return the initialized cache
    function initializeInt104DoubleCache(
        int104 _value
    ) internal pure returns (Int104WithCache[DOUBLE_CACHE_LENGTH] memory) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00670000, 1037618708583) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00670001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00671000, _value) }
        return [
            Int104WithCache({
                value: _value,
                valueOnRefSlot: 0,
                refSlot: 0 // first cache slot is active by default (as >= used in _activeCacheIndex)
            }),
            Int104WithCache(0, 0, 0)
        ];
    }

    /// @notice Increases the value and caches the previous value for the current refSlot
    /// @param _storage The storage slot to update
    /// @param _consensus The consensus contract to get the current refSlot
    /// @param _increment increment the value by this amount
    /// @return the updated struct to be saved in storage
    function withValueIncrease(
        Int104WithCache[DOUBLE_CACHE_LENGTH] storage _storage,
        IHashConsensus _consensus,
        int104 _increment
    ) internal view returns (Int104WithCache[DOUBLE_CACHE_LENGTH] memory) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00680000, 1037618708584) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00680001, 3) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00681000, _storage.slot) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00681001, _consensus) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00681002, _increment) }
        uint256 refSlot = _getCurrentRefSlot(_consensus);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000013e,refSlot)}

        Int104WithCache[DOUBLE_CACHE_LENGTH] memory newCache = _storage;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001013f,0)}
        uint256 activeCacheIndex = _activeCacheIndex(newCache);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000140,activeCacheIndex)}

        if (newCache[activeCacheIndex].refSlot != uint48(refSlot)) {
            uint256 previousCacheIndex = activeCacheIndex;
            activeCacheIndex = 1 - activeCacheIndex;
            newCache[activeCacheIndex].value = newCache[previousCacheIndex].value;
            newCache[activeCacheIndex].valueOnRefSlot = newCache[previousCacheIndex].value;
            newCache[activeCacheIndex].refSlot = uint48(refSlot);
        }

        newCache[activeCacheIndex].value += _increment;int104 certora_local324 = newCache[activeCacheIndex].value;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000144,certora_local324)}

        return newCache;
    }

    /// @notice Returns the current value of the cache
    /// @param _cache the storage pointer for the array of cached values
    /// @return the current value of the cache
    function currentValue(Int104WithCache[DOUBLE_CACHE_LENGTH] memory _cache) internal pure returns (int104) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006a0000, 1037618708586) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006a0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006a1000, _cache) }
        return _cache[_activeCacheIndex(_cache)].value;
    }

    /// @notice Returns the value for the refSlot
    /// @param _cache the storage pointer for the cached value
    /// @param _refSlot the refSlot to get the value for
    /// @return the cached value if it's changed since the last refSlot, the current value otherwise
    /// @dev reverts if the cache was overwritten after target refSlot
    function getValueForRefSlot(
        Int104WithCache[DOUBLE_CACHE_LENGTH] memory _cache,
        uint48 _refSlot
    ) internal pure returns (int104) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006b0000, 1037618708587) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006b0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006b1000, _cache) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff006b1001, _refSlot) }
        uint256 activeCacheIndex = _activeCacheIndex(_cache);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000141,activeCacheIndex)}

        // 1. refSlot is more than activeRefSlot
        if (_refSlot > _cache[activeCacheIndex].refSlot) {
            return _cache[activeCacheIndex].value;
        }

        uint256 previousCacheIndex = 1 - activeCacheIndex;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000142,previousCacheIndex)}
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

    /// @dev There is a limitation on the refSlot value: it must be less than 2^48.
    /// If it exceeds this limit, the refSlot will be truncated to 48 bits.
    /// _activeCacheIndex may work incorrectly if one refSlot value is truncated and the other is not,
    /// because the non-truncated value will always be greater than the truncated one,
    /// causing incorrect activeIndex determination. However, 2^48 is a very large number,
    /// so if block time will be 1 second, it will take 8_925_512 years to reach this limit.
    function _activeCacheIndex(Int104WithCache[DOUBLE_CACHE_LENGTH] memory _cache) private pure returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00690000, 1037618708585) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00690001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00691000, _cache) }
        return _cache[0].refSlot >= _cache[1].refSlot ? 0 : 1;
    }

    error InOutDeltaCacheIsOverwritten();
}
