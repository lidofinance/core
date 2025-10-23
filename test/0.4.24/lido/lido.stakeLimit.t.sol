// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.4.24;

import {StakeLimitState, StakeLimitUtils} from "contracts/0.4.24/lib/StakeLimitUtils.sol";

import {console} from "forge-std/console.sol";

/// @notice Interface to interact with testing framework cheatcodes (e.g., Foundry, DappTools).
/// @dev In older Solidity versions, this is how you access vm/hevm functions.
interface Vm {
    function roll(uint256 blockNumber) external;
    function assume(bool condition) external;
}

contract StakeUtilsTest {
    using StakeLimitUtils for StakeLimitState.Data;

    // Standard address for the cheatcode contract in Foundry/DappTools.
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    StakeLimitUtils__Harness public stakeLimitUtils;

    function setUp() public {
        stakeLimitUtils = new StakeLimitUtils__Harness();
    }

    uint256 private constant MAX_STAKE_LIMIT_GROWTH_BLOCKS = 1000;

    function mint(uint256 amount) public {
        uint256 limit = stakeLimitUtils.calculateCurrentStakeLimit();
        stakeLimitUtils.updatePrevStakeLimit(limit - amount);
    }

    function burn(uint256 amount) public {
        uint256 limit = stakeLimitUtils.calculateCurrentStakeLimit();
        stakeLimitUtils.updatePrevStakeLimit(limit + amount);
    }

    function testFuzz_calculateCurrentStakeLimit(
        uint96 maxStakeLimit,
        uint16 maxStakeLimitGrowthBlocks,
        uint96[200] memory amounts
    ) public {
        stakeLimitUtils.harness_setState(0, maxStakeLimit, maxStakeLimitGrowthBlocks, maxStakeLimit);

        uint256 limitBefore = stakeLimitUtils.calculateCurrentStakeLimit();
        assert(limitBefore == maxStakeLimit);

        for (uint256 i = 0; i < 200; i++) {
            uint256 currentLimit = stakeLimitUtils.calculateCurrentStakeLimit();
            // Scale fuzzed amount to reasonable range (1 to currentLimit/2 + 1)
            uint256 amount = (uint256(amounts[i]) % (currentLimit / 2 + 1)) + 1;
            mint(amount);
            burn(amount);

            uint256 limitNow = stakeLimitUtils.calculateCurrentStakeLimit();
            assert(limitNow == maxStakeLimit);
        }

        uint256 limitAfter = stakeLimitUtils.calculateCurrentStakeLimit();
        assert(limitAfter == maxStakeLimit);
    }

    function testFuzz_mintsAndRegrowsCorrectly(
        uint96 maxStakeLimit,
        uint32 maxStakeLimitGrowthBlocks,
        uint96 changeAmount
    ) public {
        vm.assume(maxStakeLimitGrowthBlocks > 0 && maxStakeLimitGrowthBlocks <= 720);
        vm.assume(maxStakeLimit > maxStakeLimitGrowthBlocks); // to avoid 0 growth per block
        vm.assume(changeAmount > 0 && changeAmount <= maxStakeLimit);

        vm.roll(1);
        stakeLimitUtils.harness_setState(uint32(block.number), maxStakeLimit, maxStakeLimitGrowthBlocks, maxStakeLimit);
        uint256 stakeLimitChangePerBlock = maxStakeLimit / maxStakeLimitGrowthBlocks;

        // Initial limit is max
        uint256 actualLimit = stakeLimitUtils.calculateCurrentStakeLimit();
        assert(actualLimit == maxStakeLimit);

        // Mint
        mint(changeAmount);

        // Limit after mint is correct
        uint256 limitAfterMint = stakeLimitUtils.calculateCurrentStakeLimit();
        assert(limitAfterMint == maxStakeLimit - changeAmount);

        // Advance time to check if growth resumes correctly.
        vm.roll(block.number + 1);
        uint256 expectedLimit = limitAfterMint + stakeLimitChangePerBlock;
        if (expectedLimit > maxStakeLimit) {
            expectedLimit = maxStakeLimit;
        }

        uint256 limitAfterGrowth = stakeLimitUtils.calculateCurrentStakeLimit();
        assert(limitAfterGrowth == expectedLimit);

        // Advance time far into the future to ensure the limit fully recovers.
        vm.roll(block.number + maxStakeLimitGrowthBlocks * 2);
        uint256 limitAfterFutureGrowth = stakeLimitUtils.calculateCurrentStakeLimit();
        assert(limitAfterFutureGrowth == maxStakeLimit);
    }

    function testFuzz_burnsAndRegrowsCorrectly(
        uint96 maxStakeLimit,
        uint32 maxStakeLimitGrowthBlocks,
        uint96 changeAmount
    ) public {
        vm.assume(maxStakeLimitGrowthBlocks > 0 && maxStakeLimitGrowthBlocks <= 720);
        vm.assume(maxStakeLimit > maxStakeLimitGrowthBlocks); // to avoid 0 growth per block
        vm.assume(changeAmount > 0 && changeAmount <= maxStakeLimit);

        vm.roll(1);
        stakeLimitUtils.harness_setState(uint32(block.number), maxStakeLimit, maxStakeLimitGrowthBlocks, maxStakeLimit);

        // Initial limit is max
        uint256 actualLimit = stakeLimitUtils.calculateCurrentStakeLimit();
        assert(actualLimit == maxStakeLimit);

        // Burn
        burn(changeAmount);

        // Limit after burn is correct
        uint256 limitAfterBurn = stakeLimitUtils.calculateCurrentStakeLimit();
        assert(limitAfterBurn == maxStakeLimit + changeAmount);

        // Advance time far into the future to ensure the limit fully recovers.
        vm.roll(block.number + maxStakeLimitGrowthBlocks * 2);
        uint256 limitAfterFutureGrowth = stakeLimitUtils.calculateCurrentStakeLimit();
        assert(limitAfterFutureGrowth == maxStakeLimit);
    }

    /// @notice Test edge case where maxStakeLimitGrowthBlocks is zero.
    function test_zeroGrowthBlocksPreventsGrowth(uint96 initialStake, uint96 maxStakeLimit) public {
        vm.assume(maxStakeLimit > initialStake);
        vm.roll(1);
        stakeLimitUtils.harness_setState(uint32(block.number), initialStake, 0, maxStakeLimit);

        vm.roll(block.number + 1000);

        uint256 actualLimit = stakeLimitUtils.calculateCurrentStakeLimit();
        assert(actualLimit == initialStake);
    }
}

contract StakeLimitUtils__Harness {
    using StakeLimitUtils for StakeLimitState.Data;

    StakeLimitState.Data public state;

    event DataSet(
        uint32 prevStakeBlockNumber,
        uint96 prevStakeLimit,
        uint32 maxStakeLimitGrowthBlocks,
        uint96 maxStakeLimit
    );

    event PrevStakeLimitUpdated(uint256 newPrevStakeLimit);

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

    function calculateCurrentStakeLimit() external view returns (uint256 limit) {
        limit = state.calculateCurrentStakeLimit();
    }

    function updatePrevStakeLimit(uint256 _newPrevStakeLimit) external {
        state.prevStakeLimit = uint96(_newPrevStakeLimit);
        state.prevStakeBlockNumber = uint32(block.number);

        emit PrevStakeLimitUpdated(_newPrevStakeLimit);
    }
}
