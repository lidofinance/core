import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { TriggerableWithdrawalsGateway } from "typechain-types";

import { advanceChainTime, getCurrentBlockTimestamp } from "lib";

import { deployTriggerableWithdrawalsGateway } from "test/deploy";
import { Snapshot } from "test/suite";

import { fullWithdrawal } from "../triggerable-withdrawals-helpers";

describe("TriggerableWithdrawalsGateway.sol: pausable", () => {
  let gateway: TriggerableWithdrawalsGateway;
  let admin: HardhatEthersSigner;
  let pauser: HardhatEthersSigner;
  let resumer: HardhatEthersSigner;
  let requester: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let PAUSE_INFINITELY: bigint;

  let originalState: string;

  before(async () => {
    [admin, pauser, resumer, requester, stranger] = await ethers.getSigners();

    ({ gateway } = await deployTriggerableWithdrawalsGateway(admin));

    await gateway.connect(admin).grantRole(await gateway.PAUSE_ROLE(), pauser.address);
    await gateway.connect(admin).grantRole(await gateway.RESUME_ROLE(), resumer.address);
    await gateway.connect(admin).grantRole(await gateway.ADD_WITHDRAWAL_REQUEST_ROLE(), requester.address);

    PAUSE_INFINITELY = await gateway.PAUSE_INFINITELY();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  const trigger = () =>
    gateway.connect(requester).triggerWithdrawals([fullWithdrawal(0)], requester.address, { value: 1n });

  context("pauseFor", () => {
    it("reverts if caller has no PAUSE_ROLE", async () => {
      await expect(gateway.connect(stranger).pauseFor(100))
        .to.be.revertedWithCustomError(gateway, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, await gateway.PAUSE_ROLE());
    });

    it("reverts on zero duration", async () => {
      await expect(gateway.connect(pauser).pauseFor(0)).to.be.revertedWithCustomError(gateway, "ZeroPauseDuration");
    });

    it("pauses for the given duration and blocks withdrawal requests", async () => {
      await expect(gateway.connect(pauser).pauseFor(100)).to.emit(gateway, "Paused").withArgs(100);

      expect(await gateway.isPaused()).to.be.true;
      await expect(trigger()).to.be.revertedWithCustomError(gateway, "ResumedExpected");
    });

    it("resumes automatically after the duration", async () => {
      await gateway.connect(pauser).pauseFor(100);

      await advanceChainTime(100n);

      expect(await gateway.isPaused()).to.be.false;
      await expect(trigger()).to.emit(gateway, "WithdrawalsTriggered");
    });

    it("pauses infinitely", async () => {
      await gateway.connect(pauser).pauseFor(PAUSE_INFINITELY);

      expect(await gateway.getResumeSinceTimestamp()).to.equal(PAUSE_INFINITELY);
    });

    it("reverts if already paused", async () => {
      await gateway.connect(pauser).pauseFor(100);

      await expect(gateway.connect(pauser).pauseFor(100)).to.be.revertedWithCustomError(gateway, "ResumedExpected");
    });
  });

  context("pauseUntil", () => {
    it("reverts if caller has no PAUSE_ROLE", async () => {
      await expect(gateway.connect(stranger).pauseUntil((await getCurrentBlockTimestamp()) + 100n))
        .to.be.revertedWithCustomError(gateway, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, await gateway.PAUSE_ROLE());
    });

    it("reverts if the timestamp is in the past", async () => {
      await expect(
        gateway.connect(pauser).pauseUntil((await getCurrentBlockTimestamp()) - 1n),
      ).to.be.revertedWithCustomError(gateway, "PauseUntilMustBeInFuture");
    });

    it("pauses until the given timestamp inclusive", async () => {
      const pauseUntil = (await getCurrentBlockTimestamp()) + 100n;

      await gateway.connect(pauser).pauseUntil(pauseUntil);

      expect(await gateway.getResumeSinceTimestamp()).to.equal(pauseUntil + 1n);
      await expect(trigger()).to.be.revertedWithCustomError(gateway, "ResumedExpected");
    });
  });

  context("resume", () => {
    it("reverts if caller has no RESUME_ROLE", async () => {
      await gateway.connect(pauser).pauseFor(100);

      await expect(gateway.connect(stranger).resume())
        .to.be.revertedWithCustomError(gateway, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, await gateway.RESUME_ROLE());
    });

    it("reverts if not paused", async () => {
      await expect(gateway.connect(resumer).resume()).to.be.revertedWithCustomError(gateway, "PausedExpected");
    });

    it("resumes and allows withdrawal requests again", async () => {
      await gateway.connect(pauser).pauseFor(PAUSE_INFINITELY);

      await expect(gateway.connect(resumer).resume()).to.emit(gateway, "Resumed");

      expect(await gateway.isPaused()).to.be.false;
      await expect(trigger()).to.emit(gateway, "WithdrawalsTriggered");
    });
  });
});
