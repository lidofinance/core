// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

interface ILido {
    function receiveELRewards() external payable;
}

contract LidoExecutionLayerRewardsVault__MockForLidoAccounting {
    function withdrawRewards(uint256 _maxAmount) external returns (uint256 amount) {
        uint256 balance = address(this).balance;

        amount = (balance > _maxAmount) ? _maxAmount : balance;

        ILido(msg.sender).receiveELRewards{value: amount}();

        return amount;
    }
}
