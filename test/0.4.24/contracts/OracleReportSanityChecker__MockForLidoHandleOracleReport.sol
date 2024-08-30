// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

contract OracleReportSanityChecker__MockForLidoHandleOracleReport {
    bool private checkAccountingOracleReportReverts;
    bool private checkWithdrawalQueueOracleReportReverts;
    bool private checkSimulatedShareRateReverts;

    uint256 private _withdrawals;
    uint256 private _elRewards;
    uint256 private _simulatedSharesToBurn;
    uint256 private _sharesToBurn;

    function checkAccountingOracleReport(
        uint256 _timeElapsed,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _preCLValidators,
        uint256 _postCLValidators
    ) external view {
        if (checkAccountingOracleReportReverts) revert();
    }

    function checkWithdrawalQueueOracleReport(
        uint256 _lastFinalizableRequestId,
        uint256 _reportTimestamp
    ) external view {
        if (checkWithdrawalQueueOracleReportReverts) revert();
    }

    function smoothenTokenRebase(
        uint256 _preTotalPooledEther,
        uint256 _preTotalShares,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _etherToLockForWithdrawals,
        uint256 _newSharesToBurnForWithdrawals
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

    function checkSimulatedShareRate(
        uint256 _postTotalPooledEther,
        uint256 _postTotalShares,
        uint256 _etherLockedOnWithdrawalQueue,
        uint256 _sharesBurntDueToWithdrawals,
        uint256 _simulatedShareRate
    ) external view {
        if (checkSimulatedShareRateReverts) revert();
    }

    // mocking

    function mock__checkAccountingOracleReportReverts(bool reverts) external {
        checkAccountingOracleReportReverts = reverts;
    }

    function mock__checkWithdrawalQueueOracleReportReverts(bool reverts) external {
        checkWithdrawalQueueOracleReportReverts = reverts;
    }

    function mock__checkSimulatedShareRateReverts(bool reverts) external {
        checkSimulatedShareRateReverts = reverts;
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
