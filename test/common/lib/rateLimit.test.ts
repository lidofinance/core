import { expect } from "chai";
import { ethers } from "hardhat";

interface LimitData {
  maxLimit: bigint;
  prevLimit: bigint;
  prevTimestamp: bigint;
  frameDurationInSec: bigint;
  itemsPerFrame: bigint;
}

describe("RateLimit.sol", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rateLimitStorage: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rateLimit: any;

  before(async () => {
    rateLimitStorage = await ethers.deployContract("RateLimitStorage__Harness");
    rateLimit = await ethers.deployContract("RateLimit__Harness");
  });

  context("RateLimitStorage", () => {
    let data: LimitData;

    it("Min possible values", async () => {
      data = {
        maxLimit: 0n,
        prevLimit: 0n,
        prevTimestamp: 0n,
        frameDurationInSec: 0n,
        itemsPerFrame: 0n,
      };

      await rateLimitStorage.setStorageLimit(data);

      const result = await rateLimitStorage.getStorageLimit();
      expect(result.maxLimit).to.equal(0n);
      expect(result.prevLimit).to.equal(0n);
      expect(result.prevTimestamp).to.equal(0n);
      expect(result.frameDurationInSec).to.equal(0n);
      expect(result.itemsPerFrame).to.equal(0n);
    });

    it("Max possible values", async () => {
      const MAX_UINT32 = 2n ** 32n - 1n;

      data = {
        maxLimit: MAX_UINT32,
        prevLimit: MAX_UINT32,
        prevTimestamp: MAX_UINT32,
        frameDurationInSec: MAX_UINT32,
        itemsPerFrame: MAX_UINT32,
      };

      await rateLimitStorage.setStorageLimit(data);

      const result = await rateLimitStorage.getStorageLimit();
      expect(result.maxLimit).to.equal(MAX_UINT32);
      expect(result.prevLimit).to.equal(MAX_UINT32);
      expect(result.prevTimestamp).to.equal(MAX_UINT32);
      expect(result.frameDurationInSec).to.equal(MAX_UINT32);
      expect(result.itemsPerFrame).to.equal(MAX_UINT32);
    });

    it("Some random values", async () => {
      const maxLimit = 100n;
      const prevLimit = 9n;
      const prevTimestamp = 90n;
      const frameDurationInSec = 10n;
      const itemsPerFrame = 1n;

      data = {
        maxLimit,
        prevLimit,
        prevTimestamp,
        frameDurationInSec,
        itemsPerFrame,
      };

      await rateLimitStorage.setStorageLimit(data);

      const result = await rateLimitStorage.getStorageLimit();
      expect(result.maxLimit).to.equal(maxLimit);
      expect(result.prevLimit).to.equal(prevLimit);
      expect(result.prevTimestamp).to.equal(prevTimestamp);
      expect(result.frameDurationInSec).to.equal(frameDurationInSec);
      expect(result.itemsPerFrame).to.equal(itemsPerFrame);
    });
  });

  context("RateLimit", () => {
    context("calculateCurrentLimit", () => {
      beforeEach(async () => {
        await rateLimit.harness_setState(0, 0, 0, 0, 0);
      });

      it("should return prevLimit value (nothing restored), if no time passed", async () => {
        const timestamp = 1000;
        const maxLimit = 10;
        const prevLimit = 5; // remaining limit from prev usage
        const itemsPerFrame = 1;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(maxLimit, prevLimit, itemsPerFrame, frameDurationInSec, timestamp);

        const result = await rateLimit.calculateCurrentLimit(timestamp);
        expect(result).to.equal(prevLimit);
      });

      it("should return prevLimit value (nothing restored), if less than one frame passed", async () => {
        const prevTimestamp = 1000;
        const maxLimit = 10;
        const prevLimit = 5; // remaining limit from prev usage
        const itemsPerFrame = 1;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(maxLimit, prevLimit, itemsPerFrame, frameDurationInSec, prevTimestamp);

        const result = await rateLimit.calculateCurrentLimit(prevTimestamp + 9);
        expect(result).to.equal(prevLimit);
      });

      it("Should return prevLimit + 1 (restored one item), if exactly one frame passed", async () => {
        const prevTimestamp = 1000;
        const maxLimit = 10;
        const prevLimit = 5; // remaining limit from prev usage
        const itemsPerFrame = 1;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(maxLimit, prevLimit, itemsPerFrame, frameDurationInSec, prevTimestamp);

        const result = await rateLimit.calculateCurrentLimit(prevTimestamp + frameDurationInSec);
        expect(result).to.equal(prevLimit + 1);
      });

      it("Should return prevLimit + restored value, if multiple full frames passed, restored value does not exceed maxLimit", async () => {
        const prevTimestamp = 1000;
        const maxLimit = 20;
        const prevLimit = 5; // remaining limit from prev usage
        const itemsPerFrame = 1;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(maxLimit, prevLimit, itemsPerFrame, frameDurationInSec, prevTimestamp);
        const result = await rateLimit.calculateCurrentLimit(prevTimestamp + 40);
        expect(result).to.equal(prevLimit + 4);
      });

      it("Should return maxLimit, if restored limit exceeds max", async () => {
        const prevTimestamp = 1000;
        const maxLimit = 100;
        const prevLimit = 90; // remaining limit from prev usage
        const itemsPerFrame = 3;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(maxLimit, prevLimit, itemsPerFrame, frameDurationInSec, prevTimestamp);

        const result = await rateLimit.calculateCurrentLimit(prevTimestamp + 100); // 10 frames * 3 = 30
        expect(result).to.equal(maxLimit);
      });

      it("Should return prevLimit, if itemsPerFrame = 0", async () => {
        const prevTimestamp = 1000;
        const maxLimit = 100;
        const prevLimit = 7; // remaining limit from prev usage
        const itemsPerFrame = 0;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(maxLimit, prevLimit, itemsPerFrame, frameDurationInSec, prevTimestamp);

        const result = await rateLimit.calculateCurrentLimit(prevTimestamp + 100);
        expect(result).to.equal(7);
      });

      it("non-multiple frame passed (should truncate fractional frame)", async () => {
        const prevTimestamp = 1000;
        const maxLimit = 20;
        const prevLimit = 5; // remaining limit from prev usage
        const itemsPerFrame = 1;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(maxLimit, prevLimit, itemsPerFrame, frameDurationInSec, prevTimestamp);

        const result = await rateLimit.calculateCurrentLimit(prevTimestamp + 25);
        expect(result).to.equal(7); // 5 + 2
      });
    });

    context("updatePrevLimit", () => {
      beforeEach(async () => {
        await rateLimit.harness_setState(0, 0, 0, 0, 0);
      });

      it("should revert with LimitExceeded, if newLimit exceeded maxLimit", async () => {
        const prevTimestamp = 1000;

        const maxLimit = 10;
        const prevLimit = 5; // remaining limit from prev usage
        const itemsPerFrame = 1;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(maxLimit, prevLimit, itemsPerFrame, frameDurationInSec, prevTimestamp);

        await expect(rateLimit.updatePrevLimit(11, prevTimestamp + 10)).to.be.revertedWithCustomError(
          rateLimit,
          "LimitExceeded",
        );
      });

      it("should increase prevTimestamp on frame duration if one frame passed", async () => {
        const prevTimestamp = 1000;

        const maxLimit = 10;
        const prevLimit = 5; // remaining limit from prev usage
        const itemsPerFrame = 1;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(maxLimit, prevLimit, itemsPerFrame, frameDurationInSec, prevTimestamp);

        const updated = await rateLimit.updatePrevLimit(4, prevTimestamp + 10);
        expect(updated.prevLimit).to.equal(4);
        expect(updated.prevTimestamp).to.equal(prevTimestamp + 10);
      });

      it("should not change prevTimestamp, as less than frame passed", async () => {
        const prevTimestamp = 1000;
        const maxLimit = 10;
        const prevLimit = 5; // remaining limit from prev usage
        const itemsPerFrame = 1;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(maxLimit, prevLimit, itemsPerFrame, frameDurationInSec, prevTimestamp);

        const updated = await rateLimit.updatePrevLimit(3, prevTimestamp + 9);
        expect(updated.prevLimit).to.equal(3);
        expect(updated.prevTimestamp).to.equal(prevTimestamp);
      });

      it("should increase prevTimestamp on multiple frames value, if multiple frames passed", async () => {
        const prevTimestamp = 1000;
        const maxLimit = 100;
        const prevLimit = 90; // remaining limit from prev usage
        const itemsPerFrame = 5;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(maxLimit, prevLimit, itemsPerFrame, frameDurationInSec, prevTimestamp);

        const updated = await rateLimit.updatePrevLimit(85, prevTimestamp + 45);
        expect(updated.prevLimit).to.equal(85);
        expect(updated.prevTimestamp).to.equal(prevTimestamp + 40);
      });

      it("should not change prevTimestamp, if no time passed", async () => {
        const prevTimestamp = 1000;
        const maxLimit = 50;
        const prevLimit = 25; // remaining limit from prev usage
        const itemsPerFrame = 2;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(maxLimit, prevLimit, itemsPerFrame, frameDurationInSec, prevTimestamp);

        const updated = await rateLimit.updatePrevLimit(20, prevTimestamp);
        expect(updated.prevLimit).to.equal(20);
        expect(updated.prevTimestamp).to.equal(prevTimestamp);
      });
    });

    context("setLimits", () => {
      beforeEach(async () => {
        await rateLimit.harness_setState(0, 0, 0, 0, 0);
      });

      it("should initialize limits", async () => {
        const timestamp = 1000;
        const maxLimit = 100;
        const itemsPerFrame = 2;
        const frameDurationInSec = 10;

        const result = await rateLimit.setLimits(maxLimit, itemsPerFrame, frameDurationInSec, timestamp);

        expect(result.maxLimit).to.equal(maxLimit);
        expect(result.itemsPerFrame).to.equal(itemsPerFrame);
        expect(result.frameDurationInSec).to.equal(frameDurationInSec);
        expect(result.prevLimit).to.equal(maxLimit);
        expect(result.prevTimestamp).to.equal(timestamp);
      });

      it("should set prevLimit to new maxLimit, if new maxLimit is lower than prevLimit", async () => {
        const timestamp = 900;
        const oldMaxLimit = 100;
        const prevLimit = 80;
        const itemsPerFrame = 2;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(oldMaxLimit, prevLimit, itemsPerFrame, frameDurationInSec, timestamp);

        const newMaxLimit = 50;
        const result = await rateLimit.setLimits(newMaxLimit, itemsPerFrame, frameDurationInSec, timestamp);

        expect(result.maxLimit).to.equal(newMaxLimit);
        expect(result.prevLimit).to.equal(newMaxLimit);
        expect(result.prevTimestamp).to.equal(timestamp);
      });

      it("should not update prevLimit, if new maxLimit is higher", async () => {
        const timestamp = 900;
        const oldMaxLimit = 100;
        const prevLimit = 80;
        const itemsPerFrame = 2;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(oldMaxLimit, prevLimit, itemsPerFrame, frameDurationInSec, timestamp);

        const newMaxLimit = 150;
        const result = await rateLimit.setLimits(newMaxLimit, itemsPerFrame, frameDurationInSec, timestamp);

        expect(result.maxLimit).to.equal(newMaxLimit);
        expect(result.prevLimit).to.equal(prevLimit);
        expect(result.prevTimestamp).to.equal(timestamp);
      });

      it("should reset prevLimit if old max was zero", async () => {
        const timestamp = 900;
        const oldMaxLimit = 0;
        const prevLimit = 80;
        const itemsPerFrame = 2;
        const frameDurationInSec = 10;

        await rateLimit.harness_setState(oldMaxLimit, prevLimit, itemsPerFrame, frameDurationInSec, timestamp);

        const newMaxLimit = 150;
        const result = await rateLimit.setLimits(newMaxLimit, itemsPerFrame, frameDurationInSec, timestamp);

        expect(result.maxLimit).to.equal(newMaxLimit);
        expect(result.prevLimit).to.equal(newMaxLimit);
        expect(result.prevTimestamp).to.equal(timestamp);
      });

      it("should revert if maxLimit is too large", async () => {
        const timestamp = 1000;
        const maxLimit = 2n ** 32n; // exceeds uint32 max
        const itemsPerFrame = 2;
        const frameDurationInSec = 10;

        await expect(
          rateLimit.setLimits(maxLimit, itemsPerFrame, frameDurationInSec, timestamp),
        ).to.be.revertedWithCustomError(rateLimit, "TooLargeMaxLimit");
      });

      it("should revert if itemsPerFrame bigger than maxLimit", async () => {
        const timestamp = 1000;
        const maxLimit = 10;
        const itemsPerFrame = 15;
        const frameDurationInSec = 10;

        await expect(
          rateLimit.setLimits(maxLimit, itemsPerFrame, frameDurationInSec, timestamp),
        ).to.be.revertedWithCustomError(rateLimit, "TooLargeItemsPerFrame");
      });

      it("should revert if frameDurationInSec is too large", async () => {
        const timestamp = 1000;
        const maxLimit = 100;
        const itemsPerFrame = 2;
        const frameDurationInSec = 2n ** 32n; // exceeds uint32 max

        await expect(
          rateLimit.setLimits(maxLimit, itemsPerFrame, frameDurationInSec, timestamp),
        ).to.be.revertedWithCustomError(rateLimit, "TooLargeFrameDuration");
      });

      it("should revert if frameDurationInSec is zero", async () => {
        const timestamp = 1000;
        const maxLimit = 100;
        const itemsPerFrame = 2;
        const frameDurationInSec = 0;

        await expect(
          rateLimit.setLimits(maxLimit, itemsPerFrame, frameDurationInSec, timestamp),
        ).to.be.revertedWithCustomError(rateLimit, "ZeroFrameDuration");
      });
    });

    context("isLimitSet", () => {
      it("returns false when maxLimit is 0", async () => {
        await rateLimit.harness_setState(0, 10, 1, 10, 1000);
        const result = await rateLimit.isLimitSet();
        expect(result).to.be.false;
      });

      it("returns true when maxLimit is non-zero", async () => {
        await rateLimit.harness_setState(100, 50, 1, 10, 1000);
        const result = await rateLimit.isLimitSet();
        expect(result).to.be.true;
      });
    });
  });
});
