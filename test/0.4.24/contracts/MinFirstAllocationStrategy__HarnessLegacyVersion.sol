// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {MinFirstAllocationStrategy} from "contracts/common/lib/MinFirstAllocationStrategy.sol";

contract MinFirstAllocationStrategy__HarnessLegacyVersion {
    function allocate(
        uint256[] memory allocations,
        uint256[] memory capacities,
        uint256 maxAllocationSize
    ) public pure returns (uint256 allocated, uint256[] memory newAllocations) {
        (allocated, newAllocations) = MinFirstAllocationStrategy.allocate(allocations, capacities, maxAllocationSize);
    }

    function allocateToBestCandidate(
        uint256[] memory allocations,
        uint256[] memory capacities,
        uint256 maxAllocationSize
    ) public pure returns (uint256 allocated, uint256[] memory newAllocations) {
        allocated = MinFirstAllocationStrategy.allocateToBestCandidate(allocations, capacities, maxAllocationSize);
        newAllocations = allocations;
    }
}
