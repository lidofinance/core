/* Rules and basic summaries for `Accounting` contract */

import "../common/smoothen-summary.spec";
import "../common/StakingRouter-summary.spec";
import "../common/lido-storage-ghost.spec";
import "../common/lido-summaries.spec";
import "../common/WithdrawalQueue-summary.spec";

using AccountingHarness as _Accounting;
using Burner as _Burner;
using LidoLocator as _LidoLocator;
using LidoExecutionLayerRewardsVault as _ELRewardsVault;
using WithdrawalVault as _WithdrawalVault;
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

    // `PositiveTokenRebaseLimiter`
    function PositiveTokenRebaseLimiter.getSharesToBurnLimit(
        PositiveTokenRebaseLimiter.TokenRebaseLimiterData memory _limiterState
    ) internal returns (uint256) => CVLgetSharesToBurnLimit(_limiterState);

    // `LidoLocator`
    function _.accounting() external => _Accounting expect address;
    function _.burner() external => _Burner expect address;
    function _.lido() external => _Lido expect address;
    function _.withdrawalQueue() external => _WithdrawalQueue expect address;
    function _.withdrawalVault() external => _WithdrawalVault expect address;
    function _.elRewardsVault() external => _ELRewardsVault expect address;
    function _.vaultHub() external => CONSTANT;
    function _.treasury() external => CONSTANT;
    function _.depositSecurityModule() external => CONSTANT;
    function _.stakingRouter() external => CONSTANT;
    function _.accountingOracle() external => CONSTANT;

    // `IKernel` (`@aragon/os/contracts/kernel/IKernel.sol`) called by `AragonApp`
    function _.hasPermission(address, address, bytes32, bytes) external => NONDET;

    // `VaultHub`
    function _.badDebtToInternalize() external => CONSTANT;
    function _.decreaseInternalizedBadDebt(uint256) external => NONDET;

    // `OracleReportSanityChecker`
    function _.checkAccountingOracleReport(
        uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) external => DISPATCHER(true);
    function _.checkWithdrawalQueueOracleReport(uint256, uint256) external => DISPATCHER(true);
    function _.checkSimulatedShareRate(
        uint256, uint256, uint256, uint256, uint256
    ) external => DISPATCHER(true);

    // `AccountingOracle`
    // NOTE Summarizing `getLastProcessingRefSlot` as constant is not sound, but it is
    // fine in this spec
    function _.getLastProcessingRefSlot() external => CONSTANT;

    // `Burner`
    function _.commitSharesToBurn(uint256) external => DISPATCHER(true);
    function _.requestBurnShares(address, uint256) external => DISPATCHER(true);
    function _.getSharesRequestedToBurn() external => DISPATCHER(true);

    // `ConversionHelpers` Lib (`node_modules/@aragon/os/contracts/common/ConversionHelpers.sol`
    // called by `AragonApp`
    // The summary below is not sound since we return a reference type, however it is
    // only used as parameter for `hasPermission` above, which is summarized as `NONDET`.
    function ConversionHelpers.dangerouslyCastUintArrayToBytes(
        uint256[] memory
    ) internal returns (bytes memory) => CVLNondetBytes();

    // The following is a view function in `@aragon/os/contracts/kernel/Kernel.sol`
    function _.getRecoveryVault() external => NONDET;

    // `ISecondOpinionOracle`
    function _.getReport(uint256) external => NONDET;

    // `WithdrawalQueueERC721`
    // NOTE Summarizing `isPaused` and `isBunkerModeActive` as constant is not sound,
    // but it is fine for this particular spec
    function _.isPaused() external => CONSTANT;  // Not implemented in `WithdrawalQueueMock`
    function _.isBunkerModeActive() external => CONSTANT;  // Not implemented in `WithdrawalQueueMock`

    // `LidoExecutionLayerRewardsVault`
    function _.withdrawRewards(uint256) external => DISPATCHER(true);

    // `WithdrawalVault`
    function _.withdrawWithdrawals(uint256) external => DISPATCHER(true);

    // `IPostTokenRebaseReceiver`
    // This interface has a single function. Its only implementation is in
    // `test/0.4.24/contracts/PostTokenRebaseReceiver__MockForAccounting.sol` where it
    // does nothing apart from emitting an event.
    function _.handlePostTokenRebase(
        uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) external => NONDET;
}

// -- Summary functions --------------------------------------------------------

/// @dev A non-deterministic bytes array
function CVLNondetBytes() returns bytes {
    bytes ret;
    return ret;
}


/// @dev Summary of `PositiveTokenRebaseLimiter.getSharesToBurnLimit`
function CVLgetSharesToBurnLimit(
    PositiveTokenRebaseLimiter.TokenRebaseLimiterData _limiterState
) returns uint256 {
    if (_limiterState.positiveRebaseLimit == max_uint64) {
        return _limiterState.preTotalShares;
    }
    if (_limiterState.currentTotalPooledEther >= _limiterState.maxTotalPooledEther) {
        return 0;
    }
    uint256 rebaseLimitPlus1 = require_uint256(
        _limiterState.positiveRebaseLimit + LIMITER_PRECISION_BASE()
    );
    require(_limiterState.preTotalPooledEther != 0, "Avoid division by zero");
    uint256 pooledEtherRate = require_uint256(
        (_limiterState.currentTotalPooledEther * LIMITER_PRECISION_BASE()) /
        _limiterState.preTotalPooledEther
    );

    uint256 maxSharesToBurn = require_uint256(
        (_limiterState.preTotalShares * (rebaseLimitPlus1 - pooledEtherRate)) /
        rebaseLimitPlus1
    );
    return maxSharesToBurn;
}


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

// ---- Utilities --------------------------------------------------------------

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


/// @dev Requires that the given address is not one of the contracts in the scene
function requireNotInScene(address a) {
    require(
        a != _Accounting &&
        a != _Burner &&
        a != _Lido &&
        a != _ELRewardsVault &&
        a != _WithdrawalVault &&
        a != _WithdrawalQueue,
        "Require the address is not one of the main contracts in the scene"
    );
}

// ---- Rules ------------------------------------------------------------------


/// @title Rewards are shares minted as fees and `_Lido` balance increase
/// @notice Also see `feesAreFraction` in `Accounting-fees-as-frac.spec` for a bound on the fees.
rule feesMintShares(Accounting.ReportValues report) {
    address treasury = _Accounting.treasury();
    // To prevent spurious counter-examples, require `treasury` is not one of the main
    // contracts
    requireNotInScene(treasury);

    env e;
    Accounting.CalculatedValues update = _Accounting.simulateOracleReport(e, report);
    mathint totalRewards = getTotalRewards(report, update);
    require(totalRewards >= 0, "Assume non-negative rewards");

    mathint feeEther = (totalRewards * totalFeeGhost) / FEE_PRECISION_POINTS();

    uint256 balancePre = nativeBalances[_Lido];
    uint256 sharesPre = _Lido.getTotalShares();
    uint256 treasurySharesPre = _Lido.sharesOf(treasury);

    _Accounting.handleOracleReport(e, report);
    
    uint256 balancePost = nativeBalances[_Lido];
    uint256 sharesPost = _Lido.getTotalShares();
    uint256 treasurySharesPost = _Lido.sharesOf(treasury);

    mathint treasuryShareFees = treasurySharesPost - treasurySharesPre;

    assert(sharesPost - sharesPre <= update.sharesToMintAsFees, "Only fee shares are minted");
    assert(treasuryShareFees <= update.sharesToMintAsFees, "Fee shares owned by treasury");
}

// ---- Report revert rules ----------------------------------------------------

/// @title Verify that a deposit done after a report was computed but before it was applied
/// will not cause a revert
/// @dev This is not in CI because it times out.
rule reportNotRevertsByDeposit(
    Accounting.ReportValues report,
    uint256 _maxDepositsCount,
    uint256 _stakingModuleId,
    bytes _depositCalldata
) {
    env e;

    // Enforce correct number of shares
    mathint internalSharesPre = _Lido.getTotalShares() - _Lido.getExternalShares();
    require(
        internalSharesPre >= _Lido.sharesOf(_Burner) + _Lido.sharesOf(_WithdrawalQueue),
        "Correct total number of internal shares"
    );

    // Enforce reasonable report values
    uint256 queueSharesToBurn;
    (_, queueSharesToBurn) = _WithdrawalQueue.prefinalize(
        e, report.withdrawalFinalizationBatches, 1 // Arbitrary number
    );
    require(
        queueSharesToBurn <= report.sharesRequestedToBurn,
        "Shares to burn includes withdrawal queue shares to burn"
    );

    // Check the report without withdrawals
    Accounting.CalculatedValues update = _Accounting.simulateOracleReport(e, report);
    uint256 postInternalShares = update.postInternalShares;
    uint256 postInternalEther = update.postInternalEther;
    uint256 postTotalPooledEther = update.postTotalPooledEther;
    uint256 postTotalShares = update.postTotalShares;

    require(
        postTotalPooledEther <= max_uint128 &&
        postInternalEther <= max_uint128 &&
        postTotalShares <= max_uint128 &&
        postInternalShares <= max_uint128,
        "Avoid overflows - Lido contract provides only uint128 for these"
    );

    storage initial = lastStorage;
    _Accounting.handleOracleReport(e, report); // Ensure no revert

    // Perform action before report
    env edeposit;
    uint256 depositedValidators = _Lido.getDepositedValidators();
    require(
        _maxDepositsCount + depositedValidators <= max_uint128,
        "Prevent overflow of DepositedValidators"
    );
    _Lido.deposit(edeposit, _maxDepositsCount, _stakingModuleId, _depositCalldata) at initial;

    _Accounting.handleOracleReport@withrevert(e, report);
    assert(!lastReverted, "Actions since ref slot should not revert report handling");
}


/// @title Verify that a `submit` done after a report was computed but before it was applied
/// will not cause a revert
/// @dev This is not in CI because it times out.
rule reportNotRevertsBySubmit(
    Accounting.ReportValues report, address _referral, uint256 amount
) {
    env e;

    // Enforce correct number of shares
    mathint internalSharesPre = _Lido.getTotalShares() - _Lido.getExternalShares();
    require(
        internalSharesPre >= _Lido.sharesOf(_Burner) + _Lido.sharesOf(_WithdrawalQueue),
        "Correct total number of internal shares"
    );

    // Enforce reasonable report values
    uint256 queueSharesToBurn;
    (_, queueSharesToBurn) = _WithdrawalQueue.prefinalize(
        e, report.withdrawalFinalizationBatches, 1 // Arbitrary number
    );
    require(
        queueSharesToBurn <= report.sharesRequestedToBurn,
        "Shares to burn includes withdrawal queue shares to burn"
    );

    // Check the report without withdrawals
    // TODO: Try without the next line
    Accounting.CalculatedValues update = _Accounting.simulateOracleReport(e, report);
    uint256 postInternalShares = update.postInternalShares;
    uint256 postInternalEther = update.postInternalEther;
    uint256 postTotalPooledEther = update.postTotalPooledEther;
    uint256 postTotalShares = update.postTotalShares;

    require(
        postTotalPooledEther <= max_uint128 &&
        postInternalEther <= max_uint128 &&
        postTotalShares <= max_uint128 &&
        postInternalShares <= max_uint128,
        "Avoid overflows - Lido contract provides only uint128 for these"
    );
    uint256 totalPooledEtherAtInit = _Lido.getTotalPooledEther();

    storage initial = lastStorage;
    _Accounting.handleOracleReport(e, report); // Ensure no revert

    // Perform action before report
    env esubmit;
    require(e.msg.value == amount, "Set the amount submitted");
    require(
        e.msg.value + totalPooledEtherAtInit < max_uint128,
        "Avoid overflows due to unreasonably large submits"
    );
    _Lido.submit(esubmit, _referral) at initial;

    _Accounting.handleOracleReport@withrevert(e, report);
    assert(!lastReverted, "Actions since ref slot should not revert report handling");
}


// ---- Unit tests -------------------------------------------------------------

/// @title Some revert conditions for `handleOracleReport`
rule handleOracleReportRevertConditions(Accounting.ReportValues report) {
    uint256 depositedValidators = _Lido.getDepositedValidators();
    uint256 clValidators;
    (_, clValidators) = _Lido.getBalanceAndClValidators();

    env e;
    address accountingOracle = _LidoLocator.accountingOracle(e);

    _Accounting.handleOracleReport@withrevert(e, report);
    bool reverted = lastReverted;

    assert(
        (e.msg.sender != accountingOracle) => reverted,
        "Only accounting oracle can call handleOracleReport"
    );
    assert(
        report.timestamp >= e.block.timestamp  => reverted,
        "Must revert if report too in present or future"
    );
    assert(
        report.clValidators < clValidators => reverted,
        "Report validaors num must be at least current number"
    );
    assert(
        report.clValidators > depositedValidators => reverted,
        "Deposited validators cannot be less than report's number"
    );
}
// - No increase in EL rewards => no fees (`Accounting.sol` Line 255)
// - Lido balance change is sum of rewards minus amount transferred to Withdrawal Queue 
