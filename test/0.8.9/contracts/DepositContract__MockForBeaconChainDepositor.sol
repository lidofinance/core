// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract DepositContract__MockForBeaconChainDepositor {
    event Deposited__MockEvent();

    function deposit(
        bytes calldata pubkey, // 48 bytes
        bytes calldata withdrawal_credentials, // 32 bytes
        bytes calldata signature, // 96 bytes
        bytes32 deposit_data_root
    ) external payable {
        emit Deposited__MockEvent();
    }
}
