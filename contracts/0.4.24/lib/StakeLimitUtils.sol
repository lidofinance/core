// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.4.24;

import "@aragon/os/contracts/common/UnstructuredStorage.sol";

//
// We need to pack four variables into the same 256bit-wide storage slot
// to lower the costs per each staking request.
//
// As a result, slot's memory aligned as follows:
//
// MSB ------------------------------------------------------------------------------> LSB
// 256____________160_________________________128_______________32_____________________ 0
// |_______________|___________________________|________________|_______________________|
// | maxStakeLimit | maxStakeLimitGrowthBlocks | prevStakeLimit | prevStakeBlockNumber  |
// |<-- 96 bits -->|<---------- 32 bits ------>|<-- 96 bits --->|<----- 32 bits ------->|
//
//
// NB: Internal representation conventions:
//
// - the `maxStakeLimitGrowthBlocks` field above represented as follows:
// `maxStakeLimitGrowthBlocks` = `maxStakeLimit` / `stakeLimitIncreasePerBlock`
//           32 bits                 96 bits               96 bits
//
//
// - the "staking paused" state is encoded by `prevStakeBlockNumber` being zero,
// - the "staking unlimited" state is encoded by `maxStakeLimit` being zero and `prevStakeBlockNumber` being non-zero.
//

/**
* @notice Library for the internal structs definitions
* @dev solidity <0.6 doesn't support top-level structs
* using the library to have a proper namespace
*/
library StakeLimitState {
    /**
      * @dev Internal representation struct (slot-wide)
      */
    struct Data {
        uint32 prevStakeBlockNumber;      // block number of the previous stake submit
        uint96 prevStakeLimit;            // limit value (<= `maxStakeLimit`) obtained on the previous stake submit
        uint32 maxStakeLimitGrowthBlocks; // limit regeneration speed expressed in blocks
        uint96 maxStakeLimit;             // maximum limit value
    }
}

library StakeLimitUnstructuredStorage {
    using UnstructuredStorage for bytes32;

    /// @dev Storage offset for `maxStakeLimit` (bits)
    uint256 internal constant MAX_STAKE_LIMIT_OFFSET = 160;
    /// @dev Storage offset for `maxStakeLimitGrowthBlocks` (bits)
    uint256 internal constant MAX_STAKE_LIMIT_GROWTH_BLOCKS_OFFSET = 128;
    /// @dev Storage offset for `prevStakeLimit` (bits)
    uint256 internal constant PREV_STAKE_LIMIT_OFFSET = 32;
    /// @dev Storage offset for `prevStakeBlockNumber` (bits)
    uint256 internal constant PREV_STAKE_BLOCK_NUMBER_OFFSET = 0;

    /**
    * @dev Read stake limit state from the unstructured storage position
    * @param _position storage offset
    */
    function getStorageStakeLimitStruct(bytes32 _position) internal view returns (StakeLimitState.Data memory stakeLimit) {
        uint256 slotValue = _position.getStorageUint256();

        stakeLimit.prevStakeBlockNumber = uint32(slotValue >> PREV_STAKE_BLOCK_NUMBER_OFFSET);
        stakeLimit.prevStakeLimit = uint96(slotValue >> PREV_STAKE_LIMIT_OFFSET);
        stakeLimit.maxStakeLimitGrowthBlocks = uint32(slotValue >> MAX_STAKE_LIMIT_GROWTH_BLOCKS_OFFSET);
        stakeLimit.maxStakeLimit = uint96(slotValue >> MAX_STAKE_LIMIT_OFFSET);
    }

     /**
    * @dev Write stake limit state to the unstructured storage position
    * @param _position storage offset
    * @param _data stake limit state structure instance
    */
    function setStorageStakeLimitStruct(bytes32 _position, StakeLimitState.Data memory _data) internal {
        _position.setStorageUint256(
            uint256(_data.prevStakeBlockNumber) << PREV_STAKE_BLOCK_NUMBER_OFFSET
                | uint256(_data.prevStakeLimit) << PREV_STAKE_LIMIT_OFFSET
                | uint256(_data.maxStakeLimitGrowthBlocks) << MAX_STAKE_LIMIT_GROWTH_BLOCKS_OFFSET
                | uint256(_data.maxStakeLimit) << MAX_STAKE_LIMIT_OFFSET
        );
    }
}

/**
* @notice Interface library with helper functions to deal with stake limit struct in a more high-level approach.
*/
library StakeLimitUtils {
    /**
    * @notice Calculate stake limit for the current block.
    * @dev using `_constGasMin` to make gas consumption independent of the current block number
    */
    function calculateCurrentStakeLimit(StakeLimitState.Data memory _data) internal view returns(uint256 limit) {
        uint256 stakeLimitIncPerBlock;
        if (_data.maxStakeLimitGrowthBlocks != 0) {
            stakeLimitIncPerBlock = _data.maxStakeLimit / _data.maxStakeLimitGrowthBlocks;
        }

        uint256 blocksPassed = block.number - _data.prevStakeBlockNumber;
        uint256 projectedLimit = _data.prevStakeLimit + blocksPassed * stakeLimitIncPerBlock;

        limit = _constGasMin(
            projectedLimit,
            _data.maxStakeLimit
        );
    }

    /**
    * @notice check if staking is on pause
    */
    function isStakingPaused(StakeLimitState.Data memory _data) internal pure returns(bool) {
        return _data.prevStakeBlockNumber == 0;
    }

    /**
    * @notice check if staking limit is set (otherwise staking is unlimited)
    */
    function isStakingLimitSet(StakeLimitState.Data memory _data) internal pure returns(bool) {
        return _data.maxStakeLimit != 0;
    }

    /**
    * @notice update stake limit repr with the desired limits
    * @dev input `_data` param is mutated and the func returns effectively the same pointer
    * @param _data stake limit state struct
    * @param _maxStakeLimit stake limit max value
    * @param _stakeLimitIncreasePerBlock stake limit increase (restoration) per block
    */
    function setStakingLimit(
        StakeLimitState.Data memory _data,
        uint256 _maxStakeLimit,
        uint256 _stakeLimitIncreasePerBlock
    ) internal view returns (StakeLimitState.Data memory) {
        require(_maxStakeLimit != 0, "ZERO_MAX_STAKE_LIMIT");
        require(_maxStakeLimit <= uint96(-1), "TOO_LARGE_MAX_STAKE_LIMIT");
        require(_maxStakeLimit >= _stakeLimitIncreasePerBlock, "TOO_LARGE_LIMIT_INCREASE");
        require(
            (_stakeLimitIncreasePerBlock == 0)
            || (_maxStakeLimit / _stakeLimitIncreasePerBlock <= uint32(-1)),
            "TOO_SMALL_LIMIT_INCREASE"
        );

        // reset prev stake limit to the new max stake limit if
        if (
            // staking was paused or
            _data.prevStakeBlockNumber == 0 ||
            // staking was unlimited or
            _data.maxStakeLimit == 0 ||
            // new maximum limit value is lower than the value obtained on the previous stake submit
            _maxStakeLimit < _data.prevStakeLimit
        ) {
            _data.prevStakeLimit = uint96(_maxStakeLimit);
        }
        _data.maxStakeLimitGrowthBlocks =
            _stakeLimitIncreasePerBlock != 0 ? uint32(_maxStakeLimit / _stakeLimitIncreasePerBlock) : 0;

        _data.maxStakeLimit = uint96(_maxStakeLimit);

        if (_data.prevStakeBlockNumber != 0) {
            _data.prevStakeBlockNumber = uint32(block.number);
        }

        return _data;
    }

    /**
    * @notice update stake limit repr to remove the limit
    * @dev input `_data` param is mutated and the func returns effectively the same pointer
    * @param _data stake limit state struct
    */
    function removeStakingLimit(
        StakeLimitState.Data memory _data
    ) internal pure returns (StakeLimitState.Data memory) {
        _data.maxStakeLimit = 0;

        return _data;
    }

    /**
    * @notice update stake limit repr after submitting user's eth
    * @dev input `_data` param is mutated and the func returns effectively the same pointer
    * @param _data stake limit state struct
    * @param _newPrevStakeLimit new value for the `prevStakeLimit` field
    */
    function updatePrevStakeLimit(
        StakeLimitState.Data memory _data,
        uint256 _newPrevStakeLimit
    ) internal view returns (StakeLimitState.Data memory) {
        assert(_newPrevStakeLimit <= uint96(-1));
        assert(_data.prevStakeBlockNumber != 0);

        _data.prevStakeLimit = uint96(_newPrevStakeLimit);
        _data.prevStakeBlockNumber = uint32(block.number);

        return _data;
    }

    /**
    * @notice set stake limit pause state (on or off)
    * @dev input `_data` param is mutated and the func returns effectively the same pointer
    * @param _data stake limit state struct
    * @param _isPaused pause state flag
    */
    function setStakeLimitPauseState(
        StakeLimitState.Data memory _data,
        bool _isPaused
    ) internal view returns (StakeLimitState.Data memory) {
        _data.prevStakeBlockNumber = uint32(_isPaused ? 0 : block.number);

        return _data;
    }

    /**
     * @notice find a minimum of two numbers with a constant gas consumption
     * @dev doesn't use branching logic inside
     * @param _lhs left hand side value
     * @param _rhs right hand side value
     */
    function _constGasMin(uint256 _lhs, uint256 _rhs) internal pure returns (uint256 min) {
        uint256 lhsIsLess;
        assembly {
            lhsIsLess := lt(_lhs, _rhs) // lhsIsLess = (_lhs < _rhs) ? 1 : 0
        }
        min = (_lhs * lhsIsLess) + (_rhs * (1 - lhsIsLess));
    }
}
