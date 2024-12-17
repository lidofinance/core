// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {MinFirstAllocationStrategy} from "contracts/common/lib/MinFirstAllocationStrategy.sol";

contract MinFirstAllocationStrategy__HarnessModern {
    function allocate(
        uint256[] memory allocations,
        uint256[] memory capacities,
        uint256 maxAllocationSize
    ) external pure returns (uint256 allocated, uint256[] memory newAllocations) {
        (allocated, newAllocations) = MinFirstAllocationStrategy.allocate(allocations, capacities, maxAllocationSize);
    }

    function allocateToBestCandidate(
        uint256[] memory allocations,
        uint256[] memory capacities,
        uint256 maxAllocationSize
    ) external pure returns (uint256 allocated, uint256[] memory newAllocations) {
        allocated = MinFirstAllocationStrategy.allocateToBestCandidate(allocations, capacities, maxAllocationSize);
        newAllocations = allocations;
    }
}
