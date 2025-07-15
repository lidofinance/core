// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {RefSlotCache, DoubleRefSlotCache, DOUBLE_CACHE_LENGTH} from "contracts/0.8.25/vaults/lib/RefSlotCache.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";

contract RefSlotCacheTest {
    using RefSlotCache for RefSlotCache.Uint112WithCache;
    using DoubleRefSlotCache for DoubleRefSlotCache.Int112WithCache[DOUBLE_CACHE_LENGTH];

    RefSlotCache.Uint112WithCache public uintCacheStorage;
    DoubleRefSlotCache.Int112WithCache[DOUBLE_CACHE_LENGTH] public intCacheStorage;

    IHashConsensus public consensus;

    constructor(IHashConsensus _consensus) {
        consensus = _consensus;
    }

    function setConsensus(IHashConsensus _consensus) external {
        consensus = _consensus;
    }

    // Uint112 functions ------------------------------------------------------------
    // ------------------------------------------------------------------------------

    function increaseUintValue(uint112 increment) external returns (RefSlotCache.Uint112WithCache memory) {
        RefSlotCache.Uint112WithCache memory newStorage = uintCacheStorage.withValueIncrease(consensus, increment);
        uintCacheStorage = newStorage;
        return newStorage;
    }

    function getUintValueForLastRefSlot() external view returns (uint112) {
        return uintCacheStorage.getValueForLastRefSlot(consensus);
    }

    function getUintCacheStorage() external view returns (RefSlotCache.Uint112WithCache memory) {
        return uintCacheStorage;
    }

    function setUintCacheStorage(uint112 value, uint112 valueOnRefSlot, uint32 refSlot) external {
        uintCacheStorage.value = value;
        uintCacheStorage.valueOnRefSlot = valueOnRefSlot;
        uintCacheStorage.refSlot = refSlot;
    }

    // Int112 functions ------------------------------------------------------------
    // -----------------------------------------------------------------------------

    function increaseIntValue(
        int112 increment
    ) external returns (DoubleRefSlotCache.Int112WithCache[DOUBLE_CACHE_LENGTH] memory) {
        DoubleRefSlotCache.Int112WithCache[DOUBLE_CACHE_LENGTH] memory newStorage = intCacheStorage.withValueIncrease(
            consensus,
            increment
        );
        intCacheStorage = newStorage;
        return newStorage;
    }

    function getIntCurrentValue() external view returns (int112) {
        return intCacheStorage.currentValue();
    }

    function getIntValueForRefSlot(uint256 refSlot) external view returns (int112) {
        return intCacheStorage.getValueForRefSlot(uint32(refSlot));
    }

    function getIntCacheStorage()
        external
        view
        returns (DoubleRefSlotCache.Int112WithCache[DOUBLE_CACHE_LENGTH] memory)
    {
        return intCacheStorage;
    }

    function setIntCacheStorage(int112 value, int112 valueOnRefSlot, uint32 refSlot) external {
        intCacheStorage[0].value = value;
        intCacheStorage[0].valueOnRefSlot = valueOnRefSlot;
        intCacheStorage[0].refSlot = refSlot;
        intCacheStorage[1].value = 0;
        intCacheStorage[1].valueOnRefSlot = 0;
        intCacheStorage[1].refSlot = 0;
    }
}
