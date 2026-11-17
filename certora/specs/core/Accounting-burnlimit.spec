/* Spec for checking the burn limit (`PositiveTokenRebaseLimiter.getSharesToBurnLimit`) */

import "../common/StakingRouter-summary.spec";
import "../common/lido-storage-ghost.spec";
import "../common/lido-summaries.spec";

using AccountingHarness as _Accounting;
using Burner as _Burner;
using LidoLocator as _LidoLocator;
using OracleReportSanityChecker as _OracleReportSanityChecker;
using WithdrawalQueueMock as _WithdrawalQueue;

methods {
    // `Accounting`
    function AccountingHarness.treasury() external returns (address) envfree;

    function Accounting._calculateTotalProtocolFeeShares(
        Accounting.ReportValues calldata _report,
        Accounting.CalculatedValues memory _update,
        uint256 _internalSharesBeforeFees,
        uint256 _totalFee,
        uint256 _feePrecisionPoints
    ) internal returns (uint256) => CVLcalculateTotalProtocolFeeShares(
        _report, _update, _internalSharesBeforeFees, _totalFee, _feePrecisionPoints
    );

    // `LidoLocator`
    function _.accounting() external => _Accounting expect address;
    function _.burner() external => _Burner expect address;
    function _.lido() external => _Lido expect address;
    function _.withdrawalQueue() external => _WithdrawalQueue expect address;
    function _.vaultHub() external => CONSTANT;
    function _.treasury() external => CONSTANT;
    function _.depositSecurityModule() external => CONSTANT;
    function _.stakingRouter() external => CONSTANT;
    function _.accountingOracle() external => CONSTANT;

    // `IKernel` (`@aragon/os/contracts/kernel/IKernel.sol`) called by `AragonApp`
    function _.hasPermission(address, address, bytes32, bytes) external => NONDET;

    // `VaultHub`
    function _.badDebtToInternalizeAsOfLastRefSlot(
    ) external => badDebtToInternalizeGhost expect uint256;
    function _.decreaseInternalizedBadDebt(uint256) external => NONDET;

    // `OracleReportSanityChecker`
    function _.checkAccountingOracleReport(
        uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) external => DISPATCHER(true);
    function _.checkWithdrawalQueueOracleReport(uint256, uint256) external => DISPATCHER(true);
    function OracleReportSanityChecker.getMaxPositiveTokenRebase(
    ) external returns (uint256) envfree;
    function _.smoothenTokenRebase(
        uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) external => DISPATCHER(true);

    // `AccountingOracle`
    // NOTE Summarizing `getLastProcessingRefSlot` as constant is not sound, but it is
    // fine in this spec
    function _.getLastProcessingRefSlot() external => CONSTANT;

    // `Burner`
    function _.commitSharesToBurn(uint256) external => DISPATCHER(true);
    function _.requestBurnShares(address, uint256) external => DISPATCHER(true);
    function _.getSharesRequestedToBurn() external => DISPATCHER(true);

    // The following is a view function in `@aragon/os/contracts/kernel/Kernel.sol`
    function _.getRecoveryVault() external => NONDET;

    // `ISecondOpinionOracle`
    function _.getReport(uint256) external => NONDET;

    // `IPostTokenRebaseReceiver`
    // This interface has a single function. Its only implementation is in
    // `test/0.4.24/contracts/PostTokenRebaseReceiver__MockForAccounting.sol` where it
    // does nothing apart from emitting an event.
    function _.handlePostTokenRebase(
        uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) external => NONDET;

    // `WithdrawalQueueERC721`
    // NOTE Summarizing `isPaused` and `isBunkerModeActive` as constant is not sound,
    // but it is fine for this particular spec
    function _.isPaused() external => CONSTANT;  // Not implemented in `WithdrawalQueueMock`
    function _.prefinalize(uint256[], uint256) external => DISPATCHER(true);
    function _.isBunkerModeActive() external => CONSTANT;  // Not implemented in `WithdrawalQueueMock`
}

// -- Summary functions --------------------------------------------------------

ghost uint256 badDebtToInternalizeGhost;

definition presicsion() returns mathint = 10^27;

ghost mathint feeRatio {
    axiom feeRatio >= 0 && feeRatio <= presicsion();
}

/// @dev The unified consensus layer balance, see `Accounting.sol` Line 250
definition unifiedClBalance(
    Accounting.ReportValues report,
    Accounting.CalculatedValues update
) returns mathint = report.clBalance + update.withdrawalsVaultTransfer;

/// @dev Total rewards in this report, see `Accounting.sol` Line 256
definition getTotalRewards(
    Accounting.ReportValues report,
    Accounting.CalculatedValues update
) returns mathint = (
    unifiedClBalance(report, update) - update.principalClBalance + update.elRewardsVaultTransfer
);


/// @dev Summary of `Accounting._calculateTotalProtocolFeeShares`
function CVLcalculateTotalProtocolFeeShares(
    Accounting.ReportValues report,
    Accounting.CalculatedValues update,
    uint256 internalSharesBeforeFees,
    uint256 _totalFee,
    uint256 _feePrecisionPoints
) returns uint256 {
    mathint unifiedClBalanceValue = unifiedClBalance(report, update);
    if (unifiedClBalanceValue <= update.principalClBalance) {
        return 0;
    }
    mathint totalRewards = getTotalRewards(report, update);
    mathint feeEther = (totalRewards * _totalFee) / _feePrecisionPoints; // See Accounting Line 260

    require(update.postInternalEther > feeEther, "Avoid division by zero");
    mathint sharesToMintAsFees = (
        (feeEther * internalSharesBeforeFees) / (update.postInternalEther - feeEther)
    );
    return require_uint256(sharesToMintAsFees);
}

// ---- Rules ------------------------------------------------------------------

/// @dev See `PositiveTokenRebaseLimiter.UNLIMITED_REBASE`
definition UNLIMITED_REBASE() returns mathint = max_uint64;

/// @dev See `PositiveTokenRebaseLimiter.LIMITER_PRECISION_BASE`
definition limiterPrecision() returns mathint = 10^9;

rule burnSharesAmountCorrectness(Accounting.ReportValues report) {
    uint256 internalEthPre = _Lido.getInternalEther();
    mathint internalSharesPre = _Lido.getTotalShares() - _Lido.getExternalShares();

    require(internalEthPre == 10000 && internalSharesPre == 100);

    env e;
    Accounting.CalculatedValues update = _Accounting.simulateOracleReport(e, report);

    uint256 postInternalShares = update.postInternalShares;
    uint256 postInternalEther = update.postInternalEther;
    uint256 postTotalPooledEther = update.postTotalPooledEther;
    uint256 postTotalShares = update.postTotalShares;
    uint256 etherToFinalizeWQ = update.etherToFinalizeWQ;
    uint256 sharesToFinalizeWQ = update.sharesToFinalizeWQ;
    uint256 totalSharesToBurn = update.totalSharesToBurn;
    uint256 sharesToMintAsFees = update.sharesToMintAsFees;

    require(
        report.simulatedShareRate <= (postTotalPooledEther * 10^27) / postTotalShares,
        "Assume report.simulatedShareRate is not higher than eventual rate"
    );
    require(totalSharesToBurn < internalSharesPre, "Avoid division by zero in CVL");

    uint256 maxPostiveRebase = _OracleReportSanityChecker.getMaxPositiveTokenRebase();
    mathint maxRateWithoutBurn = (
        (postInternalEther * (limiterPrecision() + maxPostiveRebase)) / internalSharesPre
    );
    mathint rateWithBurn = (
        (postInternalEther * limiterPrecision()) / (internalSharesPre - totalSharesToBurn)
    );

    // NOTE We assume `update.totalSharesToBurn` is non-zero since otherwise
    // `getSharesToBurnLimit` might have no effect
    assert(
        (maxPostiveRebase < UNLIMITED_REBASE() && postInternalEther > 0 && internalEthPre > 0)
        => rateWithBurn <= maxRateWithoutBurn,
        "Rate limit is not surpassed"
    );
}

rule burnSharesAmountCorrectnessSimpleExample(Accounting.ReportValues report) {
    uint256 internalEthPre = _Lido.getInternalEther();
    mathint internalSharesPre = _Lido.getTotalShares() - _Lido.getExternalShares();

    require(internalEthPre == 10000 && internalSharesPre == 100);
    require(_Lido.getTotalShares() <= 200);

    env e;
    Accounting.CalculatedValues update = _Accounting.simulateOracleReport(e, report);

    uint256 postInternalShares = update.postInternalShares;
    uint256 postInternalEther = update.postInternalEther;
    uint256 postTotalPooledEther = update.postTotalPooledEther;
    uint256 postTotalShares = update.postTotalShares;
    uint256 etherToFinalizeWQ = update.etherToFinalizeWQ;
    uint256 sharesToFinalizeWQ = update.sharesToFinalizeWQ;
    uint256 sharesToBurnForWithdrawals = update.sharesToBurnForWithdrawals;
    uint256 totalSharesToBurn = update.totalSharesToBurn;
    uint256 sharesRequestedToBurn = report.sharesRequestedToBurn;
    require(sharesRequestedToBurn + sharesToFinalizeWQ < internalSharesPre);

    require(
        report.simulatedShareRate <= (postTotalPooledEther * 10^27) / postTotalShares,
        "Assume report.simulatedShareRate is not higher than eventual rate"
    );

    mathint ratePre = (internalEthPre * limiterPrecision()) / internalSharesPre;
    mathint ratePost = (postInternalEther * limiterPrecision()) / postInternalShares;
    uint256 maxPostiveRebase = _OracleReportSanityChecker.getMaxPositiveTokenRebase();
    mathint maxratePost = (
        internalEthPre * (maxPostiveRebase + limiterPrecision())
    ) / internalSharesPre;
    mathint rateIfAllBurnt = (
        (postInternalEther * limiterPrecision()) /
        (postInternalShares + totalSharesToBurn - sharesRequestedToBurn)
    );
    require(rateIfAllBurnt <= maxratePost + 1);

    // NOTE We assume `update.totalSharesToBurn` is non-zero since otherwise
    // `getSharesToBurnLimit` might have no effect
    assert(
        (maxPostiveRebase < UNLIMITED_REBASE() && ratePre > 0 && update.totalSharesToBurn > 0)
        // => (ratePost - ratePre) * limiterPrecision() <= ratePre * maxPostiveRebase,
        => ratePost <= maxratePost + 10^10,
        "Rate limit is not surpassed"
    );
}
