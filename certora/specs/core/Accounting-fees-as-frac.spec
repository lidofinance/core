/* A single rule for `Accounting` contract

This rule cannot be proven in the standard setup which summarizes
`_calculateTotalProtocolFeeShares`.
*/

using AccountingHarness as _Accounting;

methods {
    // `Accounting`
    function calculateTotalProtocolFeeShares(
        Accounting.ReportValues,
        Accounting.CalculatedValues,
        uint256,
        uint256,
        uint256
    ) external returns (uint256) envfree;
}


/// @dev The unified consensus layer balance, see `Accounting.sol` Line 279
definition unifiedClBalance(
    Accounting.ReportValues report,
    Accounting.CalculatedValues update
) returns mathint = report.clBalance + update.withdrawalsVaultTransfer;


/// @dev Total rewards in this report, see `Accounting.sol` Line 285
definition getTotalRewards(
    Accounting.ReportValues report,
    Accounting.CalculatedValues update
) returns mathint = (
    unifiedClBalance(report, update) - update.principalClBalance + update.elRewardsVaultTransfer
);


/// @dev See `StakingRouter.FEE_PRECISION_POINTS`
definition FEE_PRECISION_POINTS() returns uint256 = 10^20;


/// @title The value of the shares minted as fees is roughly their designated fraction of
/// the total rewards
/// @notice The third assertion was removed as per Lido's acknowledgment in issue #1457
/// that fees can be as low as half the designated fraction in extreme corner cases,
/// which is acceptable as it cannot be exploited and works in favor of stETH holders.
/// See: https://github.com/lidofinance/core/issues/1457
rule feesAreFraction(
    Accounting.ReportValues report,
    Accounting.CalculatedValues update,
    uint256 internalSharesBeforeFees,
    uint256 _totalFee,
    uint256 _feePrecisionPoints,
    uint256 badDebtToInternalize,
    uint256 preInternalEther
) {
    uint256 toMintAsFees = calculateTotalProtocolFeeShares(
        report, update, internalSharesBeforeFees, _totalFee, FEE_PRECISION_POINTS()
    );
    mathint totalRewards = getTotalRewards(report, update);
    require(totalRewards >= 0, "Non-negative rewards");

    require(badDebtToInternalize == 0);
    mathint postInternalShares = internalSharesBeforeFees + toMintAsFees + badDebtToInternalize;
    require(postInternalShares > 0, "Avoid division by zero");

    // See `Accounting.sol` Lines 190--194
    mathint postInternalEther = (
        preInternalEther // `_pre.totalPooledEther - _pre.externalEther`
        + report.clBalance + update.withdrawalsVaultTransfer - update.principalClBalance
        + update.elRewardsVaultTransfer
        - update.etherToFinalizeWQ
    );
    require(postInternalEther == update.postInternalEther, "Ensure correct values");

    mathint feesRounded = (toMintAsFees * update.postInternalEther) / postInternalShares;
    assert(
        // `(totalRewards * _totalFee) / FEE_PRECISION_POINTS() + 1 >= feesRoundedUp`
        totalRewards * _totalFee + FEE_PRECISION_POINTS() >=
        feesRounded * FEE_PRECISION_POINTS(),
        "Fee shares are not worth more than designated fraction rounded down"
    );
    assert(
        toMintAsFees > 0 => (
            totalRewards * _totalFee <= 2 * (feesRounded + 1) * FEE_PRECISION_POINTS()
        ),
        "Fee shares value rounded up are not worth less than half designated fraction"
    );
}


/// @title An example showing that the value of shares minted as fees may be too low,
/// even if there is no bad debt to internalize
rule feesAreTooLowExample(
    Accounting.ReportValues report,
    Accounting.CalculatedValues update,
    uint256 internalSharesBeforeFees,
    uint256 _totalFee,
    uint256 _feePrecisionPoints,
    uint256 preInternalEther
) {
    uint256 toMintAsFees = calculateTotalProtocolFeeShares(
        report, update, internalSharesBeforeFees, _totalFee, FEE_PRECISION_POINTS()
    );
    mathint totalRewards = getTotalRewards(report, update);
    require(totalRewards >= 0, "Non-negative rewards");

    // Note we assume `badDebtToInternalize` is zero in this example
    mathint postInternalShares = internalSharesBeforeFees + toMintAsFees;
    require(postInternalShares > 0, "Avoid division by zero");

    // See `Accounting.sol` Lines 190--194
    mathint postInternalEther = (
        preInternalEther // `_pre.totalPooledEther - _pre.externalEther`
        + report.clBalance + update.withdrawalsVaultTransfer - update.principalClBalance
        + update.elRewardsVaultTransfer
        - update.etherToFinalizeWQ
    );
    require(postInternalEther == update.postInternalEther, "Ensure correct values");

    mathint feesRounded = (toMintAsFees * update.postInternalEther) / postInternalShares;
    satisfy(
        toMintAsFees > 0 && feesRounded > 0 &&
        totalRewards * _totalFee >= 2 * feesRounded * FEE_PRECISION_POINTS() &&
        totalRewards == 10000 &&
        _totalFee >= 100 &&
        preInternalEther == 100000
    );
}
