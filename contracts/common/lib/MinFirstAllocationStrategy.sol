// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
// solhint-disable-next-line
pragma solidity >=0.4.24 <0.9.0;

import {Math256} from "./Math256.sol";

/// @notice Library with methods to calculate "proportional" allocations among buckets with different
///     capacity and level of filling.
/// @dev The current implementation favors buckets with the least fill factor
library MinFirstAllocationStrategy {
    uint256 private constant MAX_UINT256 = 2**256 - 1;

    /// @notice Allocates passed maxAllocationSize among the buckets. The resulting allocation doesn't exceed the
    ///     capacities of the buckets. An algorithm starts filling from the least populated buckets to equalize the fill factor.
    ///     For example, for buckets: [9998, 70, 0], capacities: [10000, 101, 100], and maxAllocationSize: 101, the allocation happens
    ///     following way:
    ///         1. top up the bucket with index 2 on 70. Intermediate state of the buckets: [9998, 70, 70]. According to the definition,
    ///            the rest allocation must be proportionally split among the buckets with the same values.
    ///         2. top up the bucket with index 1 on 15. Intermediate state of the buckets: [9998, 85, 70].
    ///         3. top up the bucket with index 2 on 15. Intermediate state of the buckets: [9998, 85, 85].
    ///         4. top up the bucket with index 1 on 1. Nothing to distribute. The final state of the buckets: [9998, 86, 85]
    /// @dev Method modifies the passed buckets array to reduce the gas costs on memory allocation.
    /// @param buckets The array of current allocations in the buckets
    /// @param capacities The array of capacities of the buckets
    /// @param allocationSize The desired value to allocate among the buckets
    /// @return allocated The total value allocated among the buckets. Can't exceed the allocationSize value
    function allocate(
        uint256[] memory buckets,
        uint256[] memory capacities,
        uint256 allocationSize
    ) public pure returns (uint256 allocated, uint256[] memory) {
        uint256 allocatedToBestCandidate = 0;
        while (allocated < allocationSize) {
            allocatedToBestCandidate = allocateToBestCandidate(buckets, capacities, allocationSize - allocated);
            if (allocatedToBestCandidate == 0) {
                break;
            }
            allocated += allocatedToBestCandidate;
        }
        return (allocated, buckets);
    }

    /// @notice Allocates the max allowed value not exceeding allocationSize to the bucket with the least value.
    ///     The candidate search happens according to the following algorithm:
    ///         1. Find the first least filled bucket which has free space. Count the number of such buckets.
    ///         2. If no buckets are found terminate the search - no free buckets
    ///         3. Find the first bucket with free space, which has the least value greater
    ///             than the bucket found in step 1. To preserve proportional allocation the resulting allocation can't exceed this value.
    ///         4. Calculate the allocation size as:
    ///             min(
    ///                 (count of least filling buckets > 1 ? ceilDiv(allocationSize, count of least filling buckets) : allocationSize),
    ///                 fill factor of the bucket found in step 3,
    ///                 free space of the least filled bucket
    ///             )
    /// @dev Method modifies the passed buckets array to reduce the gas costs on memory allocation.
    /// @param buckets The array of current allocations in the buckets
    /// @param capacities The array of capacities of the buckets
    /// @param allocationSize The desired value to allocate to the bucket
    /// @return allocated The total value allocated to the bucket. Can't exceed the allocationSize value
    function allocateToBestCandidate(
        uint256[] memory buckets,
        uint256[] memory capacities,
        uint256 allocationSize
    ) internal pure returns (uint256 allocated) {
        uint256 bestCandidateIndex = buckets.length;
        uint256 bestCandidateAllocation = MAX_UINT256;
        uint256 bestCandidatesCount = 0;

        if (allocationSize == 0) {
            return 0;
        }

        for (uint256 i = 0; i < buckets.length; ++i) {
            if (buckets[i] >= capacities[i]) {
                continue;
            } else if (bestCandidateAllocation > buckets[i]) {
                bestCandidateIndex = i;
                bestCandidatesCount = 1;
                bestCandidateAllocation = buckets[i];
            } else if (bestCandidateAllocation == buckets[i]) {
                bestCandidatesCount += 1;
            }
        }

        if (bestCandidatesCount == 0) {
            return 0;
        }

        // cap the allocation by the smallest larger allocation than the found best one
        uint256 allocationSizeUpperBound = MAX_UINT256;
        for (uint256 j = 0; j < buckets.length; ++j) {
            if (buckets[j] >= capacities[j]) {
                continue;
            } else if (buckets[j] > bestCandidateAllocation && buckets[j] < allocationSizeUpperBound) {
                allocationSizeUpperBound = buckets[j];
            }
        }

        allocated = Math256.min(
            bestCandidatesCount > 1 ? Math256.ceilDiv(allocationSize, bestCandidatesCount) : allocationSize,
            Math256.min(allocationSizeUpperBound, capacities[bestCandidateIndex]) - bestCandidateAllocation
        );
        buckets[bestCandidateIndex] += allocated;
    }
}
