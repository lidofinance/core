import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationBus, ConsolidationGateway__MockForConsolidationBus } from "typechain-types";

import { advanceChainTime, getCurrentBlockTimestamp } from "lib";
import { proxify } from "lib/proxy";

import { Snapshot } from "test/suite";

import { buildWitnessGroups, PUBKEYS } from "../consolidation-helpers";

describe("ConsolidationBus.sol: execution delay", () => {
  let consolidationBus: ConsolidationBus;
  let consolidationGateway: ConsolidationGateway__MockForConsolidationBus;
  let admin: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let MANAGE_ROLE: string;
  let PUBLISH_ROLE: string;

  const EXECUTION_DELAY = 3600; // 1 hour

  let originalState: string;

  before(async () => {
    [admin, manager, publisher, executor, stranger] = await ethers.getSigners();

    consolidationGateway = await ethers.deployContract("ConsolidationGateway__MockForConsolidationBus");

    const impl = await ethers.deployContract("ConsolidationBus", [await consolidationGateway.getAddress()]);
    [consolidationBus] = await proxify({ impl, admin });
    await consolidationBus.initialize(admin.address, 100, 100, EXECUTION_DELAY);

    MANAGE_ROLE = await consolidationBus.MANAGE_ROLE();
    PUBLISH_ROLE = await consolidationBus.PUBLISH_ROLE();

    await consolidationBus.connect(admin).grantRole(MANAGE_ROLE, manager.address);
    await consolidationBus.connect(admin).grantRole(PUBLISH_ROLE, publisher.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("should set the initial execution delay", async () => {
      expect(await consolidationBus.executionDelay()).to.equal(EXECUTION_DELAY);
    });

    it("should emit ExecutionDelayUpdated during initialization", async () => {
      const gatewayAddr = await consolidationGateway.getAddress();

      const impl = await ethers.deployContract("ConsolidationBus", [gatewayAddr]);
      const [bus] = await proxify({ impl, admin });

      await expect(bus.initialize(admin.address, 100, 100, 7200))
        .to.emit(bus, "ExecutionDelayUpdated")
        .withArgs(7200);
    });

    it("should allow zero execution delay in initializer", async () => {
      const gatewayAddr = await consolidationGateway.getAddress();

      const impl = await ethers.deployContract("ConsolidationBus", [gatewayAddr]);
      const [bus] = await proxify({ impl, admin });
      await bus.initialize(admin.address, 100, 100, 0);
      expect(await bus.executionDelay()).to.equal(0);
    });
  });

  context("setExecutionDelay", () => {
    it("should set execution delay", async () => {
      await expect(consolidationBus.connect(manager).setExecutionDelay(7200))
        .to.emit(consolidationBus, "ExecutionDelayUpdated")
        .withArgs(7200);

      expect(await consolidationBus.executionDelay()).to.equal(7200);
    });

    it("should allow setting delay to zero", async () => {
      await expect(consolidationBus.connect(manager).setExecutionDelay(0))
        .to.emit(consolidationBus, "ExecutionDelayUpdated")
        .withArgs(0);

      expect(await consolidationBus.executionDelay()).to.equal(0);
    });

    it("should revert without MANAGE_ROLE", async () => {
      await expect(consolidationBus.connect(stranger).setExecutionDelay(100)).to.be.reverted;
    });
  });

  context("execution delay enforcement", () => {
    let sourcePubkeysGroups: string[][];
    let targetPubkeys: string[];
    let batchHash: string;

    beforeEach(async () => {
      sourcePubkeysGroups = [[PUBKEYS[0]]];
      targetPubkeys = [PUBKEYS[1]];

      const groups = [{ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] }];

      await consolidationBus.connect(publisher).addConsolidationRequests(groups);

      batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"], [groups]),
      );
    });

    it("should revert when execution delay has not passed", async () => {
      const batchInfo = await consolidationBus.getBatchInfo(batchHash);
      const executeAfter = batchInfo.addedAt + BigInt(EXECUTION_DELAY);

      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 0 }),
      )
        .to.be.revertedWithCustomError(consolidationBus, "ExecutionDelayNotPassed")
        .withArgs((await getCurrentBlockTimestamp()) + 1n, executeAfter);
    });

    it("should allow execution after delay has passed", async () => {
      await advanceChainTime(BigInt(EXECUTION_DELAY));

      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 0 }),
      ).to.emit(consolidationBus, "RequestsExecuted");
    });

    it("should allow execution exactly at the delay boundary", async () => {
      const batchInfo = await consolidationBus.getBatchInfo(batchHash);
      const currentTimestamp = await getCurrentBlockTimestamp();
      const timeToAdvance = batchInfo.addedAt + BigInt(EXECUTION_DELAY) - currentTimestamp;

      await advanceChainTime(timeToAdvance);

      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 0 }),
      ).to.emit(consolidationBus, "RequestsExecuted");
    });

    it("should allow immediate execution when delay is zero", async () => {
      await consolidationBus.connect(manager).setExecutionDelay(0);

      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 0 }),
      ).to.emit(consolidationBus, "RequestsExecuted");
    });

    it("should enforce delay per batch independently", async () => {
      // Add second batch after some time
      await advanceChainTime(BigInt(EXECUTION_DELAY / 2));

      const sourcePubkeysGroups2 = [[PUBKEYS[2]]];
      const targetPubkeys2 = [PUBKEYS[3]];
      await consolidationBus
        .connect(publisher)
        .addConsolidationRequests([{ sourcePubkeys: [PUBKEYS[2]], targetPubkey: PUBKEYS[3] }]);

      // Advance enough for batch 1 but not batch 2
      await advanceChainTime(BigInt(EXECUTION_DELAY / 2));

      // Batch 1 should be executable
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 0 }),
      ).to.emit(consolidationBus, "RequestsExecuted");

      // Batch 2 should still be blocked
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups2, targetPubkeys2), { value: 0 }),
      ).to.be.revertedWithCustomError(consolidationBus, "ExecutionDelayNotPassed");
    });

    it("should use the current delay setting at execution time", async () => {
      // Increase delay after batch was added
      const longerDelay = EXECUTION_DELAY * 2;
      await consolidationBus.connect(manager).setExecutionDelay(longerDelay);

      // Advance the original delay
      await advanceChainTime(BigInt(EXECUTION_DELAY));

      // Should still revert because the new longer delay hasn't passed
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 0 }),
      ).to.be.revertedWithCustomError(consolidationBus, "ExecutionDelayNotPassed");

      // Advance the remaining time
      await advanceChainTime(BigInt(EXECUTION_DELAY));

      // Now should succeed
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 0 }),
      ).to.emit(consolidationBus, "RequestsExecuted");
    });
  });

  context("getBatchInfo", () => {
    it("should return zero values for non-existent batch", async () => {
      const fakeBatchHash = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      const batchInfo = await consolidationBus.getBatchInfo(fakeBatchHash);
      expect(batchInfo.publisher).to.equal(ethers.ZeroAddress);
      expect(batchInfo.addedAt).to.equal(0);
    });

    it("should return correct info after adding batch", async () => {
      const groups = [{ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] }];

      await consolidationBus.connect(publisher).addConsolidationRequests(groups);

      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"], [groups]),
      );

      const batchInfo = await consolidationBus.getBatchInfo(batchHash);
      const blockTimestamp = await getCurrentBlockTimestamp();
      expect(batchInfo.publisher).to.equal(publisher.address);
      expect(batchInfo.addedAt).to.equal(blockTimestamp);
    });

    it("should return zero values after batch is executed", async () => {
      const groups = [{ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] }];

      await consolidationBus.connect(publisher).addConsolidationRequests(groups);

      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"], [groups]),
      );

      // Advance past delay
      await advanceChainTime(BigInt(EXECUTION_DELAY));

      await consolidationBus
        .connect(executor)
        .executeConsolidation(buildWitnessGroups([[PUBKEYS[0]]], [PUBKEYS[1]]), { value: 0 });

      const batchInfo = await consolidationBus.getBatchInfo(batchHash);
      expect(batchInfo.publisher).to.equal(ethers.ZeroAddress);
      expect(batchInfo.addedAt).to.equal(0);
    });
  });
});
