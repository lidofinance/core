// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.4.24 <0.9.0;

import {Test} from "forge-std/Test.sol";

import {Math256} from "contracts/common/lib/Math256.sol";

import {MinFirstAllocationStrategy} from "contracts/common/lib/MinFirstAllocationStrategy.sol";

contract MinFirstAllocationStrategyInvariants is Test {
    uint256 private constant MAX_BUCKETS_COUNT = 32;
    uint256 private constant MAX_BUCKET_VALUE = 8192;
    uint256 private constant MAX_CAPACITY_VALUE = 8192;
    uint256 private constant MAX_ALLOCATION_SIZE = 1024;

    MinFirstAllocationStrategyBase internal handler;
    MinFirstAllocationStrategy__Harness internal harness;

    function setUp() external {
        handler = new MinFirstAllocationStrategyAllocateHandler();
        harness = new MinFirstAllocationStrategy__Harness();
    }

    function test_allocateToBestCandidate_ReturnsZeroWhenAllocationSizeIsZero() public view {
        uint256[] memory buckets = new uint256[](1);
        uint256[] memory capacities = new uint256[](1);
        uint256 allocationSize = 0;

        (uint256 allocated, , ) = harness.allocateToBestCandidate(buckets, capacities, allocationSize);

        assertEq(allocated, 0, "INVALID_ALLOCATED_VALUE");
    }

    function test_allocate_AllocatesIntoSingleLeastFilledBucket() public view {
        uint256[] memory buckets = new uint256[](3);
        uint256[] memory capacities = new uint256[](3);
        uint256 allocationSize = 101;

        buckets[0] = 9998;
        buckets[1] = 70;
        buckets[2] = 0;
        capacities[0] = 10000;
        capacities[1] = 101;
        capacities[2] = 100;

        (uint256 allocated, uint256[] memory newBuckets, ) = harness.allocate(buckets, capacities, allocationSize);

        assertEq(allocated, 101, "INVALID_ALLOCATED_VALUE");

        assertEq(newBuckets[0], 9998, "INVALID_BUCKET_VALUE");
        assertEq(newBuckets[1], 86, "INVALID_BUCKET_VALUE");
        assertEq(newBuckets[2], 85, "INVALID_BUCKET_VALUE");
    }

    /**
     * invariant 1. the allocated value should be equal to the expected output
     *
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 512
     * forge-config: default.invariant.depth = 32
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_AllocatedOutput() public view {
        (, , uint256 allocatedActual) = handler.getActualOutput();
        (, , uint256 allocatedExpected) = handler.getExpectedOutput();

        assertEq(allocatedExpected, allocatedActual, "INVALID_ALLOCATED_VALUE");
    }

    /**
     * invariant 2. the bucket values should be equal to the expected output
     *
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 512
     * forge-config: default.invariant.depth = 32
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_BucketsOutput() public view {
        (uint256[] memory bucketsActual, , ) = handler.getActualOutput();
        (uint256[] memory bucketsExpected, , ) = handler.getExpectedOutput();

        for (uint256 i = 0; i < bucketsExpected.length; ++i) {
            assertEq(bucketsExpected[i], bucketsActual[i], "INVALID_ALLOCATED_VALUE");
        }
    }

    /**
     * invariant 3. the bucket value should not exceed the capacity
     *
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 512
     * forge-config: default.invariant.depth = 32
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_AllocatedBucketValuesNotExceedCapacities() public view {
        (uint256[] memory inputBuckets, uint256[] memory inputCapacities, ) = handler.getInput();
        (uint256[] memory buckets, uint256[] memory capacities, ) = handler.getActualOutput();

        for (uint256 i = 0; i < buckets.length; ++i) {
            // when bucket initially overloaded skip it from the check
            if (inputBuckets[i] > inputCapacities[i]) continue;
            assertTrue(buckets[i] <= capacities[i], "BUCKET_VALUE_EXCEEDS_CAPACITY");
        }
    }

    /**
     * invariant 4. the sum of new allocation minus the sum of prev allocation equal to distributed value
     *
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 512
     * forge-config: default.invariant.depth = 32
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_AllocatedMatchesBucketChanges() public view {
        (uint256[] memory inputBuckets, , ) = handler.getInput();
        (uint256[] memory buckets, , uint256 allocated) = handler.getActualOutput();

        uint256 inputSum = 0;
        uint256 outputSum = 0;

        for (uint256 i = 0; i < buckets.length; ++i) {
            inputSum += inputBuckets[i];
            outputSum += buckets[i];
        }

        assertEq(outputSum, inputSum + allocated, "INVALID_BUCKETS_SUM");
    }

    /**
     * invariant 5. the allocated value should be less than or equal to the allocation size
     *
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 512
     * forge-config: default.invariant.depth = 32
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_AllocatedLessThenAllocationSizeOnlyWhenAllBucketsFilled() public view {
        (, , uint256 allocationSize) = handler.getInput();
        (uint256[] memory buckets, uint256[] memory capacities, uint256 allocated) = handler.getActualOutput();

        if (allocationSize == allocated) return;

        for (uint256 i = 0; i < buckets.length; ++i) {
            assertTrue(buckets[i] >= capacities[i], "BUCKET_IS_UNFILLED");
        }
    }
}

contract MinFirstAllocationStrategyBase {
    uint256 public constant MAX_BUCKETS_COUNT = 32;
    uint256 public constant MAX_BUCKET_VALUE = 8192;
    uint256 public constant MAX_CAPACITY_VALUE = 8192;
    uint256 public constant MAX_ALLOCATION_SIZE = 1024;

    struct TestInput {
        uint256[] buckets;
        uint256[] capacities;
        uint256 allocationSize;
    }

    struct TestOutput {
        uint256[] buckets;
        uint256[] capacities;
        uint256 allocated;
    }

    TestInput internal _input;
    TestOutput internal _actual;
    TestOutput internal _expected;

    function getInput()
        external
        view
        returns (uint256[] memory buckets, uint256[] memory capacities, uint256 allocationSize)
    {
        buckets = _input.buckets;
        capacities = _input.capacities;
        allocationSize = _input.allocationSize;
    }

    function getExpectedOutput()
        external
        view
        returns (uint256[] memory buckets, uint256[] memory capacities, uint256 allocated)
    {
        buckets = _expected.buckets;
        capacities = _expected.capacities;
        allocated = _expected.allocated;
    }

    function getActualOutput()
        external
        view
        returns (uint256[] memory buckets, uint256[] memory capacities, uint256 allocated)
    {
        buckets = _actual.buckets;
        capacities = _actual.capacities;
        allocated = _actual.allocated;
    }

    function _fillTestInput(
        uint256[] memory _fuzzBuckets,
        uint256[] memory _fuzzCapacities,
        uint256 _fuzzAllocationSize
    ) internal {
        uint256 bucketsCount = Math256.min(_fuzzBuckets.length, _fuzzCapacities.length) % MAX_BUCKETS_COUNT;
        _input.buckets = new uint256[](bucketsCount);
        _input.capacities = new uint256[](bucketsCount);
        for (uint256 i = 0; i < bucketsCount; ++i) {
            _input.buckets[i] = _fuzzBuckets[i] % MAX_BUCKET_VALUE;
            _input.capacities[i] = _fuzzCapacities[i] % MAX_CAPACITY_VALUE;
        }
        _input.allocationSize = _fuzzAllocationSize % MAX_ALLOCATION_SIZE;
    }
}

contract MinFirstAllocationStrategyAllocateHandler is MinFirstAllocationStrategyBase {
    function allocate(
        uint256[] memory _fuzzBuckets,
        uint256[] memory _fuzzCapacities,
        uint256 _fuzzAllocationSize
    ) public {
        _fillTestInput(_fuzzBuckets, _fuzzCapacities, _fuzzAllocationSize);

        _fillActualAllocateOutput();
        _fillExpectedAllocateOutput();
    }

    function _fillExpectedAllocateOutput() internal {
        uint256[] memory buckets = _input.buckets;
        uint256[] memory capacities = _input.capacities;
        uint256 allocationSize = _input.allocationSize;

        uint256 allocated = NaiveMinFirstAllocationStrategy.allocate(buckets, capacities, allocationSize);

        _expected.allocated = allocated;
        _expected.buckets = buckets;
        _expected.capacities = capacities;
    }

    function _fillActualAllocateOutput() internal {
        uint256[] memory buckets = _input.buckets;
        uint256[] memory capacities = _input.capacities;
        uint256 allocationSize = _input.allocationSize;

        // uint256 allocated = MinFirstAllocationStrategy.allocate(buckets, capacities, allocationSize);
        (_actual.allocated, _actual.buckets) = MinFirstAllocationStrategy.allocate(buckets, capacities, allocationSize);

        // _actual.allocated = allocated;
        // _actual.buckets = buckets;
        _actual.capacities = capacities;
    }
}

contract MinFirstAllocationStrategy__Harness {
    function allocate(
        uint256[] memory _buckets,
        uint256[] memory _capacities,
        uint256 _allocationSize
    ) public pure returns (uint256 allocated, uint256[] memory newBuckets, uint256[] memory newCapacities) {
        (allocated, newBuckets) = MinFirstAllocationStrategy.allocate(_buckets, _capacities, _allocationSize);
        // newBuckets = _buckets;
        newCapacities = _capacities;
    }

    function allocateToBestCandidate(
        uint256[] memory _buckets,
        uint256[] memory _capacities,
        uint256 _allocationSize
    ) public pure returns (uint256 allocated, uint256[] memory newBuckets, uint256[] memory newCapacities) {
        allocated = MinFirstAllocationStrategy.allocateToBestCandidate(_buckets, _capacities, _allocationSize);
        newBuckets = _buckets;
        newCapacities = _capacities;
    }
}

library NaiveMinFirstAllocationStrategy {
    uint256 private constant MAX_UINT256 = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

    function allocate(
        uint256[] memory buckets,
        uint256[] memory capacities,
        uint256 allocationSize
    ) internal pure returns (uint256 allocated) {
        while (allocated < allocationSize) {
            uint256 bestCandidateIndex = MAX_UINT256;
            uint256 bestCandidateAllocation = MAX_UINT256;
            for (uint256 i = 0; i < buckets.length; ++i) {
                if (buckets[i] >= capacities[i]) continue;
                if (buckets[i] < bestCandidateAllocation) {
                    bestCandidateAllocation = buckets[i];
                    bestCandidateIndex = i;
                }
            }
            if (bestCandidateIndex == MAX_UINT256) break;
            buckets[bestCandidateIndex] += 1;
            allocated += 1;
        }
    }
}
