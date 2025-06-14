// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract WithdrawalsManagerProxy__Mock {
    function writeToStorage(bytes32 slot, bytes32 value) external {
        assembly {
            sstore(slot, value)
        }
    }

    event Received();

    receive() external payable {
        emit Received();
    }
}
