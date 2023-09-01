// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.4.24;

import "../lib/StakeLimitUtils.sol";

contract StakeLimitUtilsMock {
    using UnstructuredStorage for bytes32;
    using StakeLimitUnstructuredStorage for bytes32;
    using StakeLimitUtils for StakeLimitState.Data;

    bytes32 internal constant STAKING_STATE_POSITION = keccak256("abcdef");

    event StakeLimitValue(
        uint256 currentLimit
    );

    function getStorageStakeLimit(uint256 _slotValue) public view returns (
        uint32 prevStakeBlockNumber,
        uint96 prevStakeLimit,
        uint32 maxStakeLimitGrowthBlocks,
        uint96 maxStakeLimit
    ) {
        STAKING_STATE_POSITION.setStorageUint256(_slotValue);
        StakeLimitState.Data memory data = STAKING_STATE_POSITION.getStorageStakeLimitStruct();

        prevStakeBlockNumber = data.prevStakeBlockNumber;
        prevStakeLimit = data.prevStakeLimit;
        maxStakeLimitGrowthBlocks = data.maxStakeLimitGrowthBlocks;
        maxStakeLimit = data.maxStakeLimit;
    }

    function setStorageStakeLimitStruct(
        uint32 _prevStakeBlockNumber,
        uint96 _prevStakeLimit,
        uint32 _maxStakeLimitGrowthBlocks,
        uint96 _maxStakeLimit
    ) public view returns (uint256 ret) {
        StakeLimitState.Data memory data;
        data.prevStakeBlockNumber = _prevStakeBlockNumber;
        data.prevStakeLimit = _prevStakeLimit;
        data.maxStakeLimitGrowthBlocks = _maxStakeLimitGrowthBlocks;
        data.maxStakeLimit = _maxStakeLimit;

        STAKING_STATE_POSITION.setStorageStakeLimitStruct(data);
        return STAKING_STATE_POSITION.getStorageUint256();
    }

    function calculateCurrentStakeLimit(uint256 _slotValue) public view returns(uint256 limit) {
        STAKING_STATE_POSITION.setStorageUint256(_slotValue);
        return STAKING_STATE_POSITION.getStorageStakeLimitStruct().calculateCurrentStakeLimit();
    }

    function emitCurrentStakeLimit(uint256 _slotValue) public {
        uint256 limit = calculateCurrentStakeLimit(_slotValue);
        emit StakeLimitValue(limit);
    }

    function isStakingPaused(uint256 _slotValue) public view returns(bool) {
        STAKING_STATE_POSITION.setStorageUint256(_slotValue);
        return STAKING_STATE_POSITION.getStorageStakeLimitStruct().isStakingPaused();
    }

    function isStakingLimitSet(uint256 _slotValue) public view returns(bool) {
        STAKING_STATE_POSITION.setStorageUint256(_slotValue);
        return STAKING_STATE_POSITION.getStorageStakeLimitStruct().isStakingLimitSet();
    }

    function setStakingLimit(
        uint256 _slotValue, uint256 _maxStakeLimit, uint256 _stakeLimitIncreasePerBlock
    ) public view returns (uint256) {
        STAKING_STATE_POSITION.setStorageUint256(_slotValue);
        STAKING_STATE_POSITION.setStorageStakeLimitStruct(
            STAKING_STATE_POSITION.getStorageStakeLimitStruct().setStakingLimit(
                _maxStakeLimit, _stakeLimitIncreasePerBlock
            )
        );
        return STAKING_STATE_POSITION.getStorageUint256();
    }

    function removeStakingLimit(uint256 _slotValue) public view returns(uint256) {
        STAKING_STATE_POSITION.setStorageUint256(_slotValue);
        STAKING_STATE_POSITION.setStorageStakeLimitStruct(
            STAKING_STATE_POSITION.getStorageStakeLimitStruct().removeStakingLimit()
        );
        return STAKING_STATE_POSITION.getStorageUint256();
    }

    function updatePrevStakeLimit(uint256 _slotValue, uint256 _newPrevLimit) public view returns(uint256) {
        STAKING_STATE_POSITION.setStorageUint256(_slotValue);
        STAKING_STATE_POSITION.setStorageStakeLimitStruct(
            STAKING_STATE_POSITION.getStorageStakeLimitStruct().updatePrevStakeLimit(_newPrevLimit)
        );
        return STAKING_STATE_POSITION.getStorageUint256();
    }

    function setStakeLimitPauseState(uint256 _slotValue, bool _isPaused) public view returns(uint256) {
        STAKING_STATE_POSITION.setStorageUint256(_slotValue);
        STAKING_STATE_POSITION.setStorageStakeLimitStruct(
            STAKING_STATE_POSITION.getStorageStakeLimitStruct().setStakeLimitPauseState(_isPaused)
        );
        return STAKING_STATE_POSITION.getStorageUint256();
    }
}
