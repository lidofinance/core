// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

interface IStakingVault {
    function nodeOperator() external view returns (address);
}

contract StakingVault__MockForOperatorGrid is IStakingVault {
    address private nodeOp;
    address private owner_;

    constructor(address _owner, address _operator) {
        owner_ = _owner;
        nodeOp = _operator;
    }

    function nodeOperator() external view returns (address) {
        return nodeOp;
    }

    function owner() external view returns (address) {
        return owner_;
    }
}
