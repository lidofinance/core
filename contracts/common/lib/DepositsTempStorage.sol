// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {TransientSession} from "contracts/common/lib/TransientSession.sol";

library DepositsTempStorage {
    using TransientSession for bytes32;

    bytes32 private constant OPERATORS = keccak256("lido.DepositsTempStorage.operatorIds");
    bytes32 private constant COUNTS = keccak256("lido.DepositsTempStorage.depositCounts");

    modifier _sessionBegin() {
        TransientSession._invalidateSession();
        _;
    }

    modifier _sessionEnd() {
        _;
        TransientSession._invalidateSession();
    }

    /// need to store operators and allocations
    /// allocations or counts

    // function storeOperators(uint256[] memory operators) public {
    //     OPERATORS._storeArray(operators);
    // }

    // function storeCounts(uint256[] memory counts) public {
    //     COUNTS._storeArray(counts);
    // }

    /// @dev store new values from current session
    function storeOperatorCounts(uint256[] memory operators, uint256[] memory counts) public _sessionBegin {
        OPERATORS._storeArray(operators);
        COUNTS._storeArray(counts);
    }

    // function getOperators() public view returns (uint256[] memory operators) {
    //     return OPERATORS._readArray();
    // }

    // function getCounts() public view returns (uint256[] memory operators) {
    //     return COUNTS._readArray();
    // }

    /// @dev read values from current session
    function getOperatorCounts() public view returns (uint256[] memory operators, uint256[] memory counts) {
        operators = OPERATORS._readArray();
        counts = COUNTS._readArray();
    }

    // function clearOperators() public {
    //     OPERATORS._clearArray();
    // }

    // function clearCounts() public {
    //     COUNTS._clearArray();
    // }

    /// @notice Clear all transient storage data at once
    /// @dev Should be called at the end of transactions as it invalidates the session
    function clearOperatorCounts() public _sessionEnd {
        OPERATORS._clearArray();
        COUNTS._clearArray();
    }

    /// TODO: need to store {operator_id, module_id} =>  allocations
    /// topUps will be calculated based on IStakingModuleV2.getAllocation(depositAmount,operators,topUpLimits) returns (uint256[] memory allocations) method
    /// topUpLimits - based on keys balances calc sum on each operator
}
