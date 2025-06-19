// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

contract DepositContract__MockForVaultHub {
    event DepositEvent(bytes pubkey, bytes withdrawal_credentials, bytes signature, bytes32 deposit_data_root);

    function deposit(
        bytes calldata pubkey, // 48 bytes
        bytes calldata withdrawal_credentials, // 32 bytes
        bytes calldata signature, // 96 bytes
        bytes32 deposit_data_root
    ) external payable {
        emit DepositEvent(pubkey, withdrawal_credentials, signature, deposit_data_root);
    }
}
