// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {TransientStorage} from "contracts/common/lib/TransientStorage.sol";

library DepositsTempStorage {
    using TransientStorage for bytes32;

    bytes32 private constant OPERATORS = keccak256("lido.DepositsTempStorage.operatorIds");
    bytes32 private constant COUNTS = keccak256("lido.DepositsTempStorage.depositCounts");
    /// need to store operators and allocations
    /// allocations or counts

    function storeOperators(uint256[] memory operators) public {
        OPERATORS.__storeArray(operators);
    }

    function storeCounts(uint256[] memory counts) public {
        COUNTS.__storeArray(counts);
    }

    function storeOperatorCounts(uint256[] memory operators, uint256[] memory counts) public {
        OPERATORS.__storeArray(operators);
        COUNTS.__storeArray(counts);
    }

    function getOperators() public view returns (uint256[] memory operators) {
        return OPERATORS.__readArray();
    }

    function getCounts() public view returns (uint256[] memory operators) {
        return COUNTS.__readArray();
    }

    function getOperatorCounts() public view returns (uint256[] memory operators, uint256[] memory counts) {
        operators = OPERATORS.__readArray();
        counts = COUNTS.__readArray();
    }

    function clearOperators() public {
        OPERATORS.__clearArray();
    }

    function clearCounts() public {
        COUNTS.__clearArray();
    }

    /// @notice Clear all transient storage data at once
    /// @dev Should be called at the end of transactions to maintain composability
    function clearOperatorCounts() public {
        OPERATORS.__clearArray();
        COUNTS.__clearArray();
    }

    /// TODO: need to store {operator_id, module_id} =>  allocations
    /// topUps will be calculated based on IStakingModuleV2.getAllocation(depositAmount,operators,topUpLimits) returns (uint256[] memory allocations) method
    /// topUpLimits - based on keys balances calc sum on each operator
}
