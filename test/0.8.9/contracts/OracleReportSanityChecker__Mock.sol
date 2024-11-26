// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract OracleReportSanityChecker__Mock {
    error SelectorNotFound(bytes4 sig, uint256 value, bytes data);

    fallback() external payable {
        revert SelectorNotFound(msg.sig, msg.value, msg.data);
    }

    function checkAccountingOracleReport(
        uint256 _timeElapsed,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _preCLValidators,
        uint256 _postCLValidators
    ) external view {}

    function checkWithdrawalQueueOracleReport(
        uint256[] calldata _withdrawalFinalizationBatches,
        uint256 _reportTimestamp
    ) external view {}

    function checkSimulatedShareRate(
        uint256 _postTotalPooledEther,
        uint256 _postTotalShares,
        uint256 _etherLockedOnWithdrawalQueue,
        uint256 _sharesBurntDueToWithdrawals,
        uint256 _simulatedShareRate
    ) external view {}

    function smoothenTokenRebase(
        uint256,
        uint256,
        uint256,
        uint256,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256,
        uint256 _etherToLockForWithdrawals,
        uint256
    )
        external
        view
        returns (uint256 withdrawals, uint256 elRewards, uint256 simulatedSharesToBurn, uint256 sharesToBurn)
    {
        withdrawals = _withdrawalVaultBalance;
        elRewards = _elRewardsVaultBalance;

        simulatedSharesToBurn = 0;
        sharesToBurn = _etherToLockForWithdrawals;
    }

    function checkAccountingExtraDataListItemsCount(uint256 _extraDataListItemsCount) external view {}
}
