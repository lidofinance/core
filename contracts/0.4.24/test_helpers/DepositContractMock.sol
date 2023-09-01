// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.4.24;



/**
  * @dev This is a mock. Don't use in production.
  */
contract DepositContractMock {
    struct Call {
        bytes pubkey;
        bytes withdrawal_credentials;
        bytes signature;
        bytes32 deposit_data_root;
        uint256 value;
    }

    Call[] public calls;
    bytes32 internal depositRoot;

    function deposit(
        bytes /* 48 */ pubkey,
        bytes /* 32 */ withdrawal_credentials,
        bytes /* 96 */ signature,
        bytes32 deposit_data_root
    )
        external
        payable
    {
        calls.push(Call(pubkey, withdrawal_credentials, signature, deposit_data_root, msg.value));
    }

    function totalCalls() external view returns (uint256) {
        return calls.length;
    }

    function reset() external {
        calls.length = 0;
    }

    function get_deposit_root() external view returns (bytes32) {
        return depositRoot;
    }

    function set_deposit_root(bytes32 _newRoot) external {
        depositRoot = _newRoot;
    }
}
