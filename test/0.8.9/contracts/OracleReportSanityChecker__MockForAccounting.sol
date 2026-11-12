// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract OracleReportSanityChecker__MockForAccounting {
    bool private checkAccountingOracleReportReverts;
    bool private checkWithdrawalQueueOracleReportReverts;
    bool private checkSimulatedShareRateReverts;

    error CheckAccountingOracleReportReverts();
    error CheckWithdrawalQueueOracleReportReverts();
    error CheckSimulatedShareRateReverts();

    function checkAccountingOracleReport(
        uint256, //_timeElapsed,
        uint256, //_preCLValidatorsBalance,
        uint256, //_preCLPendingBalance,
        uint256, //_postCLValidatorsBalance,
        uint256, //_postCLPendingBalance,
        uint256, //_withdrawalVaultBalance,
        uint256, //_elRewardsVaultBalance,
        uint256, //_sharesRequestedToBurn,
        uint256 //_deposits
    ) external view {
        if (checkAccountingOracleReportReverts) revert CheckAccountingOracleReportReverts();
    }

    function checkWithdrawalQueueOracleReport(
        uint256, //_lastFinalizableRequestId,
        uint256 //_reportTimestamp
    ) external view {
        if (checkWithdrawalQueueOracleReportReverts) revert CheckWithdrawalQueueOracleReportReverts();
    }

    function checkSimulatedShareRate(
        uint256, // _postInternalEther,
        uint256, // _postInternalShares,
        uint256, // _etherToFinalizeWithdrawals,
        uint256, // _sharesToBurnFromWithdrawalQueue,
        uint256 // _simulatedShareRate
    ) external view {
        if (checkSimulatedShareRateReverts) revert CheckSimulatedShareRateReverts();
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
}
