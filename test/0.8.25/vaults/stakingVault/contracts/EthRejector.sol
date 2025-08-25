// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

contract EthRejector {
    error ReceiveRejected();
    error FallbackRejected();

    receive() external payable {
        revert ReceiveRejected();
    }

    fallback() external payable {
        revert FallbackRejected();
    }
}
