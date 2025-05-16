import { expect } from "chai";
import { ethers } from "hardhat";

import { ExitLimitUtils__Harness, ExitLimitUtilsStorage__Harness } from "typechain-types";

interface ExitRequestLimitData {
  dailyLimit: bigint;
  dailyExitCount: bigint;
  currentDay: bigint;
}

const DAY = 86400;

describe("ExitLimitUtils.sol", () => {
  let exitLimitStorage: ExitLimitUtilsStorage__Harness;
  let exitLimit: ExitLimitUtils__Harness;

  before(async () => {
    exitLimitStorage = await ethers.deployContract("ExitLimitUtilsStorage__Harness");
    exitLimit = await ethers.deployContract("ExitLimitUtils__Harness");
  });

  context("ExitLimitUtilsStorage", () => {
    let data: ExitRequestLimitData;

    it("Min possible values", async () => {
      data = {
        dailyLimit: 0n,
        dailyExitCount: 0n,
        currentDay: 0n,
      };

      await exitLimitStorage.setStorageExitRequestLimit(data);

      const result = await exitLimitStorage.getStorageExitRequestLimit();
      expect(result.dailyLimit).to.equal(0n);
      expect(result.dailyExitCount).to.equal(0n);
      expect(result.currentDay).to.equal(0n);
    });

    it("Max possible values", async () => {
      const MAX_UINT96 = 2n ** 96n - 1n;
      const MAX_UINT64 = 2n ** 64n - 1n;

      data = {
        dailyLimit: MAX_UINT96,
        dailyExitCount: MAX_UINT96,
        currentDay: MAX_UINT64,
      };

      await exitLimitStorage.setStorageExitRequestLimit(data);

      const result = await exitLimitStorage.getStorageExitRequestLimit();
      expect(result.dailyLimit).to.equal(MAX_UINT96);
      expect(result.dailyExitCount).to.equal(MAX_UINT96);
      expect(result.currentDay).to.equal(MAX_UINT64);
    });

    it("Some random values", async () => {
      const dailyLimit = 100n;
      const dailyExitCount = 50n;
      const currentDay = 2n;

      data = {
        dailyLimit,
        dailyExitCount,
        currentDay,
      };

      await exitLimitStorage.setStorageExitRequestLimit(data);

      const result = await exitLimitStorage.getStorageExitRequestLimit();
      expect(result.dailyLimit).to.equal(dailyLimit);
      expect(result.dailyExitCount).to.equal(dailyExitCount);
      expect(result.currentDay).to.equal(currentDay);
    });
  });

  context("ExitLimitUtils", () => {
    context("consumeLimit", () => {
      it("should allow unlimited exits when dailyLimit was not set", async () => {
        await exitLimit.harness_setState(0, 0, 0);
        const result = await exitLimit.consumeLimit(100, 0);
        expect(result).to.equal(100);
      });

      it("should reset on new day and return requestsCount if under limit", async () => {
        await exitLimit.harness_setState(10, 5, 1);
        const result = await exitLimit.consumeLimit(8, 2n * BigInt(DAY));
        expect(result).to.equal(8);
      });

      it("should cap requests to remaining limit", async () => {
        await exitLimit.harness_setState(10, 8, 0);
        const result = await exitLimit.consumeLimit(5, 0);
        expect(result).to.equal(2);
      });

      it("should revert if no limit left", async () => {
        await exitLimit.harness_setState(5, 5, 0);
        await expect(exitLimit.consumeLimit(1, 0)).to.be.revertedWithCustomError(exitLimit, "ExitRequestsLimit");
      });

      it("should respect new dailyLimit after changing from unlimited", async () => {
        await exitLimit.harness_setState(0, 50, 0);
        const newData = await exitLimit.setExitDailyLimit(60, 0);
        await exitLimit.harness_setState(newData.dailyLimit, newData.dailyExitCount, newData.currentDay);
        const result = await exitLimit.consumeLimit(11, 0);
        expect(result).to.equal(10);
      });

      it("should revert if after new dailyLimit dailyEXitCount exceed accepted amount", async () => {
        await exitLimit.harness_setState(0, 50, 0);
        const newData = await exitLimit.setExitDailyLimit(50, 0);
        await exitLimit.harness_setState(newData.dailyLimit, newData.dailyExitCount, newData.currentDay);
        await expect(exitLimit.consumeLimit(1, 0)).to.be.revertedWithCustomError(exitLimit, "ExitRequestsLimit");
      });

      it("should process new amount of requests if new day come", async () => {
        await exitLimit.harness_setState(0, 50, 1);
        const newData = await exitLimit.setExitDailyLimit(50, BigInt(DAY));
        await exitLimit.harness_setState(newData.dailyLimit, newData.dailyExitCount, newData.currentDay);
        const result = await exitLimit.consumeLimit(1, 2n * BigInt(DAY));
        expect(result).to.equal(1);
      });
    });

    context("checkLimit", () => {
      it("should allow unlimited exits when dailyLimit was not set", async () => {
        await exitLimit.harness_setState(0, 0, 0);
        const tx = await exitLimit.checkLimit(100, 0);
        await expect(tx).to.emit(exitLimit, "CheckLimitDone");
      });

      it("should reset on new day and pass checks if under limit", async () => {
        await exitLimit.harness_setState(10, 5, 1);
        const tx = await exitLimit.checkLimit(8, 2n * BigInt(DAY));
        await expect(tx).to.emit(exitLimit, "CheckLimitDone");
      });

      it("should revert if limit doesnt cover required amount of requests", async () => {
        await exitLimit.harness_setState(10, 8, 0);
        await expect(exitLimit.checkLimit(5, 0)).to.be.revertedWithCustomError(exitLimit, "ExitRequestsLimit");
      });

      it("should revert if no limit left", async () => {
        await exitLimit.harness_setState(5, 5, 0);
        await expect(exitLimit.checkLimit(1, 0)).to.be.revertedWithCustomError(exitLimit, "ExitRequestsLimit");
      });

      it("should respect new dailyLimit after changing from unlimited", async () => {
        await exitLimit.harness_setState(0, 50, 0);
        const newData = await exitLimit.setExitDailyLimit(60, 0);
        await exitLimit.harness_setState(newData.dailyLimit, newData.dailyExitCount, newData.currentDay);
        const tx = await exitLimit.checkLimit(10, 0);
        await expect(tx).to.emit(exitLimit, "CheckLimitDone");
      });

      it("should revert if after new dailyLimit dailyEXitCount exceed accepted amount", async () => {
        await exitLimit.harness_setState(0, 50, 0);
        const newData = await exitLimit.setExitDailyLimit(60, 0);
        await exitLimit.harness_setState(newData.dailyLimit, newData.dailyExitCount, newData.currentDay);
        await expect(exitLimit.checkLimit(11, 0)).to.be.revertedWithCustomError(exitLimit, "ExitRequestsLimit");
      });

      it("should process new amount of requests if new day come", async () => {
        await exitLimit.harness_setState(0, 50, 1);
        const newData = await exitLimit.setExitDailyLimit(50, BigInt(DAY));
        await exitLimit.harness_setState(newData.dailyLimit, newData.dailyExitCount, newData.currentDay);
        const tx = await exitLimit.checkLimit(1, 2n * BigInt(DAY));
        await expect(tx).to.emit(exitLimit, "CheckLimitDone");
      });
    });

    context("updateRequestsCounter", () => {
      it("should revert if newCount exceed uint96", async () => {
        await exitLimit.harness_setState(0, 0, 0);

        await expect(exitLimit.updateRequestsCounter(2n ** 96n, 2n * BigInt(DAY))).to.be.revertedWith(
          "TOO_LARGE_REQUESTS_COUNT_LIMIT",
        );
      });

      it("should reset dailyExitLimit and currentDay on new day", async () => {
        await exitLimit.harness_setState(0, 50, 1);

        const result = await exitLimit.updateRequestsCounter(30, 2n * BigInt(DAY));

        expect(result.currentDay).to.equal(2);
        expect(result.dailyExitCount).to.equal(30);
        expect(result.dailyLimit).to.equal(0);
      });

      it("should revert if new dailyExitCount exceed uint96", async () => {
        await exitLimit.harness_setState(0, 100, 0);

        await expect(exitLimit.updateRequestsCounter(2n ** 96n - 1n, 0)).to.be.revertedWith(
          "DAILY_EXIT_COUNT_OVERFLOW",
        );
      });

      it("should revert if new dailyExitCount more than dailyLimit", async () => {
        await exitLimit.harness_setState(100, 50, 0);

        await expect(exitLimit.updateRequestsCounter(2n ** 96n - 1n, 0)).to.be.revertedWith(
          "DAILY_EXIT_COUNT_OVERFLOW",
        );
      });

      it("should accumulate dailyExitCount even if requests are unlimited", async () => {
        await exitLimit.harness_setState(0, 50, 1);

        const result = await exitLimit.updateRequestsCounter(30, BigInt(DAY));
        expect(result.currentDay).to.equal(1);
        expect(result.dailyExitCount).to.equal(80);
        expect(result.dailyLimit).to.equal(0);
      });
    });
  });
});
