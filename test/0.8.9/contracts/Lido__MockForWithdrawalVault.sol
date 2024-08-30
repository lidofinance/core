// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

interface IWithdrawalVault {
    function withdrawWithdrawals(uint256 _amount) external;
}

contract Lido__MockForWithdrawalVault {
    event WithdrawalsReceived(uint256 amount);

    function receiveWithdrawals() external payable {
        emit WithdrawalsReceived(msg.value);
    }

    function mock_withdrawFromVault(address vault, uint256 _amount) external {
        IWithdrawalVault(vault).withdrawWithdrawals(_amount);
    }
}
