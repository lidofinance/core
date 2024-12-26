// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract DepositContract__Mock {
    event Deposit(
        address sender,
        uint256 amount,
        bytes pubkey,
        bytes withdrawal_credentials,
        bytes signature,
        bytes32 deposit_data_root
    );

    function get_deposit_root() external view returns (bytes32 rootHash) {
        rootHash = keccak256(abi.encode("root"));
    }

    function deposit(
        bytes calldata pubkey,
        bytes calldata withdrawal_credentials,
        bytes calldata signature,
        bytes32 deposit_data_root
    ) external payable {
        emit Deposit(msg.sender, msg.value, pubkey, withdrawal_credentials, signature, deposit_data_root);
    }
}
