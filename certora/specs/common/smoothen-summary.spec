/* Summary for `OracleReportSanityChecker.smoothenTokenRebase` */

using OracleReportSanityChecker as _OracleReportSanityChecker;

methods {
    function OracleReportSanityChecker.getMaxPositiveTokenRebase() external returns (uint256) envfree;
}

// ---- Ghost variables --------------------------------------------------------
// These are ghost mappings for the returns values of
// `OracleReportSanityChecker.smoothenTokenRebase`, ensuring we get the same values for
// the same parameters.

ghost mapping(
    uint256 /* `_withdrawalVaultBalance` */ => uint256
) withdrawalsGhost;

ghost mapping(
    uint256 /* `_elRewardsVaultBalance` */ => uint256
) elRewardsGhost;

ghost mapping(
    uint256 /* `_sharesRequestedToBurn` */ => uint256
) sharesWQBurnGhost;

/// @dev By `OracleReportSanityChecker.sol` Lines 440-443 the value of `sharesToBurn`
/// depends only on the sum `_newSharesToBurnForWithdrawals + _sharesRequestedToBurn` and
/// the shares burn limit. Also `sharesToBurn` is weakly monotonic increasing in this sum.
ghost mapping(
    mathint /* `_newSharesToBurnForWithdrawals + _sharesRequestedToBurn` */  => uint256
) sharesToBurnGhost {
    // Weakly monotonic increasing
    axiom forall mathint burn1. forall mathint burn2. (
        burn1 > burn2 => sharesToBurnGhost[burn1] >= sharesToBurnGhost[burn2]
    );
}

/// @dev Simplified summary of `OracleReportSanityChecker.smoothenTokenRebase`
function CVLSimplifiedsmoothenTokenRebase(
    uint256 _preTotalPooledEther,
    uint256 _preTotalShares,
    uint256 _preCLBalance,
    uint256 _postCLBalance,
    uint256 _withdrawalVaultBalance,
    uint256 _elRewardsVaultBalance,
    uint256 _sharesRequestedToBurn,
    uint256 _etherToLockForWithdrawals,
    uint256 _newSharesToBurnForWithdrawals
) returns (
    uint256, // `withdrawals`
    uint256, // `elRewards`
    uint256, // `sharesFromWQToBurn`
    uint256 // `sharesToBurn`
) {
    uint256 _rebaseLimit = _OracleReportSanityChecker.getMaxPositiveTokenRebase();
    require(
        _rebaseLimit != 0 && _rebaseLimit <= UNLIMITED_REBASE(),
        "See PositiveTokenRebaseLimiter.sol Lines 88-89"
    );
    uint256 rebaseLimit = _preTotalPooledEther == 0 ? UNLIMITED_REBASE() : _rebaseLimit;
    uint256 maxTotalPooledEther = require_uint256(
        rebaseLimit == max_uint64 ?
        max_uint256 :
        _preTotalPooledEther + (rebaseLimit * _preTotalPooledEther) / LIMITER_PRECISION_BASE()
    );

    uint256 withdrawals = withdrawalsGhost[_withdrawalVaultBalance];
    require(withdrawals <= _withdrawalVaultBalance);
    
    uint256 elRewards = elRewardsGhost[_elRewardsVaultBalance];
    require(elRewards <= _elRewardsVaultBalance);

    mathint currentTotalPooledEther = (
        _preTotalPooledEther
        + withdrawals
        + elRewards
        + _postCLBalance
        - _preCLBalance
        - _etherToLockForWithdrawals
    );
    require(currentTotalPooledEther <= maxTotalPooledEther && currentTotalPooledEther >= 0);

    uint256 sharesToBurn = (
        sharesToBurnGhost[_newSharesToBurnForWithdrawals +_sharesRequestedToBurn]
    );
    uint256 sharesFromWQToBurn = sharesWQBurnGhost[_sharesRequestedToBurn];
    mathint sharesToBurnLimit = getSharesToBurnLimit(
        currentTotalPooledEther,
        _preTotalShares,
        _preTotalPooledEther,
        maxTotalPooledEther,
        rebaseLimit
    );
    require(sharesFromWQToBurn <= _sharesRequestedToBurn && sharesFromWQToBurn <= sharesToBurn);
    require(sharesToBurn <= _newSharesToBurnForWithdrawals + _sharesRequestedToBurn);
    require(sharesToBurn <= sharesToBurnLimit);

    return (withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn);
}


/// @dev Complete summary of `OracleReportSanityChecker.smoothenTokenRebase`
function CVLsmoothenTokenRebase(
    uint256 _preTotalPooledEther,
    uint256 _preTotalShares,
    uint256 _preCLBalance,
    uint256 _postCLBalance,
    uint256 _withdrawalVaultBalance,
    uint256 _elRewardsVaultBalance,
    uint256 _sharesRequestedToBurn,
    uint256 _etherToLockForWithdrawals,
    uint256 _newSharesToBurnForWithdrawals
) returns (
    uint256, // `withdrawals`
    uint256, // `elRewards`
    uint256, // `sharesFromWQToBurn`
    uint256 // `sharesToBurn`
) {
    uint256 maxPositiveTokenRebase = _OracleReportSanityChecker.getMaxPositiveTokenRebase();
    uint256 preTotalPooledEther;
    uint256 preTotalShares;
    uint256 currentTotalPooledEther;
    uint256 positiveRebaseLimit;
    uint256 maxTotalPooledEther;
    (
        preTotalPooledEther,
        preTotalShares,
        currentTotalPooledEther,
        positiveRebaseLimit,
        maxTotalPooledEther
    ) = CVLMimicInitLimiterState(maxPositiveTokenRebase, _preTotalPooledEther, _preTotalShares);

    mathint currentTotalPooledEther1 = (
        _postCLBalance < _preCLBalance ?
        decreaseEther(
            _preCLBalance - _postCLBalance,
            currentTotalPooledEther,
            positiveRebaseLimit
        ) :
        increaseEtherPooledOnly(
            _postCLBalance - _preCLBalance,
            currentTotalPooledEther,
            maxTotalPooledEther,
            positiveRebaseLimit
        )
    );

    mathint withdrawals;
    mathint currentTotalPooledEther2;
    (withdrawals, currentTotalPooledEther2) = increaseEther(
        _withdrawalVaultBalance,
        currentTotalPooledEther1,
        maxTotalPooledEther,
        positiveRebaseLimit
    );

    mathint elRewards;
    mathint currentTotalPooledEther3;
    (elRewards, currentTotalPooledEther3) = increaseEther(
        _elRewardsVaultBalance,
        currentTotalPooledEther2,
        maxTotalPooledEther,
        positiveRebaseLimit
    );

    mathint _simulatedSharesToBurn = getSharesToBurnLimit(
        currentTotalPooledEther3,
        preTotalShares,
        preTotalPooledEther,
        maxTotalPooledEther,
        positiveRebaseLimit
    );
    mathint simulatedSharesToBurn = (
        _simulatedSharesToBurn < _sharesRequestedToBurn ?
        _simulatedSharesToBurn : _sharesRequestedToBurn
    );

    mathint currentTotalPooledEther4 = decreaseEther(
        _etherToLockForWithdrawals,
        currentTotalPooledEther,
        positiveRebaseLimit
    );

    mathint _sharesToBurn = getSharesToBurnLimit(
        currentTotalPooledEther3,
        preTotalShares,
        preTotalPooledEther,
        maxTotalPooledEther,
        positiveRebaseLimit
    );
    mathint sharesToBurn = (
        _sharesToBurn < _newSharesToBurnForWithdrawals + _sharesRequestedToBurn ?
        _sharesToBurn :
        _newSharesToBurnForWithdrawals + _sharesRequestedToBurn
    );

    mathint sharesFromWQToBurn = sharesToBurn - simulatedSharesToBurn;
    return (
        require_uint256(withdrawals),
        require_uint256(elRewards),
        require_uint256(sharesFromWQToBurn),
        require_uint256(sharesToBurn)
    );
}


/// @dev Mimics `PositiveTokenRebaseLimiter.decreaseEther` used in `smoothenTokenRebase`
function decreaseEther(
    mathint _etherAmount,
    mathint currentTotalPooledEther,
    uint256 positiveRebaseLimit
) returns mathint {
    if (positiveRebaseLimit == UNLIMITED_REBASE()) {
        return currentTotalPooledEther;
    }
    require(
        _etherAmount <= currentTotalPooledEther,
        "See PositiveTokenRebaseLimiter Line 123"
    );
    return currentTotalPooledEther - _etherAmount;
}


/// @dev Mimics `PositiveTokenRebaseLimiter.increaseEther` used in `smoothenTokenRebase`
function increaseEther(
    mathint _etherAmount,
    mathint currentTotalPooledEther,
    uint256 maxTotalPooledEther,
    uint256 positiveRebaseLimit
) returns (mathint, mathint) {
    if (positiveRebaseLimit == UNLIMITED_REBASE()) {
        return (_etherAmount, currentTotalPooledEther);
    }
    mathint sumPooledEther = _etherAmount + currentTotalPooledEther;
    mathint newPooledEther = (
        (sumPooledEther < maxTotalPooledEther) ? sumPooledEther : maxTotalPooledEther
    );

    require(
        newPooledEther >= currentTotalPooledEther,
        "See PositiveTokenRebaseLimiter Line 149"
    );
    mathint consumedEther = newPooledEther - currentTotalPooledEther;
    return (consumedEther, newPooledEther);
}


/// @dev A version of `increaseEther` above only returning `newPooledEther`
function increaseEtherPooledOnly(
    mathint _etherAmount,
    mathint currentTotalPooledEther,
    uint256 maxTotalPooledEther,
    uint256 positiveRebaseLimit
) returns mathint {
    mathint newPooledEther;
    (_, newPooledEther) = increaseEther(
        _etherAmount, currentTotalPooledEther, maxTotalPooledEther, positiveRebaseLimit
    );
    return newPooledEther;
}


/// @dev See `PositiveTokenRebaseLimiter` Line 72
definition LIMITER_PRECISION_BASE() returns uint256 = 10^9;

/// @dev See `PositiveTokenRebaseLimiter` Line 74
definition UNLIMITED_REBASE() returns uint256 = max_uint64;

/// @dev Mimics `PositiveTokenRebaseLimiter.getSharesToBurnLimit`
function getSharesToBurnLimit(
    mathint currentTotalPooledEther,
    uint256 preTotalShares,
    uint256 preTotalPooledEther,
    uint256 maxTotalPooledEther,
    uint256 positiveRebaseLimit
) returns mathint {
    if (positiveRebaseLimit == UNLIMITED_REBASE()) {
        return preTotalShares;
    }
    if (currentTotalPooledEther >= maxTotalPooledEther) {
        return 0;
    }
    mathint rebaseLimitPlus1 = positiveRebaseLimit + LIMITER_PRECISION_BASE();
    mathint pooledEtherRate = (
        (currentTotalPooledEther * LIMITER_PRECISION_BASE()) / preTotalPooledEther
    );
    return (preTotalShares * (rebaseLimitPlus1 - pooledEtherRate)) / rebaseLimitPlus1;
}

/// @dev Mimics `PositiveTokenRebaseLimiter.initLimiterState`
function CVLMimicInitLimiterState(
    uint256 _rebaseLimit,
    uint256 _preTotalPooledEther,
    uint256 _preTotalShares
) returns (
    uint256, // `preTotalPooledEther`
    uint256, // `preTotalShares`
    uint256, // `currentTotalPooledEther`
    uint256, // `positiveRebaseLimit`
    uint256 // `maxTotalPooledEther`
) {
    require(
        _rebaseLimit != 0 && _rebaseLimit <= UNLIMITED_REBASE(),
        "See PositiveTokenRebaseLimiter.sol Lines 88-89"
    );
    uint256 rebaseLimit = _preTotalPooledEther == 0 ? UNLIMITED_REBASE() : _rebaseLimit;

    uint256 currentTotalPooledEther = _preTotalPooledEther;
    uint256 preTotalPooledEther = _preTotalPooledEther;
    uint256 preTotalShares = _preTotalShares;
    uint256 positiveRebaseLimit = rebaseLimit;
    uint256 maxTotalPooledEther = require_uint256(
        rebaseLimit == max_uint64 ?
        max_uint256 :
        _preTotalPooledEther + (rebaseLimit * _preTotalPooledEther) / LIMITER_PRECISION_BASE()
    );
    return (
        preTotalPooledEther,
        preTotalShares,
        currentTotalPooledEther,
        positiveRebaseLimit,
        maxTotalPooledEther
    );
}
