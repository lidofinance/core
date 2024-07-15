// SPDX-License-Identifier: UNLICENSED
// for test purposes only

pragma solidity 0.4.24;

import {StakeLimitUtils, StakeLimitUnstructuredStorage, StakeLimitState} from "contracts/0.4.24/lib/StakeLimitUtils.sol";

contract StakeLimitUtils__Harness {
    using StakeLimitUtils for StakeLimitState.Data;

    StakeLimitState.Data public state;

    event DataSet(
        uint32 prevStakeBlockNumber,
        uint96 prevStakeLimit,
        uint32 maxStakeLimitGrowthBlocks,
        uint96 maxStakeLimit
    );

    event StakingLimitSet(uint256 maxStakeLimit, uint256 stakeLimitIncreasePerBlock);
    event StakingLimitRemoved();
    event PrevStakeLimitUpdated(uint256 newPrevStakeLimit);
    event StakeLimitPauseStateSet(bool isPaused);

    function harness_setState(
        uint32 _prevStakeBlockNumber,
        uint96 _prevStakeLimit,
        uint32 _maxStakeLimitGrowthBlocks,
        uint96 _maxStakeLimit
    ) external {
        state.prevStakeBlockNumber = _prevStakeBlockNumber;
        state.prevStakeLimit = _prevStakeLimit;
        state.maxStakeLimitGrowthBlocks = _maxStakeLimitGrowthBlocks;
        state.maxStakeLimit = _maxStakeLimit;

        emit DataSet(_prevStakeBlockNumber, _prevStakeLimit, _maxStakeLimitGrowthBlocks, _maxStakeLimit);
    }

    function harness_getState()
    external
    view
    returns (uint32 prevStakeBlockNumber, uint96 prevStakeLimit, uint32 maxStakeLimitGrowthBlocks, uint96 maxStakeLimit)
    {
        prevStakeBlockNumber = state.prevStakeBlockNumber;
        prevStakeLimit = state.prevStakeLimit;
        maxStakeLimitGrowthBlocks = state.maxStakeLimitGrowthBlocks;
        maxStakeLimit = state.maxStakeLimit;
    }

    function calculateCurrentStakeLimit() external view returns (uint256 limit) {
        limit = state.calculateCurrentStakeLimit();
    }

    function isStakingPaused() external view returns (bool) {
        return state.isStakingPaused();
    }

    function setStakingLimit(uint256 _maxStakeLimit, uint256 _stakeLimitIncreasePerBlock) external {
        state = state.setStakingLimit(_maxStakeLimit, _stakeLimitIncreasePerBlock);

        emit StakingLimitSet(_maxStakeLimit, _stakeLimitIncreasePerBlock);
    }

    function removeStakingLimit() external {
        state = state.removeStakingLimit();

        emit StakingLimitRemoved();
    }

    function updatePrevStakeLimit(uint256 _newPrevStakeLimit) external {
        state = state.updatePrevStakeLimit(_newPrevStakeLimit);

        emit PrevStakeLimitUpdated(_newPrevStakeLimit);
    }

    function setStakeLimitPauseState(bool _isPaused) external {
        state = state.setStakeLimitPauseState(_isPaused);

        emit StakeLimitPauseStateSet(_isPaused);
    }

    function constGasMin(uint256 _lhs, uint256 _rhs) external pure returns (uint256 min) {
        min = StakeLimitUtils._constGasMin(_lhs, _rhs);
    }
}
