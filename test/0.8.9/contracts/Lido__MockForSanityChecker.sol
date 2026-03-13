// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract Lido__MockForSanityChecker {
    uint256 public clValidatorsBalance;
    uint256 public clPendingBalance;
    uint256 public depositedBalance;
    uint256 public contractVersion;

    function mock__setBalanceStats(
        uint256 _clValidatorsBalance,
        uint256 _clPendingBalance,
        uint256 _depositedBalance
    ) external {
        clValidatorsBalance = _clValidatorsBalance;
        clPendingBalance = _clPendingBalance;
        depositedBalance = _depositedBalance;
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
            uint256 depositedSinceLastReport
        )
    {
        clValidatorsBalanceAtLastReport = clValidatorsBalance;
        clPendingBalanceAtLastReport = clPendingBalance;
        depositedSinceLastReport = depositedBalance;
    }

    function getContractVersion() external view returns (uint256) {
        return contractVersion;
    }
}
