// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

interface ILido {
    function receiveWithdrawals() external payable;
}

contract WithdrawalVault__MockForLidoAccounting {
    function withdrawWithdrawals(uint256 _amount) external {
        uint256 balance = address(this).balance;
        _amount = (balance > _amount) ? _amount : balance;
        ILido(msg.sender).receiveWithdrawals{value: _amount}();
    }
}
