// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.4.24;

interface IOracleReportSanityChecker {
    function smoothenTokenRebase(
        uint256 _preInternalEther,
        uint256 _preInternalShares,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _etherToLockForWithdrawals,
        uint256 _newSharesToBurnForWithdrawals
    ) external view returns (uint256 withdrawals, uint256 elRewards, uint256 sharesFromWQToBurn, uint256 sharesToBurn);

    //
    function checkAccountingOracleReport(
        uint256 _timeElapsed,
        uint256 _preCLValidatorsBalance,
        uint256 _preCLPendingBalance,
        uint256 _postCLValidatorsBalance,
        uint256 _postCLPendingBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _deposits,
        uint256 _withdrawalsVaultTransfer
    ) external;

    //
    function checkCLPendingBalanceIncrease(
        uint256 _timeElapsed,
        uint256 _preCLValidatorsBalance,
        uint256 _preCLPendingBalance,
        uint256 _postCLValidatorsBalance,
        uint256 _postCLPendingBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _deposits
    ) external view;

    //
    function checkWithdrawalQueueOracleReport(
        uint256 _lastFinalizableRequestId,
        uint256 _reportTimestamp
    ) external view;

    //
    function checkSimulatedShareRate(
        uint256 _postInternalEther,
        uint256 _postInternalShares,
        uint256 _etherToFinalizeWQ,
        uint256 _sharesToBurnForWithdrawals,
        uint256 _simulatedShareRate
    ) external view;
}
