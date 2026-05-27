// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract Lido__MockForSanityChecker {
    uint256 public reportClValidatorsBalance;
    uint256 public reportClPendingBalance;
    uint256 public depositedEther;
    uint256 public depositedEtherForLastRefSlot;
    uint256 public contractVersion;

    function mock__setBalanceStats(
        uint256 clValidatorsBalance,
        uint256 clPendingBalance,
        uint256 depositedLastReport,
        uint256 depositedCurrentReport
    ) external {
        reportClValidatorsBalance = clValidatorsBalance;
        reportClPendingBalance = clPendingBalance;
        depositedEther = depositedLastReport;
        depositedEtherForLastRefSlot = depositedCurrentReport;
    }

    function mock__setContractVersion(uint256 _version) external {
        contractVersion = _version;
    }

    function getBalanceStats()
        external
        view
        returns (
            uint256 clValidatorsBalance,
            uint256 clPendingBalance,
            uint256 depositedAmount,
            uint256 depositedAmountForLastRefSlot
        )
    {
        clValidatorsBalance = reportClValidatorsBalance;
        clPendingBalance = reportClPendingBalance;
        depositedAmount = depositedEther;
        depositedAmountForLastRefSlot = depositedEtherForLastRefSlot;
    }

    function getContractVersion() external view returns (uint256) {
        return contractVersion;
    }
}
