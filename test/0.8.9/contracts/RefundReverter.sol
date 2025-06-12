// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

contract RefundReverter {
    receive() external payable {
        revert("nope");
    }
}
