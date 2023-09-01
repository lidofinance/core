// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {MinFirstAllocationStrategy} from "../../common/lib/MinFirstAllocationStrategy.sol";

contract MinFirstAllocationStrategyConsumerMockModernVersion {
    function allocate(
        uint256[] memory allocations,
        uint256[] memory capacities,
        uint256 maxAllocationSize
    ) external pure returns (uint256 allocated, uint256[] memory newAllocations) {
        allocated = MinFirstAllocationStrategy.allocate(allocations, capacities, maxAllocationSize);
        newAllocations = allocations;
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
