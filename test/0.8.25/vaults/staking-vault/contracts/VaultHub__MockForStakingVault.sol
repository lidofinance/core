// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

contract VaultHub__MockForStakingVault {
    event Mock__Rebalanced(address indexed vault, uint256 amount);

    function rebalance() external payable {
        emit Mock__Rebalanced(msg.sender, msg.value);
    }
}
