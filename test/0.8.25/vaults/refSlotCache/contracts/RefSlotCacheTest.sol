// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {RefSlotCache} from "contracts/0.8.25/vaults/lib/RefSlotCache.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";

contract RefSlotCacheTest {
    using RefSlotCache for RefSlotCache.Uint112WithRefSlotCache;
    using RefSlotCache for RefSlotCache.Int112WithRefSlotCache;

    RefSlotCache.Uint112WithRefSlotCache public uintCacheStorage;
    RefSlotCache.Int112WithRefSlotCache public intCacheStorage;

    IHashConsensus public consensus;

    constructor(IHashConsensus _consensus) {
        consensus = _consensus;
    }

    function setConsensus(IHashConsensus _consensus) external {
        consensus = _consensus;
    }

    // Uint112 functions
    function increaseUintValue(uint112 increment) external returns (RefSlotCache.Uint112WithRefSlotCache memory) {
        RefSlotCache.Uint112WithRefSlotCache memory newStorage = uintCacheStorage.withValueIncrease(
            consensus,
            increment
        );
        uintCacheStorage = newStorage;
        return newStorage;
    }

    function getUintValueForLastRefSlot() external view returns (uint112) {
        return uintCacheStorage.getValueForLastRefSlot(consensus);
    }

    function getUintCacheStorage() external view returns (RefSlotCache.Uint112WithRefSlotCache memory) {
        return uintCacheStorage;
    }

    function setUintCacheStorage(uint112 value, uint112 valueOnRefSlot, uint32 refSlot) external {
        uintCacheStorage.value = value;
        uintCacheStorage.valueOnRefSlot = valueOnRefSlot;
        uintCacheStorage.refSlot = refSlot;
    }

    // Int112 functions
    function increaseIntValue(int112 increment) external returns (RefSlotCache.Int112WithRefSlotCache memory) {
        RefSlotCache.Int112WithRefSlotCache memory newStorage = intCacheStorage.withValueIncrease(consensus, increment);
        intCacheStorage = newStorage;
        return newStorage;
    }

    function getIntValueForLastRefSlot() external view returns (int112) {
        return intCacheStorage.getValueForLastRefSlot(consensus);
    }

    function getIntCacheStorage() external view returns (RefSlotCache.Int112WithRefSlotCache memory) {
        return intCacheStorage;
    }

    function setIntCacheStorage(int112 value, int112 valueOnRefSlot, uint32 refSlot) external {
        intCacheStorage.value = value;
        intCacheStorage.valueOnRefSlot = valueOnRefSlot;
        intCacheStorage.refSlot = refSlot;
    }
}
