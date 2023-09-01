// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

import "../lib/PositiveTokenRebaseLimiter.sol";

contract PositiveTokenRebaseLimiterMock {
    using PositiveTokenRebaseLimiter for TokenRebaseLimiterData;

    TokenRebaseLimiterData public limiter;

    function getLimiterValues()
        external
        view
        returns (
            uint256 preTotalPooledEther,
            uint256 preTotalShares,
            uint256 currentTotalPooledEther,
            uint256 positiveRebaseLimit
        )
    {
        preTotalPooledEther = limiter.preTotalPooledEther;
        preTotalShares = limiter.preTotalShares;
        currentTotalPooledEther = limiter.currentTotalPooledEther;
        positiveRebaseLimit = limiter.positiveRebaseLimit;
    }

    function initLimiterState(
        uint256 _rebaseLimit,
        uint256 _preTotalPooledEther,
        uint256 _preTotalShares
    ) external {
        limiter = PositiveTokenRebaseLimiter.initLimiterState(_rebaseLimit, _preTotalPooledEther, _preTotalShares);
    }

    function isLimitReached() external view returns (bool) {
        return limiter.isLimitReached();
    }

    function decreaseEther(uint256 _etherAmount) external {
        TokenRebaseLimiterData memory limiterMemory = limiter;
        limiterMemory.decreaseEther(_etherAmount);
        limiter = limiterMemory;
    }

    function increaseEther(uint256 _etherAmount) external returns (uint256 consumedEther) {
        TokenRebaseLimiterData memory limiterMemory = limiter;
        consumedEther = limiterMemory.increaseEther(_etherAmount);
        limiter = limiterMemory;
    }

    function getSharesToBurnLimit() external view returns (uint256) {
        TokenRebaseLimiterData memory limiterMemory = limiter;
        return limiterMemory.getSharesToBurnLimit();
    }
}
