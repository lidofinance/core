// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract SecondOpinionOracle__Mock {
    bool private success;
    uint256 private clBalanceGwei;
    uint256 private withdrawalVaultBalanceWei;
    uint256 private totalDepositedValidators;
    uint256 private totalExitedValidators;

    function getReport(uint256 refSlot) external view returns (bool, uint256, uint256, uint256, uint256) {
        return (success, clBalanceGwei, withdrawalVaultBalanceWei, totalDepositedValidators, totalExitedValidators);
    }

    function mock__setReportValues(
        bool _success,
        uint256 _clBalanceGwei,
        uint256 _withdrawalVaultBalanceWei,
        uint256 _totalDepositedValidators,
        uint256 _totalExitedValidators
    ) external {
        success = _success;
        clBalanceGwei = _clBalanceGwei;
        withdrawalVaultBalanceWei = _withdrawalVaultBalanceWei;
        totalDepositedValidators = _totalDepositedValidators;
        totalExitedValidators = _totalExitedValidators;
    }
}
