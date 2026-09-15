// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

interface ILido {
    /**
     * @notice A payable function supposed to be called only by WithdrawalVault contract
     * @dev We need a dedicated function because funds received by the default payable function
     * are treated as a user deposit
     */
    function receiveWithdrawals() external payable;

    /**
      * @notice A payable function supposed to be called only by LidoExecLayerRewardsVault contract
      * @dev We need a dedicated function because funds received by the default payable function
      * are treated as a user deposit
      */
    function receiveELRewards() external payable;
}

contract NativeTransferFuncs {

    ILido public LIDO;

    function withdrawRewards(uint256 amount) external returns (uint256) {
        LIDO.receiveELRewards{value: amount}();
        return amount;
    }

    function withdrawWithdrawals(uint256 amount) public {
        LIDO.receiveWithdrawals{value: amount}();
    }

    function finalize(uint256 _lastIdToFinalize, uint256 _maxShareRate) external payable {
    }
}
