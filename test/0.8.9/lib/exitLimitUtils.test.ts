import { expect } from "chai";
import { ethers } from "hardhat";

import { ExitLimitUtils__Harness, ExitLimitUtilsStorage__Harness } from "typechain-types";

interface ExitRequestLimitData {
  maxExitRequestsLimit: bigint;
  prevExitRequestsLimit: bigint;
  prevTimestamp: bigint;
  frameDurationInSec: bigint;
  exitsPerFrame: bigint;
}

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
        maxExitRequestsLimit: 0n,
        prevExitRequestsLimit: 0n,
        prevTimestamp: 0n,
        frameDurationInSec: 0n,
        exitsPerFrame: 0n,
      };

      await exitLimitStorage.setStorageExitRequestLimit(data);

      const result = await exitLimitStorage.getStorageExitRequestLimit();
      expect(result.maxExitRequestsLimit).to.equal(0n);
      expect(result.prevExitRequestsLimit).to.equal(0n);
      expect(result.prevTimestamp).to.equal(0n);
      expect(result.frameDurationInSec).to.equal(0n);
      expect(result.exitsPerFrame).to.equal(0n);
    });

    it("Max possible values", async () => {
      const MAX_UINT32 = 2n ** 32n - 1n;

      data = {
        maxExitRequestsLimit: MAX_UINT32,
        prevExitRequestsLimit: MAX_UINT32,
        prevTimestamp: MAX_UINT32,
        frameDurationInSec: MAX_UINT32,
        exitsPerFrame: MAX_UINT32,
      };

      await exitLimitStorage.setStorageExitRequestLimit(data);

      const result = await exitLimitStorage.getStorageExitRequestLimit();
      expect(result.maxExitRequestsLimit).to.equal(MAX_UINT32);
      expect(result.prevExitRequestsLimit).to.equal(MAX_UINT32);
      expect(result.prevTimestamp).to.equal(MAX_UINT32);
      expect(result.frameDurationInSec).to.equal(MAX_UINT32);
      expect(result.exitsPerFrame).to.equal(MAX_UINT32);
    });

    it("Some random values", async () => {
      const maxExitRequestsLimit = 100n;
      const prevExitRequestsLimit = 9n;
      const prevTimestamp = 90n;
      const frameDurationInSec = 10n;
      const exitsPerFrame = 1n;

      data = {
        maxExitRequestsLimit,
        prevExitRequestsLimit,
        prevTimestamp,
        frameDurationInSec,
        exitsPerFrame,
      };

      await exitLimitStorage.setStorageExitRequestLimit(data);

      const result = await exitLimitStorage.getStorageExitRequestLimit();
      expect(result.maxExitRequestsLimit).to.equal(maxExitRequestsLimit);
      expect(result.prevExitRequestsLimit).to.equal(prevExitRequestsLimit);
      expect(result.prevTimestamp).to.equal(prevTimestamp);
      expect(result.frameDurationInSec).to.equal(frameDurationInSec);
      expect(result.exitsPerFrame).to.equal(exitsPerFrame);
    });
  });

  context("ExitLimitUtils", () => {
    context("calculateCurrentExitLimit", () => {
      beforeEach(async () => {
        await exitLimit.harness_setState(0, 0, 0, 0, 0);
      });

      it("should return prevExitRequestsLimit value (nothing restored), if no time passed", async () => {
        const timestamp = 1000;
        const maxExitRequestsLimit = 10;
        const prevExitRequestsLimit = 5; // remaining limit from prev usage
        const exitsPerFrame = 1;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          maxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          timestamp,
        );

        const result = await exitLimit.calculateCurrentExitLimit(timestamp);
        expect(result).to.equal(prevExitRequestsLimit);
      });

      it("should return prevExitRequestsLimit value (nothing restored), if less than one frame passed", async () => {
        const prevTimestamp = 1000;
        const maxExitRequestsLimit = 10;
        const prevExitRequestsLimit = 5; // remaining limit from prev usage
        const exitsPerFrame = 1;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          maxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          prevTimestamp,
        );

        const result = await exitLimit.calculateCurrentExitLimit(prevTimestamp + 9);
        expect(result).to.equal(prevExitRequestsLimit);
      });

      it("Should return prevExitRequestsLimit + 1 (restored one exit), if exactly one frame passed", async () => {
        const prevTimestamp = 1000;
        const maxExitRequestsLimit = 10;
        const prevExitRequestsLimit = 5; // remaining limit from prev usage
        const exitsPerFrame = 1;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          maxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          prevTimestamp,
        );

        const result = await exitLimit.calculateCurrentExitLimit(prevTimestamp + frameDurationInSec);
        expect(result).to.equal(prevExitRequestsLimit + 1);
      });

      it("Should return prevExitRequestsLimit + restored value, if multiple full frames passed, restored value does not exceed maxExitRequestsLimit", async () => {
        const prevTimestamp = 1000;
        const maxExitRequestsLimit = 20;
        const prevExitRequestsLimit = 5; // remaining limit from prev usage
        const exitsPerFrame = 1;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          maxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          prevTimestamp,
        );
        const result = await exitLimit.calculateCurrentExitLimit(prevTimestamp + 40);
        expect(result).to.equal(prevExitRequestsLimit + 4);
      });

      it("Should return maxExitRequestsLimit, if restored limit exceeds max", async () => {
        const prevTimestamp = 1000;
        const maxExitRequestsLimit = 100;
        const prevExitRequestsLimit = 90; // remaining limit from prev usage
        const exitsPerFrame = 3;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          maxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          prevTimestamp,
        );

        const result = await exitLimit.calculateCurrentExitLimit(prevTimestamp + 100); // 10 frames * 3 = 30
        expect(result).to.equal(maxExitRequestsLimit);
      });

      it("Should return prevExitRequestsLimit, if exitsPerFrame = 0", async () => {
        const prevTimestamp = 1000;
        const maxExitRequestsLimit = 100;
        const prevExitRequestsLimit = 7; // remaining limit from prev usage
        const exitsPerFrame = 0;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          maxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          prevTimestamp,
        );

        const result = await exitLimit.calculateCurrentExitLimit(prevTimestamp + 100);
        expect(result).to.equal(7);
      });

      it("non-multiple frame passed (should truncate fractional frame)", async () => {
        const prevTimestamp = 1000;
        const maxExitRequestsLimit = 20;
        const prevExitRequestsLimit = 5; // remaining limit from prev usage
        const exitsPerFrame = 1;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          maxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          prevTimestamp,
        );

        const result = await exitLimit.calculateCurrentExitLimit(prevTimestamp + 25);
        expect(result).to.equal(7); // 5 + 2
      });
    });

    context("updatePrevExitLimit", () => {
      beforeEach(async () => {
        await exitLimit.harness_setState(0, 0, 0, 0, 0);
      });

      it("should revert with LIMIT_EXCEEDED, if newExitRequestLimit exceeded maxExitRequestsLimit", async () => {
        const prevTimestamp = 1000;

        const maxExitRequestsLimit = 10;
        const prevExitRequestsLimit = 5; // remaining limit from prev usage
        const exitsPerFrame = 1;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          maxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          prevTimestamp,
        );

        await expect(exitLimit.updatePrevExitLimit(11, prevTimestamp + 10)).to.be.revertedWithCustomError(
          exitLimit,
          "LimitExceeded",
        );
      });

      it("should increase prevTimestamp on frame duration if one frame passed", async () => {
        const prevTimestamp = 1000;

        const maxExitRequestsLimit = 10;
        const prevExitRequestsLimit = 5; // remaining limit from prev usage
        const exitsPerFrame = 1;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          maxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          prevTimestamp,
        );

        const updated = await exitLimit.updatePrevExitLimit(4, prevTimestamp + 10);
        expect(updated.prevExitRequestsLimit).to.equal(4);
        expect(updated.prevTimestamp).to.equal(prevTimestamp + 10);
      });

      it("should not change prevTimestamp, as less than frame passed", async () => {
        const prevTimestamp = 1000;
        const maxExitRequestsLimit = 10;
        const prevExitRequestsLimit = 5; // remaining limit from prev usage
        const exitsPerFrame = 1;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          maxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          prevTimestamp,
        );

        const updated = await exitLimit.updatePrevExitLimit(3, prevTimestamp + 9);
        expect(updated.prevExitRequestsLimit).to.equal(3);
        expect(updated.prevTimestamp).to.equal(prevTimestamp);
      });

      it("should increase prevTimestamp on multiple frames value, if multiple frames passed", async () => {
        const prevTimestamp = 1000;
        const maxExitRequestsLimit = 100;
        const prevExitRequestsLimit = 90; // remaining limit from prev usage
        const exitsPerFrame = 5;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          maxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          prevTimestamp,
        );

        const updated = await exitLimit.updatePrevExitLimit(85, prevTimestamp + 45);
        expect(updated.prevExitRequestsLimit).to.equal(85);
        expect(updated.prevTimestamp).to.equal(prevTimestamp + 40);
      });

      it("should not change prevTimestamp, if no time passed", async () => {
        const prevTimestamp = 1000;
        const maxExitRequestsLimit = 50;
        const prevExitRequestsLimit = 25; // remaining limit from prev usage
        const exitsPerFrame = 2;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          maxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          prevTimestamp,
        );

        const updated = await exitLimit.updatePrevExitLimit(20, prevTimestamp);
        expect(updated.prevExitRequestsLimit).to.equal(20);
        expect(updated.prevTimestamp).to.equal(prevTimestamp);
      });
    });

    context("setExitLimits", () => {
      beforeEach(async () => {
        await exitLimit.harness_setState(0, 0, 0, 0, 0);
      });

      it("should initialize limits", async () => {
        const timestamp = 1000;
        const maxExitRequestsLimit = 100;
        const exitsPerFrame = 2;
        const frameDurationInSec = 10;

        const result = await exitLimit.setExitLimits(
          maxExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          timestamp,
        );

        expect(result.maxExitRequestsLimit).to.equal(maxExitRequestsLimit);
        expect(result.exitsPerFrame).to.equal(exitsPerFrame);
        expect(result.frameDurationInSec).to.equal(frameDurationInSec);
        expect(result.prevExitRequestsLimit).to.equal(maxExitRequestsLimit);
        expect(result.prevTimestamp).to.equal(timestamp);
      });

      it("should set prevExitRequestsLimit to new maxExitRequestsLimit, if new maxExitRequestsLimit is lower than prevExitRequestsLimit", async () => {
        const timestamp = 900;
        const oldMaxExitRequestsLimit = 100;
        const prevExitRequestsLimit = 80;
        const exitsPerFrame = 2;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          oldMaxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          timestamp,
        );

        const newMaxExitRequestsLimit = 50;
        const result = await exitLimit.setExitLimits(
          newMaxExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          timestamp,
        );

        expect(result.maxExitRequestsLimit).to.equal(newMaxExitRequestsLimit);
        expect(result.prevExitRequestsLimit).to.equal(newMaxExitRequestsLimit);
        expect(result.prevTimestamp).to.equal(timestamp);
      });

      it("should not update prevExitRequestsLimit, if new maxExitRequestsLimit is higher", async () => {
        const timestamp = 900;
        const oldMaxExitRequestsLimit = 100;
        const prevExitRequestsLimit = 80;
        const exitsPerFrame = 2;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          oldMaxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          timestamp,
        );

        const newMaxExitRequestsLimit = 150;

        const result = await exitLimit.setExitLimits(
          newMaxExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          timestamp,
        );

        expect(result.maxExitRequestsLimit).to.equal(newMaxExitRequestsLimit);
        expect(result.prevExitRequestsLimit).to.equal(prevExitRequestsLimit);
        expect(result.prevTimestamp).to.equal(timestamp);
      });

      it("should reset prevExitRequestsLimit if old max was zero", async () => {
        const timestamp = 900;
        const oldMaxExitRequestsLimit = 0;
        const prevExitRequestsLimit = 0;
        const exitsPerFrame = 2;
        const frameDurationInSec = 10;

        await exitLimit.harness_setState(
          oldMaxExitRequestsLimit,
          prevExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          timestamp,
        );

        const newMaxExitRequestsLimit = 77;
        const result = await exitLimit.setExitLimits(
          newMaxExitRequestsLimit,
          exitsPerFrame,
          frameDurationInSec,
          timestamp,
        );

        expect(result.maxExitRequestsLimit).to.equal(newMaxExitRequestsLimit);
        expect(result.prevExitRequestsLimit).to.equal(newMaxExitRequestsLimit);
        expect(result.prevTimestamp).to.equal(timestamp);
      });

      it("should revert if maxExitRequestsLimit is too large", async () => {
        const MAX_UINT32 = 2 ** 32;
        await expect(exitLimit.setExitLimits(MAX_UINT32, 1, 10, 1000)).to.be.revertedWithCustomError(
          exitLimit,
          "TooLargeMaxExitRequestsLimit",
        );
      });

      it("should revert if exitsPerFrame bigger than maxExitRequestsLimit", async () => {
        await expect(exitLimit.setExitLimits(100, 101, 10, 1000)).to.be.revertedWithCustomError(
          exitLimit,
          "TooLargeExitsPerFrame",
        );
      });

      it("should revert if frameDurationInSec is too large", async () => {
        const MAX_UINT32 = 2 ** 32;
        await expect(exitLimit.setExitLimits(100, 2, MAX_UINT32, 1000)).to.be.revertedWithCustomError(
          exitLimit,
          "TooLargeFrameDuration",
        );
      });
    });

    context("isExitLimitSet", () => {
      it("returns false when maxExitRequestsLimit is 0", async () => {
        await exitLimit.harness_setState(0, 0, 0, 0, 0);

        const result = await exitLimit.isExitLimitSet();
        expect(result).to.be.false;
      });

      it("returns true when maxExitRequestsLimit is non-zero", async () => {
        await exitLimit.harness_setState(100, 50, 2, 10, 1000);

        const result = await exitLimit.isExitLimitSet();
        expect(result).to.be.true;
      });
    });
  });
});
