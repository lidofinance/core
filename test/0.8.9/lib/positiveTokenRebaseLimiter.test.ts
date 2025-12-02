import { expect } from "chai";
import { ethers } from "hardhat";

import { PositiveTokenRebaseLimiter__Harness } from "typechain-types";

import { ether, MAX_UINT256 } from "lib";

const LIMITER_PRECISION_BASE = 1000000000n;
const MAX_UINT64 = 2n ** 64n - 1n;

describe("PositiveTokenRebaseLimiter.sol", () => {
  let limiter: PositiveTokenRebaseLimiter__Harness;

  before(async () => {
    limiter = await ethers.deployContract("PositiveTokenRebaseLimiter__Harness");
  });

  context("initLimiterState", () => {
    it("Reverts when rebase limit is 0", async () => {
      await expect(limiter.harness__initLimiterState(0n, 0n, 0n)).to.be.revertedWithCustomError(
        limiter,
        "TooLowTokenRebaseLimit",
      );
    });

    it("Reverts when rebase limit exceeds UNLIMITED_REBASE", async () => {
      await expect(limiter.harness__initLimiterState(MAX_UINT256, 0n, 0n)).to.be.revertedWithCustomError(
        limiter,
        "TooHighTokenRebaseLimit",
      );
    });

    it("Assigns limiter state with valid parameters", async () => {
      const preTotalPooledEther = ether("100");
      const preTotalShares = ether("100");
      const rebaseLimit = ether("1"); // 10% limit

      await limiter.harness__initLimiterState(rebaseLimit, preTotalPooledEther, preTotalShares);

      const state = await limiter.limiterState();

      expect(state.currentTotalPooledEther).to.equal(preTotalPooledEther);
      expect(state.preTotalPooledEther).to.equal(preTotalPooledEther);
      expect(state.preTotalShares).to.equal(preTotalShares);

      expect(state.positiveRebaseLimit).to.equal(rebaseLimit);
      expect(state.maxTotalPooledEther).to.equal(
        preTotalPooledEther + (rebaseLimit * preTotalPooledEther) / LIMITER_PRECISION_BASE,
      );
    });

    it("Assigns unlimited rebase when preTotalPooledEther is 0", async () => {
      await limiter.harness__initLimiterState(ether("1"), 0n, 0n);

      const state = await limiter.limiterState();

      expect(state.positiveRebaseLimit).to.equal(MAX_UINT64);
      expect(state.maxTotalPooledEther).to.equal(ethers.MaxUint256);
    });
  });

  context("isLimitReached", () => {
    it("Returns true when current total pooled ether reaches max", async () => {
      await limiter.harness__initLimiterState(ether("1"), ether("100"), ether("100"));
      await limiter.mock__setMaxTotalPooledEther(ether("100"));

      expect(await limiter.harness__isLimitReached()).to.be.true;
    });

    it("Returns false when current total pooled ether is below max", async () => {
      await limiter.harness__initLimiterState(ether("1"), ether("100"), ether("100"));

      expect(await limiter.harness__isLimitReached()).to.be.false;
    });
  });

  context("decreaseEther", () => {
    it("Reverts when decrease amount exceeds current total pooled ether", async () => {
      await limiter.harness__initLimiterState(ether("1"), ether("100"), ether("100"));

      const decreaseAmount = ether("101");
      await expect(limiter.harness__decreaseEther(decreaseAmount)).to.be.revertedWithCustomError(
        limiter,
        "NegativeTotalPooledEther",
      );
    });

    it("Does nothing when rebase limit is unlimited", async () => {
      await limiter.harness__initLimiterState(MAX_UINT64, ether("100"), ether("100"));

      const decreaseAmount = ether("20");
      await expect(await limiter.harness__decreaseEther(decreaseAmount))
        .to.emit(limiter, "DecreaseEther__Harness")
        .withArgs(decreaseAmount, ether("100"));

      const state = await limiter.limiterState();
      expect(state.currentTotalPooledEther).to.equal(ether("100"));
    });

    it("Decreases total pooled ether by given amount", async () => {
      await limiter.harness__initLimiterState(ether("1"), ether("100"), ether("100"));

      const pooledEther = ether("100");
      const decreaseAmount = ether("20");
      const expectedPooledEther = pooledEther - decreaseAmount;
      await expect(await limiter.harness__decreaseEther(decreaseAmount))
        .to.emit(limiter, "DecreaseEther__Harness")
        .withArgs(decreaseAmount, expectedPooledEther);

      const state = await limiter.limiterState();
      expect(state.currentTotalPooledEther).to.equal(expectedPooledEther);
    });
  });

  context("increaseEther", () => {
    it("Returns full amount when rebase limit is unlimited", async () => {
      await limiter.harness__initLimiterState(MAX_UINT64, ether("100"), ether("100"));

      const increaseAmount = ether("20");
      const expectedConsumedEther = increaseAmount;
      await expect(await limiter.harness__increaseEther(increaseAmount))
        .to.emit(limiter, "IncreaseEther__Harness")
        .withArgs(increaseAmount, expectedConsumedEther, ether("100"));

      const state = await limiter.limiterState();

      expect(state.currentTotalPooledEther).to.equal(ether("100"));
    });

    it("Increases total pooled ether up to the limit", async () => {
      await limiter.harness__initLimiterState(ether("1"), ether("100"), ether("100"));

      const increaseAmount = ether("20");
      const expectedConsumedEther = increaseAmount;
      const expectedPooledEther = ether("100") + increaseAmount;
      await expect(await limiter.harness__increaseEther(increaseAmount))
        .to.emit(limiter, "IncreaseEther__Harness")
        .withArgs(increaseAmount, expectedConsumedEther, expectedPooledEther);

      const state = await limiter.limiterState();

      expect(state.currentTotalPooledEther).to.equal(expectedPooledEther);
    });

    it("Limits increase to max total pooled ether", async () => {
      await limiter.harness__initLimiterState(ether("1"), ether("100"), ether("100"));
      await limiter.mock__setMaxTotalPooledEther(ether("110"));

      const increaseAmount = ether("20");
      const expectedConsumedEther = ether("10");
      const expectedPooledEther = ether("110");
      await expect(await limiter.harness__increaseEther(increaseAmount))
        .to.emit(limiter, "IncreaseEther__Harness")
        .withArgs(increaseAmount, expectedConsumedEther, expectedPooledEther);

      const state = await limiter.limiterState();
      expect(state.currentTotalPooledEther).to.equal(expectedPooledEther);
    });
  });

  context("getSharesToBurnLimit", () => {
    it("Returns preTotalShares when rebase limit is unlimited", async () => {
      await limiter.harness__initLimiterState(MAX_UINT64, ether("100"), ether("100"));

      const maxSharesToBurn = await limiter.harness__getSharesToBurnLimit();
      expect(maxSharesToBurn).to.equal(ether("100"));
    });

    it("Returns 0 when limit is reached", async () => {
      await limiter.harness__initLimiterState(ether("1"), ether("100"), ether("100"));
      await limiter.mock__setMaxTotalPooledEther(ether("100"));

      const maxSharesToBurn = await limiter.harness__getSharesToBurnLimit();
      expect(maxSharesToBurn).to.equal(0n);
    });

    it("Returns correct shares to burn limit", async () => {
      await limiter.harness__initLimiterState(ether("1"), ether("100"), ether("100"));
      await limiter.mock__setMaxTotalPooledEther(ether("110"));

      await limiter.harness__increaseEther(ether("5"));

      const state = await limiter.limiterState();

      const rebaseLimitPlus1 = state.positiveRebaseLimit + LIMITER_PRECISION_BASE;
      const pooledEtherRate = (state.currentTotalPooledEther * LIMITER_PRECISION_BASE) / state.preTotalPooledEther;

      const maxSharesToBurn = await limiter.harness__getSharesToBurnLimit();
      expect(maxSharesToBurn).to.equal(
        (state.preTotalShares * (rebaseLimitPlus1 - pooledEtherRate)) / rebaseLimitPlus1,
      );
    });
  });
});
