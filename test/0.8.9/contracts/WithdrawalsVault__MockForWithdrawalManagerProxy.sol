// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract WithdrawalsVault__MockForWithdrawalManagerProxy {
    function mock__changeNumber(uint256 someNumber) external {
        bytes32 slot = keccak256("someNumberSlot");

        // solhint-disable-next-line no-inline-assembly
        assembly {
            sstore(slot, someNumber)
        }
    }
}
