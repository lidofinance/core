// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {PositiveTokenRebaseLimiter, TokenRebaseLimiterData} from "contracts/0.8.9/lib/PositiveTokenRebaseLimiter.sol";

contract PositiveTokenRebaseLimiter__Harness {
    using PositiveTokenRebaseLimiter for TokenRebaseLimiterData;

    TokenRebaseLimiterData public limiterState;

    event DecreaseEther__Harness(uint256 etherAmount, uint256 currentTotalPooledEther);
    event IncreaseEther__Harness(uint256 etherAmount, uint256 consumedEther, uint256 currentTotalPooledEther);

    function harness__initLimiterState(
        uint256 _rebaseLimit,
        uint256 _preTotalPooledEther,
        uint256 _preTotalShares
    ) external {
        limiterState = PositiveTokenRebaseLimiter.initLimiterState(_rebaseLimit, _preTotalPooledEther, _preTotalShares);
    }

    function harness__isLimitReached() external view returns (bool) {
        return limiterState.isLimitReached();
    }

    function harness__getSharesToBurnLimit() external view returns (uint256) {
        return limiterState.getSharesToBurnLimit();
    }

    function harness__decreaseEther(uint256 _etherAmount) external {
        TokenRebaseLimiterData memory tempState = limiterState;
        tempState.decreaseEther(_etherAmount);
        limiterState = tempState;
        emit DecreaseEther__Harness(_etherAmount, tempState.currentTotalPooledEther);
    }

    function harness__increaseEther(uint256 _etherAmount) external returns (uint256 consumedEther) {
        TokenRebaseLimiterData memory tempState = limiterState;
        consumedEther = tempState.increaseEther(_etherAmount);
        limiterState = tempState;
        emit IncreaseEther__Harness(_etherAmount, consumedEther, tempState.currentTotalPooledEther);
    }

    function mock__setMaxTotalPooledEther(uint256 _maxTotalPooledEther) external {
        limiterState.maxTotalPooledEther = _maxTotalPooledEther;
    }
}
