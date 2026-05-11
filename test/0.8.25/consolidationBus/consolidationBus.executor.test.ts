import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationBus, ConsolidationGateway__MockForConsolidationBus } from "typechain-types";

import { proxify } from "lib/proxy";

import { Snapshot } from "test/suite";

import { buildWitnessGroups, PUBKEYS } from "../consolidation-helpers";

describe("ConsolidationBus.sol: executor", () => {
  let consolidationBus: ConsolidationBus;
  let consolidationGateway: ConsolidationGateway__MockForConsolidationBus;
  let admin: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let MANAGE_ROLE: string;
  let PUBLISH_ROLE: string;
  let REMOVE_ROLE: string;

  let originalState: string;

  before(async () => {
    [admin, manager, publisher, executor, stranger] = await ethers.getSigners();

    consolidationGateway = await ethers.deployContract("ConsolidationGateway__MockForConsolidationBus");

    const impl = await ethers.deployContract("ConsolidationBus", [await consolidationGateway.getAddress()]);
    [consolidationBus] = await proxify({ impl, admin });
    await consolidationBus.initialize(admin.address, 100, 100, 0);

    MANAGE_ROLE = await consolidationBus.MANAGE_ROLE();
    PUBLISH_ROLE = await consolidationBus.PUBLISH_ROLE();
    REMOVE_ROLE = await consolidationBus.REMOVE_ROLE();

    // Grant roles
    await consolidationBus.connect(admin).grantRole(MANAGE_ROLE, manager.address);
    await consolidationBus.connect(admin).grantRole(PUBLISH_ROLE, publisher.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("executeConsolidation", () => {
    let sourcePubkeysGroups: string[][];
    let targetPubkeys: string[];
    let batchHash: string;

    beforeEach(async () => {
      sourcePubkeysGroups = [[PUBKEYS[0]]];
      targetPubkeys = [PUBKEYS[1]];

      // Add a batch
      const groups = [{ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] }];

      await consolidationBus.connect(publisher).addConsolidationRequests(groups);

      batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"], [groups]),
      );
    });

    it("should execute consolidation", async () => {
      const fee = 10n;

      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: fee }),
      )
        .to.emit(consolidationBus, "RequestsExecuted")
        .withArgs(batchHash, fee);

      // Verify batch is removed from storage after execution
      const batchInfo = await consolidationBus.getBatchInfo(batchHash);
      expect(batchInfo.publisher).to.equal(ethers.ZeroAddress);
      expect(batchInfo.addedAt).to.equal(0);
    });

    it("should forward call to ConsolidationGateway", async () => {
      const fee = 10n;

      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: fee }),
      )
        .to.emit(consolidationGateway, "AddConsolidationRequestsCalled")
        .withArgs(sourcePubkeysGroups.length, executor.address, fee);
    });

    it("should allow anyone to execute consolidation", async () => {
      const fee = 10n;

      await expect(
        consolidationBus
          .connect(stranger)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: fee }),
      )
        .to.emit(consolidationBus, "RequestsExecuted")
        .withArgs(batchHash, fee);
    });

    it("should revert if batch not found", async () => {
      const fakeSources = [[PUBKEYS[2]]];
      const fakeTargets = [PUBKEYS[0]];

      const fakeBatchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"],
          [[{ sourcePubkeys: [PUBKEYS[2]], targetPubkey: PUBKEYS[0] }]],
        ),
      );

      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(fakeSources, fakeTargets), { value: 10 }),
      )
        .to.be.revertedWithCustomError(consolidationBus, "BatchNotFound")
        .withArgs(fakeBatchHash);
    });

    it("should revert if batch already executed", async () => {
      // Execute first time
      await consolidationBus
        .connect(executor)
        .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 10 });

      // Try to execute again — batch was deleted, so it's not found
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 10 }),
      )
        .to.be.revertedWithCustomError(consolidationBus, "BatchNotFound")
        .withArgs(batchHash);
    });

    it("should revert if batch was removed", async () => {
      await consolidationBus.connect(admin).grantRole(REMOVE_ROLE, manager.address);
      // Remove the batch
      await consolidationBus.connect(manager).removeBatches([batchHash]);

      // Try to execute
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 10 }),
      )
        .to.be.revertedWithCustomError(consolidationBus, "BatchNotFound")
        .withArgs(batchHash);
    });

    it("should execute multiple batches sequentially", async () => {
      // Add second batch
      const sourcePubkeysGroups2 = [[PUBKEYS[1]]];
      const targetPubkeys2 = [PUBKEYS[2]];
      const groups2 = [{ sourcePubkeys: [PUBKEYS[1]], targetPubkey: PUBKEYS[2] }];

      await consolidationBus.connect(publisher).addConsolidationRequests(groups2);

      const batchHash2 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"], [groups2]),
      );

      // Execute first batch
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 10 }),
      )
        .to.emit(consolidationBus, "RequestsExecuted")
        .withArgs(batchHash, 10);

      // Execute second batch
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups2, targetPubkeys2), { value: 15 }),
      )
        .to.emit(consolidationBus, "RequestsExecuted")
        .withArgs(batchHash2, 15);
    });

    it("should work with zero value (if gateway allows)", async () => {
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 0 }),
      )
        .to.emit(consolidationBus, "RequestsExecuted")
        .withArgs(batchHash, 0);
    });

    it("should forward exact msg.value to gateway", async () => {
      const exactValue = 12345n;

      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: exactValue }),
      )
        .to.emit(consolidationGateway, "AddConsolidationRequestsCalled")
        .withArgs(sourcePubkeysGroups.length, executor.address, exactValue);
    });

    it("should pass caller as refundRecipient", async () => {
      await expect(
        consolidationBus
          .connect(stranger)
          .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 10 }),
      )
        .to.emit(consolidationGateway, "AddConsolidationRequestsCalled")
        .withArgs(sourcePubkeysGroups.length, stranger.address, 10);
    });
  });

  context("ETH balance", () => {
    it("should not hold ETH after execution", async () => {
      const sourcePubkeysGroups = [[PUBKEYS[0]]];
      const targetPubkeys = [PUBKEYS[1]];
      const groups = [{ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] }];

      await consolidationBus.connect(publisher).addConsolidationRequests(groups);

      const balanceBefore = await ethers.provider.getBalance(await consolidationBus.getAddress());

      await consolidationBus
        .connect(executor)
        .executeConsolidation(buildWitnessGroups(sourcePubkeysGroups, targetPubkeys), { value: 100 });

      const balanceAfter = await ethers.provider.getBalance(await consolidationBus.getAddress());

      expect(balanceAfter).to.equal(balanceBefore);
    });
  });
});
