// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

contract WithdrawalVault__MockForLidoHandleOracleReport {
    event Mock__WithdrawalsWithdrawn();

    function withdrawWithdrawals(uint256 _amount) external {
        _amount;

        // emitting mock event to test that the function was in fact called
        emit Mock__WithdrawalsWithdrawn();
    }
}
