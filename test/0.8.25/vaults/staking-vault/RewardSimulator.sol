// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {RandomLib} from "./RandomLib.sol";

contract RewardSimulator {
    using RandomLib for RandomLib.Storage;

    uint256 constant SECONDS_PER_DAY = 86400;
    uint256 constant APR_DENOMINATOR = 10000;
    uint256 constant DAYS_PER_YEAR = 365;

    uint256 internal immutable APR_MIN;
    uint256 internal immutable APR_MAX;
    uint256 internal immutable MIN_VALIDATOR_BALANCE;

    uint256 private currentAPR;
    uint256 private lastRewardTimestamp;
    RandomLib.Storage private rnd;

    constructor(uint256 _seed, uint256 _aprMin, uint256 _aprMax, uint256 _minValidatorBalance) {
        rnd.seed = _seed;
        lastRewardTimestamp = block.timestamp;
        APR_MIN = _aprMin;
        APR_MAX = _aprMax;
        MIN_VALIDATOR_BALANCE = _minValidatorBalance;
        currentAPR = APR_MIN + rnd.randInt(APR_MAX - APR_MIN);
    }

    function getDailyReward() public returns (uint256) {
        uint256 timePassed = block.timestamp - lastRewardTimestamp;
        if (timePassed < SECONDS_PER_DAY) {
            return 0;
        }

        uint256 daysPassed = timePassed / SECONDS_PER_DAY;
        lastRewardTimestamp += daysPassed * SECONDS_PER_DAY;

        uint256 yearlyReward = (MIN_VALIDATOR_BALANCE * currentAPR) / APR_DENOMINATOR;
        uint256 dailyReward = (yearlyReward * daysPassed) / DAYS_PER_YEAR;

        int256 randomVariation = int256(rnd.randInt(200)) - 100;
        dailyReward = uint256((int256(dailyReward) * (1000 + randomVariation)) / 1000);

        if (rnd.randBool()) {
            currentAPR = APR_MIN + rnd.randInt(APR_MAX - APR_MIN);
        }

        return dailyReward;
    }
}
