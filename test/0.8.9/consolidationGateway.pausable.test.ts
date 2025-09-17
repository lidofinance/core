import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationGateway, WithdrawalVault__MockForCG } from "typechain-types";

import { advanceChainTime, getCurrentBlockTimestamp, streccak } from "lib";

import { Snapshot } from "test/suite";

import { deployLidoLocator, updateLidoLocatorImplementation } from "../deploy/locator";

const PAUSE_ROLE = streccak("PAUSE_ROLE");
const RESUME_ROLE = streccak("RESUME_ROLE");

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
];

const ZERO_ADDRESS = ethers.ZeroAddress;

describe("ConsolidationGateway.sol: pausable", () => {
  let consolidationGateway: ConsolidationGateway;
  let withdrawalVault: WithdrawalVault__MockForCG;
  let admin: HardhatEthersSigner;
  let authorizedEntity: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalState: string;

  before(async () => {
    [admin, authorizedEntity, stranger] = await ethers.getSigners();

    const locator = await deployLidoLocator();
    const locatorAddr = await locator.getAddress();

    withdrawalVault = await ethers.deployContract("WithdrawalVault__MockForCG");

    await updateLidoLocatorImplementation(locatorAddr, {
      withdrawalVault: await withdrawalVault.getAddress(),
    });

    consolidationGateway = await ethers.deployContract("ConsolidationGateway", [admin, locatorAddr, 100, 1, 48]);

    const role = await consolidationGateway.ADD_CONSOLIDATION_REQUEST_ROLE();
    await consolidationGateway.grantRole(role, authorizedEntity);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("pausable until", () => {
    beforeEach(async () => {
      // set up necessary roles
      await consolidationGateway.connect(admin).grantRole(PAUSE_ROLE, admin);
      await consolidationGateway.connect(admin).grantRole(RESUME_ROLE, admin);
    });

    context("resume", () => {
      it("should revert if the sender does not have the RESUME_ROLE", async () => {
        // First pause the contract
        await consolidationGateway.connect(admin).pauseFor(1000n);

        // Try to resume without the RESUME_ROLE
        await expect(consolidationGateway.connect(stranger).resume()).to.be.revertedWithOZAccessControlError(
          stranger.address,
          RESUME_ROLE,
        );
      });

      it("should revert if the contract is not paused", async () => {
        // Contract is initially not paused
        await expect(consolidationGateway.connect(admin).resume()).to.be.revertedWithCustomError(
          consolidationGateway,
          "PausedExpected",
        );
      });

      it("should resume the contract when paused and emit Resumed event", async () => {
        // First pause the contract
        await consolidationGateway.connect(admin).pauseFor(1000n);
        expect(await consolidationGateway.isPaused()).to.equal(true);

        // Resume the contract
        await expect(consolidationGateway.connect(admin).resume()).to.emit(consolidationGateway, "Resumed");

        // Verify contract is resumed
        expect(await consolidationGateway.isPaused()).to.equal(false);
      });

      it("should allow consolidation requests after resuming", async () => {
        // First pause and then resume the contract
        await consolidationGateway.connect(admin).pauseFor(1000n);
        await consolidationGateway.connect(admin).resume();

        // Should be able to add consolidation requests
        await consolidationGateway
          .connect(authorizedEntity)
          .triggerConsolidation([PUBKEYS[0]], [PUBKEYS[1]], ZERO_ADDRESS, { value: 2 });
      });
    });

    context("pauseFor", () => {
      it("should revert if the sender does not have the PAUSE_ROLE", async () => {
        await expect(consolidationGateway.connect(stranger).pauseFor(1000n)).to.be.revertedWithOZAccessControlError(
          stranger.address,
          PAUSE_ROLE,
        );
      });

      it("should revert if the contract is already paused", async () => {
        // First pause the contract
        await consolidationGateway.connect(admin).pauseFor(1000n);

        // Try to pause again
        await expect(consolidationGateway.connect(admin).pauseFor(500n)).to.be.revertedWithCustomError(
          consolidationGateway,
          "ResumedExpected",
        );
      });

      it("should revert if pause duration is zero", async () => {
        await expect(consolidationGateway.connect(admin).pauseFor(0n)).to.be.revertedWithCustomError(
          consolidationGateway,
          "ZeroPauseDuration",
        );
      });

      it("should pause the contract for the specified duration and emit Paused event", async () => {
        await expect(consolidationGateway.connect(admin).pauseFor(1000n))
          .to.emit(consolidationGateway, "Paused")
          .withArgs(1000n);

        expect(await consolidationGateway.isPaused()).to.equal(true);
      });

      it("should pause the contract indefinitely with PAUSE_INFINITELY", async () => {
        const pauseInfinitely = await consolidationGateway.PAUSE_INFINITELY();

        // Pause the contract indefinitely
        await expect(consolidationGateway.connect(admin).pauseFor(pauseInfinitely))
          .to.emit(consolidationGateway, "Paused")
          .withArgs(pauseInfinitely);

        // Verify contract is paused
        expect(await consolidationGateway.isPaused()).to.equal(true);

        // Advance time significantly
        await advanceChainTime(1_000_000_000n);

        // Contract should still be paused
        expect(await consolidationGateway.isPaused()).to.equal(true);
      });

      it("should automatically resume after the pause duration passes", async () => {
        // Pause the contract for 100 seconds
        await consolidationGateway.connect(admin).pauseFor(100n);
        expect(await consolidationGateway.isPaused()).to.equal(true);

        // Advance time by 101 seconds
        await advanceChainTime(101n);

        // Contract should be automatically resumed
        expect(await consolidationGateway.isPaused()).to.equal(false);
      });
    });

    context("pauseUntil", () => {
      it("should revert if the sender does not have the PAUSE_ROLE", async () => {
        const timestamp = await getCurrentBlockTimestamp();
        await expect(
          consolidationGateway.connect(stranger).pauseUntil(timestamp + 1000n),
        ).to.be.revertedWithOZAccessControlError(stranger.address, PAUSE_ROLE);
      });

      it("should revert if the contract is already paused", async () => {
        const timestamp = await getCurrentBlockTimestamp();

        // First pause the contract
        await consolidationGateway.connect(admin).pauseFor(1000n);

        // Try to pause again with pauseUntil
        await expect(consolidationGateway.connect(admin).pauseUntil(timestamp + 1000n)).to.be.revertedWithCustomError(
          consolidationGateway,
          "ResumedExpected",
        );
      });

      it("should revert if timestamp is in the past", async () => {
        const timestamp = await getCurrentBlockTimestamp();

        await expect(consolidationGateway.connect(admin).pauseUntil(timestamp - 1000n)).to.be.revertedWithCustomError(
          consolidationGateway,
          "PauseUntilMustBeInFuture",
        );
      });

      it("should pause the contract until the specified timestamp and emit Paused event", async () => {
        const timestamp = await getCurrentBlockTimestamp();
        const pauseUntil = timestamp + 1000n;

        await expect(consolidationGateway.connect(admin).pauseUntil(pauseUntil))
          .to.emit(consolidationGateway, "Paused")
          .withArgs(pauseUntil - timestamp);

        expect(await consolidationGateway.isPaused()).to.equal(true);
      });

      it("should pause the contract indefinitely with PAUSE_INFINITELY", async () => {
        const pauseInfinitely = await consolidationGateway.PAUSE_INFINITELY();

        // Pause the contract indefinitely
        await expect(consolidationGateway.connect(admin).pauseUntil(pauseInfinitely))
          .to.emit(consolidationGateway, "Paused")
          .withArgs(pauseInfinitely);

        // Verify contract is paused
        expect(await consolidationGateway.isPaused()).to.equal(true);

        // Advance time significantly
        await advanceChainTime(1_000_000_000n);

        // Contract should still be paused
        expect(await consolidationGateway.isPaused()).to.equal(true);
      });

      it("should automatically resume after the pause timestamp passes", async () => {
        const timestamp = await getCurrentBlockTimestamp();
        const pauseUntil = timestamp + 100n;

        // Pause the contract until timestamp + 100
        await consolidationGateway.connect(admin).pauseUntil(pauseUntil);
        expect(await consolidationGateway.isPaused()).to.equal(true);

        // Advance time by 101 seconds
        await advanceChainTime(101n);

        // Contract should be automatically resumed
        expect(await consolidationGateway.isPaused()).to.equal(false);
      });
    });

    context("Interaction with triggerConsolidation", () => {
      it("pauseFor: should prevent consolidation requests immediately after pausing", async () => {
        // Pause the contract
        await consolidationGateway.connect(admin).pauseFor(1000n);

        // Should prevent consolidation requests
        await expect(
          consolidationGateway
            .connect(authorizedEntity)
            .triggerConsolidation([PUBKEYS[0]], [PUBKEYS[1]], ZERO_ADDRESS, { value: 2 }),
        ).to.be.revertedWithCustomError(consolidationGateway, "ResumedExpected");
      });

      it("pauseUntil: should prevent consolidation requests immediately after pausing", async () => {
        const timestamp = await getCurrentBlockTimestamp();

        // Pause the contract
        await consolidationGateway.connect(admin).pauseUntil(timestamp + 1000n);

        // Should prevent consolidation requests
        await expect(
          consolidationGateway
            .connect(authorizedEntity)
            .triggerConsolidation([PUBKEYS[0]], [PUBKEYS[1]], ZERO_ADDRESS, { value: 2 }),
        ).to.be.revertedWithCustomError(consolidationGateway, "ResumedExpected");
      });

      it("pauseFor: should allow consolidation requests immediately after resuming", async () => {
        // Pause and then resume the contract
        await consolidationGateway.connect(admin).pauseFor(1000n);
        await consolidationGateway.connect(admin).resume();

        // Should allow consolidation requests
        await consolidationGateway
          .connect(authorizedEntity)
          .triggerConsolidation([PUBKEYS[0]], [PUBKEYS[1]], ZERO_ADDRESS, { value: 2 });
      });

      it("pauseUntil: should allow consolidation requests immediately after resuming", async () => {
        const timestamp = await getCurrentBlockTimestamp();

        // Pause and then resume the contract
        await consolidationGateway.connect(admin).pauseUntil(timestamp + 1000n);
        await consolidationGateway.connect(admin).resume();

        // Should allow consolidation requests
        await consolidationGateway
          .connect(authorizedEntity)
          .triggerConsolidation([PUBKEYS[0]], [PUBKEYS[1]], ZERO_ADDRESS, { value: 2 });
      });

      it("pauseFor: should allow consolidation requests after pause duration automatically expires", async () => {
        // Pause the contract for 100 seconds
        await consolidationGateway.connect(admin).pauseFor(100n);

        // Advance time by 101 seconds
        await advanceChainTime(101n);

        // Should allow consolidation requests
        await consolidationGateway
          .connect(authorizedEntity)
          .triggerConsolidation([PUBKEYS[0]], [PUBKEYS[1]], ZERO_ADDRESS, { value: 2 });
      });

      it("pauseUntil: should allow consolidation requests after pause duration automatically expires", async () => {
        const timestamp = await getCurrentBlockTimestamp();

        // Pause the contract until timestamp + 100
        await consolidationGateway.connect(admin).pauseUntil(timestamp + 100n);

        // Advance time by 101 seconds
        await advanceChainTime(101n);

        // Should allow consolidation requests
        await consolidationGateway
          .connect(authorizedEntity)
          .triggerConsolidation([PUBKEYS[0]], [PUBKEYS[1]], ZERO_ADDRESS, { value: 2 });
      });
    });
  });
});
