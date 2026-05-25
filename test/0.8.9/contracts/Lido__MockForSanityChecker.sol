// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract Lido__MockForSanityChecker {
    uint256 public clValidatorsBalance;
    uint256 public clPendingBalance;
    uint256 public depositedLastReport;
    uint256 public depositedCurrentReport;
    uint256 public contractVersion;

    function mock__setBalanceStats(
        uint256 _clValidatorsBalance,
        uint256 _clPendingBalance,
        uint256 _depositedLastReport,
        uint256 _depositedCurrentReport
    ) external {
        clValidatorsBalance = _clValidatorsBalance;
        clPendingBalance = _clPendingBalance;
        depositedLastReport = _depositedLastReport;
        depositedCurrentReport = _depositedCurrentReport;
    }

    function mock__setContractVersion(uint256 _version) external {
        contractVersion = _version;
    }

    function getBalanceStats()
        external
        view
        returns (
            uint256 clValidatorsBalanceAtLastReport,
            uint256 clPendingBalanceAtLastReport,
            uint256 depositedSinceLastReport,
            uint256 depositedBeforeCurrentReportRefSlot
        )
    {
        clValidatorsBalanceAtLastReport = clValidatorsBalance;
        clPendingBalanceAtLastReport = clPendingBalance;
        depositedSinceLastReport = depositedLastReport;
        depositedBeforeCurrentReportRefSlot = depositedCurrentReport;
    }

    function getContractVersion() external view returns (uint256) {
        return contractVersion;
    }
}
