// SPDX-License-Identifier: UNLICENSED
// for test purposes only

pragma solidity 0.4.24;

import {StakeLimitUtils, StakeLimitUnstructuredStorage, StakeLimitState} from "contracts/0.4.24/lib/StakeLimitUtils.sol";

contract StakeLimitUtils__HarnessWithStakeLimitUnstructuredStorage {
    using StakeLimitUnstructuredStorage for bytes32;

    bytes32 public constant position = keccak256("test.test.test");

    event DataSet(
        uint32 prevStakeBlockNumber,
        uint96 prevStakeLimit,
        uint32 maxStakeLimitGrowthBlocks,
        uint96 maxStakeLimit
    );

    function getStorageStakeLimit()
    external
    view
    returns (uint32 prevStakeBlockNumber, uint96 prevStakeLimit, uint32 maxStakeLimitGrowthBlocks, uint96 maxStakeLimit)
    {
        StakeLimitState.Data memory stakeLimit = position.getStorageStakeLimitStruct();

        prevStakeBlockNumber = stakeLimit.prevStakeBlockNumber;
        prevStakeLimit = stakeLimit.prevStakeLimit;
        maxStakeLimitGrowthBlocks = stakeLimit.maxStakeLimitGrowthBlocks;
        maxStakeLimit = stakeLimit.maxStakeLimit;
    }

    function setStorageStakeLimit(
        uint32 _prevStakeBlockNumber,
        uint96 _prevStakeLimit,
        uint32 _maxStakeLimitGrowthBlocks,
        uint96 _maxStakeLimit
    ) external {
        StakeLimitState.Data memory stakeLimit = StakeLimitState.Data(
            _prevStakeBlockNumber,
            _prevStakeLimit,
            _maxStakeLimitGrowthBlocks,
            _maxStakeLimit
        );

        position.setStorageStakeLimitStruct(stakeLimit);

        emit DataSet(_prevStakeBlockNumber, _prevStakeLimit, _maxStakeLimitGrowthBlocks, _maxStakeLimit);
    }

    function harness__getStorageStakeLimit()
    external
    view
    returns (uint32 prevStakeBlockNumber, uint96 prevStakeLimit, uint32 maxStakeLimitGrowthBlocks, uint96 maxStakeLimit)
    {
        // the other way around for the tests purposes
        // could have done with calldata slices with a newer solidity versions

        bytes32 _position = position;
        assembly {
            let slot_val := sload(_position) // load whole slot data from storage to memory

            prevStakeBlockNumber := shr(mul(0x00, 8), slot_val)
            prevStakeLimit := shr(mul(0x04, 8), slot_val)
            maxStakeLimitGrowthBlocks := shr(mul(0x10, 8), slot_val)
            maxStakeLimit := shr(mul(0x14, 8), slot_val)
        }
    }

    function harness__setStorageStakeLimit(
        uint32 _prevStakeBlockNumber,
        uint96 _prevStakeLimit,
        uint32 _maxStakeLimitGrowthBlocks,
        uint96 _maxStakeLimit
    ) external {
        bytes memory encoded = abi.encodePacked(
            _maxStakeLimit,
            _maxStakeLimitGrowthBlocks,
            _prevStakeLimit,
            _prevStakeBlockNumber
        );
        // should be a single storage slot length exactly
        assert(encoded.length == 32);

        bytes32 _position = position;
        assembly {
            sstore(_position, mload(add(encoded, 0x20))) // store the value from memory to storage
        }

        emit DataSet(_prevStakeBlockNumber, _prevStakeLimit, _maxStakeLimitGrowthBlocks, _maxStakeLimit);
    }
}
