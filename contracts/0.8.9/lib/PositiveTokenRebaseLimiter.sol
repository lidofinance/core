// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {Math256} from "../../common/lib/Math256.sol";

/**
 * This library implements positive rebase limiter for `stETH` token.
 * One needs to initialize `LimiterState` with the desired parameters:
 * - _rebaseLimit (limiter max value, nominated in LIMITER_PRECISION_BASE)
 * - _preTotalPooledEther (see `Lido.getTotalPooledEther()`), pre-rebase value
 * - _preTotalShares (see `Lido.getTotalShares()`), pre-rebase value
 *
 * The limiter allows to account for:
 * - consensus layer balance updates (can be either positive or negative)
 * - total pooled ether changes (withdrawing funds from vaults on execution layer)
 * - total shares changes (burning due to coverage, NOR penalization, withdrawals finalization, etc.)
 */

/**
 * @dev Internal limiter representation struct (storing in memory)
 */
struct TokenRebaseLimiterData {
    uint256 preTotalPooledEther;     // pre-rebase total pooled ether
    uint256 preTotalShares;          // pre-rebase total shares
    uint256 currentTotalPooledEther; // intermediate total pooled ether amount while token rebase is in progress
    uint256 positiveRebaseLimit;     // positive rebase limit (target value) with 1e9 precision (`LIMITER_PRECISION_BASE`)
    uint256 maxTotalPooledEther;     // maximum total pooled ether that still fits into the positive rebase limit (cached)
}

/**
 *
 * Two-steps flow: account for total supply changes and then determine the shares allowed to be burnt.
 *
 * Conventions:
 *     R - token rebase limit (i.e, {postShareRate / preShareRate - 1} <= R);
 *   inc - total pooled ether increase;
 *   dec - total shares decrease.
 *
 * ### Step 1. Calculating the allowed total pooled ether changes (preTotalShares === postTotalShares)
 *     Used for `PositiveTokenRebaseLimiter.increaseEther()`, `PositiveTokenRebaseLimiter.decreaseEther()`.
 *
 * R = ((preTotalPooledEther + inc) / preTotalShares) / (preTotalPooledEther / preTotalShares) - 1
 * = ((preTotalPooledEther + inc) / preTotalShares) * (preTotalShares / preTotalPooledEther) - 1
 * = (preTotalPooledEther + inc) / preTotalPooledEther) - 1
 * = inc/preTotalPooledEther
 *
 * isolating inc:
 *
 * ``` inc = R * preTotalPooledEther ```
 *
 * ### Step 2. Calculating the allowed to burn shares (preTotalPooledEther != currentTotalPooledEther)
 *     Used for `PositiveTokenRebaseLimiter.getSharesToBurnLimit()`.
 *
 * R = (currentTotalPooledEther / (preTotalShares - dec)) / (preTotalPooledEther / preTotalShares) - 1,
 * let X = currentTotalPooledEther / preTotalPooledEther
 *
 * then:
 * R = X * (preTotalShares / (preTotalShares - dec)) - 1, or
 * (R+1) * (preTotalShares - dec) = X * preTotalShares
 *
 * isolating dec:
 * dec * (R + 1) = (R + 1 - X) * preTotalShares =>
 *
 * ``` dec = preTotalShares * (R + 1 - currentTotalPooledEther/preTotalPooledEther) / (R + 1) ```
 *
 */
library PositiveTokenRebaseLimiter {
    /// @dev Precision base for the limiter (e.g.: 1e6 - 0.1%; 1e9 - 100%)
    uint256 public constant LIMITER_PRECISION_BASE = 10**9;
    /// @dev Disabled limit
    uint256 public constant UNLIMITED_REBASE = type(uint64).max;

    /**
     * @dev Initialize the new `LimiterState` structure instance
     * @param _rebaseLimit max limiter value (saturation point), see `LIMITER_PRECISION_BASE`
     * @param _preTotalPooledEther pre-rebase total pooled ether, see `Lido.getTotalPooledEther()`
     * @param _preTotalShares pre-rebase total shares, see `Lido.getTotalShares()`
     * @return limiterState newly initialized limiter structure
     */
    function initLimiterState(
        uint256 _rebaseLimit,
        uint256 _preTotalPooledEther,
        uint256 _preTotalShares
    ) internal pure returns (TokenRebaseLimiterData memory limiterState) {
        if (_rebaseLimit == 0) revert TooLowTokenRebaseLimit();
        if (_rebaseLimit > UNLIMITED_REBASE) revert TooHighTokenRebaseLimit();

        // special case
        if (_preTotalPooledEther == 0) { _rebaseLimit = UNLIMITED_REBASE; }

        limiterState.currentTotalPooledEther = limiterState.preTotalPooledEther = _preTotalPooledEther;
        limiterState.preTotalShares = _preTotalShares;
        limiterState.positiveRebaseLimit = _rebaseLimit;

        limiterState.maxTotalPooledEther = (_rebaseLimit == UNLIMITED_REBASE)
            ? type(uint256).max
            : limiterState.preTotalPooledEther
                + (limiterState.positiveRebaseLimit * limiterState.preTotalPooledEther) / LIMITER_PRECISION_BASE;
    }

    /**
     * @notice check if positive rebase limit is reached
     * @param _limiterState limit repr struct
     * @return true if limit is reached
     */
    function isLimitReached(TokenRebaseLimiterData memory _limiterState) internal pure returns (bool) {
        return _limiterState.currentTotalPooledEther >= _limiterState.maxTotalPooledEther;
    }

    /**
     * @notice decrease total pooled ether by the given amount of ether
     * @param _limiterState limit repr struct
     * @param _etherAmount amount of ether to decrease
     */
    function decreaseEther(
        TokenRebaseLimiterData memory _limiterState, uint256 _etherAmount
    ) internal pure {
        if (_limiterState.positiveRebaseLimit == UNLIMITED_REBASE) return;

        if (_etherAmount > _limiterState.currentTotalPooledEther) revert NegativeTotalPooledEther();

        _limiterState.currentTotalPooledEther -= _etherAmount;
    }

    /**
     * @dev increase total pooled ether up to the limit and return the consumed value (not exceeding the limit)
     * @param _limiterState limit repr struct
     * @param _etherAmount desired ether addition
     * @return consumedEther appended ether still not exceeding the limit
     */
    function increaseEther(
        TokenRebaseLimiterData memory _limiterState, uint256 _etherAmount
    )
        internal
        pure
        returns (uint256 consumedEther)
    {
        if (_limiterState.positiveRebaseLimit == UNLIMITED_REBASE) return _etherAmount;

        uint256 prevPooledEther = _limiterState.currentTotalPooledEther;
        _limiterState.currentTotalPooledEther += _etherAmount;

        _limiterState.currentTotalPooledEther
            = Math256.min(_limiterState.currentTotalPooledEther, _limiterState.maxTotalPooledEther);

        assert(_limiterState.currentTotalPooledEther >= prevPooledEther);

        return _limiterState.currentTotalPooledEther - prevPooledEther;
    }

    /**
     * @dev return shares to burn value not exceeding the limit
     * @param _limiterState limit repr struct
     * @return maxSharesToBurn allowed to deduct shares to not exceed the limit
     */
    function getSharesToBurnLimit(TokenRebaseLimiterData memory _limiterState)
        internal
        pure
        returns (uint256 maxSharesToBurn)
    {
        if (_limiterState.positiveRebaseLimit == UNLIMITED_REBASE) return _limiterState.preTotalShares;

        if (isLimitReached(_limiterState)) return 0;

        uint256 rebaseLimitPlus1 = _limiterState.positiveRebaseLimit + LIMITER_PRECISION_BASE;
        uint256 pooledEtherRate =
            (_limiterState.currentTotalPooledEther * LIMITER_PRECISION_BASE) / _limiterState.preTotalPooledEther;

        maxSharesToBurn = (_limiterState.preTotalShares * (rebaseLimitPlus1 - pooledEtherRate)) / rebaseLimitPlus1;
    }

    error TooLowTokenRebaseLimit();
    error TooHighTokenRebaseLimit();
    error NegativeTotalPooledEther();
}
