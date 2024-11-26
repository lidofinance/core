import { expect } from "chai";
import { ethers } from "hardhat";

import { time } from "@nomicfoundation/hardhat-network-helpers";

import { PausableUntil__Harness } from "typechain-types";

import { MAX_UINT256 } from "lib";

describe("PausableUtils.sol", () => {
  let pausable: PausableUntil__Harness;

  beforeEach(async () => {
    pausable = await ethers.deployContract("PausableUntil__Harness");
  });

  context("Constants", () => {
    it("Returns the PAUSE_INFINITELY variable", async () => {
      expect(await pausable.PAUSE_INFINITELY()).to.equal(MAX_UINT256);
    });
  });

  context("Modifiers", () => {
    context("whenPaused", () => {
      it("Reverts if contract is not paused", async () => {
        await expect(pausable.modifierWhenPaused()).to.be.revertedWithCustomError(pausable, "PausedExpected");
      });

      it("Does not revert if contract is paused", async () => {
        await expect(pausable.harness__pauseFor(1000n)).to.emit(pausable, "Paused");

        await expect(pausable.modifierWhenPaused()).to.not.be.reverted;
      });
    });

    context("whenResumed", () => {
      it("Reverts if contract is paused", async () => {
        await expect(pausable.harness__pauseFor(1000n)).to.emit(pausable, "Paused");

        await expect(pausable.modifierWhenResumed()).to.be.revertedWithCustomError(pausable, "ResumedExpected");
      });

      it("Does not revert if contract is not paused", async () => {
        await expect(pausable.modifierWhenResumed()).to.not.be.reverted;
      });
    });
  });

  context("isPaused", () => {
    it("Returns false if not paused", async () => {
      expect(await pausable.isPaused()).to.equal(false);
    });

    it("Returns true if paused", async () => {
      await expect(pausable.harness__pauseFor(1000n)).to.emit(pausable, "Paused");

      expect(await pausable.isPaused()).to.equal(true);
    });
  });

  context("getResumeSinceTimestamp", () => {
    it("Returns 0 if contract is paused", async () => {
      expect(await pausable.getResumeSinceTimestamp()).to.equal(0);
    });

    it("Returns the duration since the contract was paused", async () => {
      await pausable.harness__pauseFor(1000n);
      const timestamp = await time.latest();

      expect(await pausable.getResumeSinceTimestamp()).to.equal(timestamp + 1000);
    });
  });

  context("_pauseFor", () => {
    it("Reverts if contract is already paused", async () => {
      await expect(pausable.harness__pauseFor(1000n)).to.emit(pausable, "Paused");

      await expect(pausable.harness__pauseFor(1000n)).to.be.revertedWithCustomError(pausable, "ResumedExpected");
    });

    it("Reverts if zero pause duration", async () => {
      await expect(pausable.harness__pauseFor(0)).to.be.revertedWithCustomError(pausable, "ZeroPauseDuration");
    });

    it("Pauses contract correctly and emits `Paused` event", async () => {
      await expect(pausable.harness__pauseFor(404n)).to.emit(pausable, "Paused").withArgs(404n);
    });

    it("Pauses contract to MAX_UINT256 and emits `Paused` event", async () => {
      await expect(pausable.harness__pauseFor(MAX_UINT256)).to.emit(pausable, "Paused").withArgs(MAX_UINT256);
    });
  });

  context("_pauseUntil", () => {
    it("Reverts if contract is already paused", async () => {
      await expect(pausable.harness__pauseFor(1000n)).to.emit(pausable, "Paused");

      await expect(pausable.harness__pauseFor(1000n)).to.be.revertedWithCustomError(pausable, "ResumedExpected");
    });

    it("Reverts if timestamp is in the past", async () => {
      await expect(pausable.harness__pauseUntil(0)).to.be.revertedWithCustomError(pausable, "PauseUntilMustBeInFuture");
    });

    it("Pauses contract correctly and emits `Paused` event", async () => {
      const timestamp = await time.latest();

      await expect(pausable.harness__pauseUntil(timestamp + 1000))
        .to.emit(pausable, "Paused")
        .withArgs(1000n);
    });

    it("Pauses contract to MAX_UINT256 and emits `Paused` event", async () => {
      await expect(pausable.harness__pauseUntil(MAX_UINT256)).to.emit(pausable, "Paused").withArgs(MAX_UINT256);
    });
  });

  context("_resume", async () => {
    it("Reverts if contract is not paused", async () => {
      await expect(pausable.harness__resume()).to.be.revertedWithCustomError(pausable, "PausedExpected");
    });

    it("Resumes the contract", async () => {
      await expect(pausable.harness__pauseFor(1000n)).to.emit(pausable, "Paused");

      await expect(pausable.harness__resume()).to.emit(pausable, "Resumed");
      expect(await pausable.isPaused()).to.equal(false);
    });

    it("Reverts if already resumed", async () => {
      await expect(pausable.harness__pauseFor(1000n)).to.emit(pausable, "Paused");

      await expect(pausable.harness__resume()).to.emit(pausable, "Resumed");

      await expect(pausable.harness__resume()).to.be.revertedWithCustomError(pausable, "PausedExpected");
      expect(await pausable.isPaused()).to.equal(false);
    });
  });

  context("_setPausedState", async () => {
    let timestamp: number;

    beforeEach(async () => {
      timestamp = await time.latest();
    });

    it("Pauses the contract", async () => {
      const resumeSinceTimestamp = BigInt(timestamp) + 1000n;

      await expect(pausable.harness__setPauseState(resumeSinceTimestamp)).to.emit(pausable, "Paused").withArgs(999n); // X+1000n - X+1n for the block timestamp

      expect(await pausable.isPaused()).to.equal(true);
    });

    it("Pauses the contract to MAX_UINT256", async () => {
      await expect(pausable.harness__setPauseState(MAX_UINT256)).to.emit(pausable, "Paused");

      expect(await pausable.isPaused()).to.equal(true);
    });

    it("Resumes the contract", async () => {
      await expect(pausable.harness__setPauseState(timestamp + 1))
        .to.emit(pausable, "Paused")
        .withArgs(0n);

      expect(await pausable.isPaused()).to.equal(false);
    });
  });
});
