import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  StakingRouter__MockForTWG,
  TriggerableWithdrawalsGateway__Harness,
  WithdrawalVault__MockForTWG,
} from "typechain-types";

import { advanceChainTime, getCurrentBlockTimestamp, streccak } from "lib";

import { Snapshot } from "test/suite";

import { deployLidoLocator, updateLidoLocatorImplementation } from "../deploy/locator";

const PAUSE_ROLE = streccak("PAUSE_ROLE");
const RESUME_ROLE = streccak("RESUME_ROLE");

interface ExitRequest {
  moduleId: number;
  nodeOpId: number;
  valIndex: number;
  valPubkey: string;
}

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
];

const exitRequests = [
  { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
  { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
  { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
];

const ZERO_ADDRESS = ethers.ZeroAddress;

describe("TriggerableWithdrawalsGateway.sol:triggerFullWithdrawals", () => {
  let triggerableWithdrawalsGateway: TriggerableWithdrawalsGateway__Harness;
  let withdrawalVault: WithdrawalVault__MockForTWG;
  let stakingRouter: StakingRouter__MockForTWG;
  let admin: HardhatEthersSigner;
  let authorizedEntity: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalState: string;

  const createValidatorDataList = (requests: ExitRequest[]) => {
    return requests.map((request) => ({
      stakingModuleId: request.moduleId,
      nodeOperatorId: request.nodeOpId,
      pubkey: request.valPubkey,
    }));
  };

  before(async () => {
    [admin, authorizedEntity, stranger] = await ethers.getSigners();

    const locator = await deployLidoLocator();
    const locatorAddr = await locator.getAddress();

    withdrawalVault = await ethers.deployContract("WithdrawalVault__MockForTWG");
    stakingRouter = await ethers.deployContract("StakingRouter__MockForTWG");

    await updateLidoLocatorImplementation(locatorAddr, {
      withdrawalVault: await withdrawalVault.getAddress(),
      stakingRouter: await stakingRouter.getAddress(),
    });

    triggerableWithdrawalsGateway = await ethers.deployContract("TriggerableWithdrawalsGateway__Harness", [
      admin,
      locatorAddr,
      100,
      1,
      48,
    ]);

    const role = await triggerableWithdrawalsGateway.ADD_FULL_WITHDRAWAL_REQUEST_ROLE();
    await triggerableWithdrawalsGateway.grantRole(role, authorizedEntity);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("pausable until", () => {
    beforeEach(async () => {
      // set up necessary roles
      await triggerableWithdrawalsGateway.connect(admin).grantRole(PAUSE_ROLE, admin);
      await triggerableWithdrawalsGateway.connect(admin).grantRole(RESUME_ROLE, admin);
    });

    context("resume", () => {
      it("should revert if the sender does not have the RESUME_ROLE", async () => {
        // First pause the contract
        await triggerableWithdrawalsGateway.connect(admin).pauseFor(1000n);

        // Try to resume without the RESUME_ROLE
        await expect(triggerableWithdrawalsGateway.connect(stranger).resume()).to.be.revertedWithOZAccessControlError(
          stranger.address,
          RESUME_ROLE,
        );
      });

      it("should revert if the contract is not paused", async () => {
        // Contract is initially not paused
        await expect(triggerableWithdrawalsGateway.connect(admin).resume()).to.be.revertedWithCustomError(
          triggerableWithdrawalsGateway,
          "PausedExpected",
        );
      });

      it("should resume the contract when paused and emit Resumed event", async () => {
        // First pause the contract
        await triggerableWithdrawalsGateway.connect(admin).pauseFor(1000n);
        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(true);

        // Resume the contract
        await expect(triggerableWithdrawalsGateway.connect(admin).resume()).to.emit(
          triggerableWithdrawalsGateway,
          "Resumed",
        );

        // Verify contract is resumed
        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(false);
      });

      it("should allow withdrawal requests after resuming", async () => {
        // First pause and then resume the contract
        await triggerableWithdrawalsGateway.connect(admin).pauseFor(1000n);
        await triggerableWithdrawalsGateway.connect(admin).resume();

        // Should be able to add withdrawal requests
        await triggerableWithdrawalsGateway
          .connect(authorizedEntity)
          .triggerFullWithdrawals(createValidatorDataList(exitRequests), ZERO_ADDRESS, 0, { value: 4 });
      });
    });

    context("pauseFor", () => {
      it("should revert if the sender does not have the PAUSE_ROLE", async () => {
        await expect(
          triggerableWithdrawalsGateway.connect(stranger).pauseFor(1000n),
        ).to.be.revertedWithOZAccessControlError(stranger.address, PAUSE_ROLE);
      });

      it("should revert if the contract is already paused", async () => {
        // First pause the contract
        await triggerableWithdrawalsGateway.connect(admin).pauseFor(1000n);

        // Try to pause again
        await expect(triggerableWithdrawalsGateway.connect(admin).pauseFor(500n)).to.be.revertedWithCustomError(
          triggerableWithdrawalsGateway,
          "ResumedExpected",
        );
      });

      it("should revert if pause duration is zero", async () => {
        await expect(triggerableWithdrawalsGateway.connect(admin).pauseFor(0n)).to.be.revertedWithCustomError(
          triggerableWithdrawalsGateway,
          "ZeroPauseDuration",
        );
      });

      it("should pause the contract for the specified duration and emit Paused event", async () => {
        await expect(triggerableWithdrawalsGateway.connect(admin).pauseFor(1000n))
          .to.emit(triggerableWithdrawalsGateway, "Paused")
          .withArgs(1000n);

        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(true);
      });

      it("should pause the contract indefinitely with PAUSE_INFINITELY", async () => {
        const pauseInfinitely = await triggerableWithdrawalsGateway.PAUSE_INFINITELY();

        // Pause the contract indefinitely
        await expect(triggerableWithdrawalsGateway.connect(admin).pauseFor(pauseInfinitely))
          .to.emit(triggerableWithdrawalsGateway, "Paused")
          .withArgs(pauseInfinitely);

        // Verify contract is paused
        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(true);

        // Advance time significantly
        await advanceChainTime(1_000_000_000n);

        // Contract should still be paused
        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(true);
      });

      it("should automatically resume after the pause duration passes", async () => {
        // Pause the contract for 100 seconds
        await triggerableWithdrawalsGateway.connect(admin).pauseFor(100n);
        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(true);

        // Advance time by 101 seconds
        await advanceChainTime(101n);

        // Contract should be automatically resumed
        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(false);
      });
    });

    context("pauseUntil", () => {
      it("should revert if the sender does not have the PAUSE_ROLE", async () => {
        const timestamp = await getCurrentBlockTimestamp();
        await expect(
          triggerableWithdrawalsGateway.connect(stranger).pauseUntil(timestamp + 1000n),
        ).to.be.revertedWithOZAccessControlError(stranger.address, PAUSE_ROLE);
      });

      it("should revert if the contract is already paused", async () => {
        const timestamp = await getCurrentBlockTimestamp();

        // First pause the contract
        await triggerableWithdrawalsGateway.connect(admin).pauseFor(1000n);

        // Try to pause again with pauseUntil
        await expect(
          triggerableWithdrawalsGateway.connect(admin).pauseUntil(timestamp + 500n),
        ).to.be.revertedWithCustomError(triggerableWithdrawalsGateway, "ResumedExpected");
      });

      it("should revert if timestamp is in the past", async () => {
        const timestamp = await getCurrentBlockTimestamp();

        // Try to pause until a past timestamp
        await expect(
          triggerableWithdrawalsGateway.connect(admin).pauseUntil(timestamp - 100n),
        ).to.be.revertedWithCustomError(triggerableWithdrawalsGateway, "PauseUntilMustBeInFuture");
      });

      it("should pause the contract until the specified timestamp and emit Paused event", async () => {
        const timestamp = await getCurrentBlockTimestamp();

        // Pause the contract until timestamp + 1000
        await expect(triggerableWithdrawalsGateway.connect(admin).pauseUntil(timestamp + 1000n)).to.emit(
          triggerableWithdrawalsGateway,
          "Paused",
        );

        // Verify contract is paused
        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(true);
      });

      it("should pause the contract indefinitely with PAUSE_INFINITELY", async () => {
        const pauseInfinitely = await triggerableWithdrawalsGateway.PAUSE_INFINITELY();

        // Pause the contract indefinitely
        await expect(triggerableWithdrawalsGateway.connect(admin).pauseUntil(pauseInfinitely)).to.emit(
          triggerableWithdrawalsGateway,
          "Paused",
        );

        // Verify contract is paused
        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(true);

        // Advance time significantly
        await advanceChainTime(100000n);

        // Contract should still be paused
        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(true);
      });

      it("should automatically resume after the pause timestamp passes", async () => {
        const timestamp = await getCurrentBlockTimestamp();

        // Pause the contract until timestamp + 100
        await triggerableWithdrawalsGateway.connect(admin).pauseUntil(timestamp + 100n);
        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(true);

        // Advance time by 101 seconds
        await advanceChainTime(101n);

        // Contract should be automatically resumed
        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(false);
      });
    });

    context("Interaction with addWithdrawalRequests", () => {
      it("pauseFor: should prevent withdrawal requests immediately after pausing", async () => {
        // Initially contract should be resumed
        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(false);

        // Pause the contract
        await triggerableWithdrawalsGateway.connect(admin).pauseFor(1000n);

        // Attempt to add withdrawal request should fail
        await expect(
          triggerableWithdrawalsGateway
            .connect(authorizedEntity)
            .triggerFullWithdrawals(createValidatorDataList(exitRequests), ZERO_ADDRESS, 0, { value: 4 }),
        ).to.be.revertedWithCustomError(triggerableWithdrawalsGateway, "ResumedExpected");
      });

      it("pauseUntil: should prevent withdrawal requests immediately after pausing", async () => {
        // Initially contract should be resumed
        expect(await triggerableWithdrawalsGateway.isPaused()).to.equal(false);

        // Pause the contract
        const timestamp = await getCurrentBlockTimestamp();
        await triggerableWithdrawalsGateway.connect(admin).pauseUntil(timestamp + 100n);

        // Attempt to add withdrawal request should fail
        await expect(
          triggerableWithdrawalsGateway
            .connect(authorizedEntity)
            .triggerFullWithdrawals(createValidatorDataList(exitRequests), ZERO_ADDRESS, 0, { value: 4 }),
        ).to.be.revertedWithCustomError(triggerableWithdrawalsGateway, "ResumedExpected");
      });

      it("pauseFor: should allow withdrawal requests immediately after resuming", async () => {
        // Pause and then resume the contract
        await triggerableWithdrawalsGateway.connect(admin).pauseFor(1000n);
        await triggerableWithdrawalsGateway.connect(admin).resume();

        // Should be able to add withdrawal requests immediately
        await triggerableWithdrawalsGateway
          .connect(authorizedEntity)
          .triggerFullWithdrawals(createValidatorDataList(exitRequests), ZERO_ADDRESS, 0, { value: 4 });
      });

      it("pauseUntil: should allow withdrawal requests immediately after resuming", async () => {
        // Pause and then resume the contract
        const timestamp = await getCurrentBlockTimestamp();
        await triggerableWithdrawalsGateway.connect(admin).pauseUntil(timestamp + 100n);
        await triggerableWithdrawalsGateway.connect(admin).resume();

        // Should be able to add withdrawal requests immediately
        await triggerableWithdrawalsGateway
          .connect(authorizedEntity)
          .triggerFullWithdrawals(createValidatorDataList(exitRequests), ZERO_ADDRESS, 0, { value: 4 });
      });

      it("pauseFor: should allow withdrawal requests after pause duration automatically expires", async () => {
        // Pause for 100 seconds
        await triggerableWithdrawalsGateway.connect(admin).pauseFor(100n);

        // Advance time by 101 seconds
        await advanceChainTime(101n);

        // Should be able to add withdrawal requests after pause expires
        await triggerableWithdrawalsGateway
          .connect(authorizedEntity)
          .triggerFullWithdrawals(createValidatorDataList(exitRequests), ZERO_ADDRESS, 0, { value: 4 });
      });

      it("pauseUntil: should allow withdrawal requests after pause duration automatically expires", async () => {
        // Pause for 100 seconds
        const timestamp = await getCurrentBlockTimestamp();
        await triggerableWithdrawalsGateway.connect(admin).pauseUntil(timestamp + 100n);

        // Advance time by 101 seconds
        await advanceChainTime(101n);

        // Should be able to add withdrawal requests after pause expires
        await triggerableWithdrawalsGateway
          .connect(authorizedEntity)
          .triggerFullWithdrawals(createValidatorDataList(exitRequests), ZERO_ADDRESS, 0, { value: 4 });
      });
    });
  });
});
