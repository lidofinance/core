// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

interface IStakingVault {
    function nodeOperator() external view returns (address);
}

contract StalingVault__MockForOperatorGrid is IStakingVault {
    address private nodeOp;

    constructor(address _operator) {
        nodeOp = _operator;
    }

    function nodeOperator() external view returns (address) {
        return nodeOp;
    }
}
