// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract StakingVault__MockForConsolidations {
    address public mock__owner;

    function mock__setOwner(address _owner) external {
        mock__owner = _owner;
    }

    function owner() external view returns (address) {
        return mock__owner;
    }
}
