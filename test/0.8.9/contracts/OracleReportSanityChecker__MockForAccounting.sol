// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract OracleReportSanityChecker__MockForAccounting {
    bool private checkAccountingOracleReportReverts;
    bool private checkWithdrawalQueueOracleReportReverts;
    bool private checkSimulatedShareRateReverts;
    uint256 private _withdrawals;
    uint256 private _elRewards;
    uint256 private _sharesFromWQToBurn;
    uint256 private _sharesToBurn;

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
        uint256, //_deposits
        uint256 //_withdrawalsVaultTransfer
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
        uint256, // _preInternalEther,
        uint256, // _preInternalShares,
        uint256, // _preCLBalance,
        uint256, // _postCLBalance,
        uint256, // _withdrawalVaultBalance,
        uint256, // _elRewardsVaultBalance,
        uint256, // _sharesRequestedToBurn,
        uint256, // _etherToFinalizeWithdrawals,
        uint256 // _sharesToBurnFromWithdrawalQueue
    ) external view returns (uint256 withdrawals, uint256 elRewards, uint256 sharesFromWQToBurn, uint256 sharesToBurn) {
        withdrawals = _withdrawals;
        elRewards = _elRewards;
        sharesFromWQToBurn = _sharesFromWQToBurn;
        sharesToBurn = _sharesToBurn;
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

    function mock__smoothenTokenRebaseReturn(
        uint256 withdrawals,
        uint256 elRewards,
        uint256 sharesFromWQToBurn,
        uint256 sharesToBurn
    ) external {
        _withdrawals = withdrawals;
        _elRewards = elRewards;
        _sharesFromWQToBurn = sharesFromWQToBurn;
        _sharesToBurn = sharesToBurn;
    }
}
