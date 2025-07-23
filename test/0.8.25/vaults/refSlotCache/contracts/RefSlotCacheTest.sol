// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {RefSlotCache, DoubleRefSlotCache, DOUBLE_CACHE_LENGTH} from "contracts/0.8.25/vaults/lib/RefSlotCache.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";

contract RefSlotCacheTest {
    using RefSlotCache for RefSlotCache.Uint104WithCache;
    using DoubleRefSlotCache for DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH];

    RefSlotCache.Uint104WithCache public uintCacheStorage;
    DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] public intCacheStorage;

    IHashConsensus public consensus;

    constructor(IHashConsensus _consensus) {
        consensus = _consensus;
    }

    function setConsensus(IHashConsensus _consensus) external {
        consensus = _consensus;
    }

    // Uint104 functions ------------------------------------------------------------
    // ------------------------------------------------------------------------------

    function increaseUintValue(uint104 increment) external returns (RefSlotCache.Uint104WithCache memory) {
        RefSlotCache.Uint104WithCache memory newStorage = uintCacheStorage.withValueIncrease(consensus, increment);
        uintCacheStorage = newStorage;
        return newStorage;
    }

    function getUintValueForLastRefSlot() external view returns (uint104) {
        return uintCacheStorage.getValueForLastRefSlot(consensus);
    }

    function getUintCacheStorage() external view returns (RefSlotCache.Uint104WithCache memory) {
        return uintCacheStorage;
    }

    function setUintCacheStorage(uint104 value, uint104 valueOnRefSlot, uint48 refSlot) external {
        uintCacheStorage.value = value;
        uintCacheStorage.valueOnRefSlot = valueOnRefSlot;
        uintCacheStorage.refSlot = refSlot;
    }

    // Int104 functions ------------------------------------------------------------
    // -----------------------------------------------------------------------------

    function increaseIntValue(
        int104 increment
    ) external returns (DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory) {
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory newStorage = intCacheStorage.withValueIncrease(
            consensus,
            increment
        );
        intCacheStorage = newStorage;
        return newStorage;
    }

    function getIntCurrentValue() external view returns (int104) {
        return intCacheStorage.currentValue();
    }

    function getIntValueForRefSlot(uint256 refSlot) external view returns (int104) {
        return intCacheStorage.getValueForRefSlot(uint48(refSlot));
    }

    function getIntCacheStorage()
        external
        view
        returns (DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory)
    {
        return intCacheStorage;
    }

    function setIntCacheStorage(int104 value, int104 valueOnRefSlot, uint48 refSlot) external {
        intCacheStorage[0].value = value;
        intCacheStorage[0].valueOnRefSlot = valueOnRefSlot;
        intCacheStorage[0].refSlot = refSlot;
        intCacheStorage[1].value = 0;
        intCacheStorage[1].valueOnRefSlot = 0;
        intCacheStorage[1].refSlot = 0;
    }
}
