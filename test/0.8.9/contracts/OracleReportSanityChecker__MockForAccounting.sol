// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract OracleReportSanityChecker__MockForAccounting {
    bool private checkAccountingOracleReportReverts;
    bool private checkWithdrawalQueueOracleReportReverts;

    uint256 private _withdrawals;
    uint256 private _elRewards;
    uint256 private _simulatedSharesToBurn;
    uint256 private _sharesToBurn;

    error CheckAccountingOracleReportReverts();
    error CheckWithdrawalQueueOracleReportReverts();

    function checkAccountingOracleReport(
        uint256, //_timeElapsed,
        uint256, //_preCLBalance,
        uint256, //_postCLBalance,
        uint256, //_withdrawalVaultBalance,
        uint256, //_elRewardsVaultBalance,
        uint256, //_sharesRequestedToBurn,
        uint256, //_preCLValidators,
        uint256 //_postCLValidators
    ) external view {
        if (checkAccountingOracleReportReverts) revert CheckAccountingOracleReportReverts();
    }

    function checkWithdrawalQueueOracleReport(
        uint256, //_lastFinalizableRequestId,
        uint256 //_reportTimestamp
    ) external view {
        if (checkWithdrawalQueueOracleReportReverts) revert CheckWithdrawalQueueOracleReportReverts();
    }

    function smoothenTokenRebase(
        uint256, // _preTotalPooledEther,
        uint256, // _preTotalShares,
        uint256, // _preCLBalance,
        uint256, // _postCLBalance,
        uint256, // _withdrawalVaultBalance,
        uint256, // _elRewardsVaultBalance,
        uint256, // _sharesRequestedToBurn,
        uint256, // _etherToLockForWithdrawals,
        uint256 // _newSharesToBurnForWithdrawals
    )
        external
        view
        returns (uint256 withdrawals, uint256 elRewards, uint256 simulatedSharesToBurn, uint256 sharesToBurn)
    {
        withdrawals = _withdrawals;
        elRewards = _elRewards;
        simulatedSharesToBurn = _simulatedSharesToBurn;
        sharesToBurn = _sharesToBurn;
    }

    // mocking

    function mock__checkAccountingOracleReportReverts(bool reverts) external {
        checkAccountingOracleReportReverts = reverts;
    }

    function mock__checkWithdrawalQueueOracleReportReverts(bool reverts) external {
        checkWithdrawalQueueOracleReportReverts = reverts;
    }

    function mock__smoothenTokenRebaseReturn(
        uint256 withdrawals,
        uint256 elRewards,
        uint256 simulatedSharesToBurn,
        uint256 sharesToBurn
    ) external {
        _withdrawals = withdrawals;
        _elRewards = elRewards;
        _simulatedSharesToBurn = simulatedSharesToBurn;
        _sharesToBurn = sharesToBurn;
    }
}
