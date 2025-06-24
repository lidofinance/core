// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.4.24;

contract PostTokenRebaseReceiver__MockForAccounting {
    event Mock__PostTokenRebaseHandled();
    function handlePostTokenRebase(uint256, uint256, uint256, uint256, uint256, uint256, uint256) external {
        emit Mock__PostTokenRebaseHandled();
    }
}
