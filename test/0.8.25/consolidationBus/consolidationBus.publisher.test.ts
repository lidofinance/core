import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationBus, ConsolidationGateway__MockForConsolidationBus } from "typechain-types";

import { proxify } from "lib/proxy";

import { Snapshot } from "test/suite";

import { buildWitnessGroups, PUBKEYS } from "../consolidation-helpers";

describe("ConsolidationBus.sol: publisher", () => {
  let consolidationBus: ConsolidationBus;
  let consolidationGateway: ConsolidationGateway__MockForConsolidationBus;
  let admin: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let MANAGE_ROLE: string;
  let PUBLISH_ROLE: string;

  let originalState: string;

  before(async () => {
    [admin, manager, publisher, stranger] = await ethers.getSigners();

    consolidationGateway = await ethers.deployContract("ConsolidationGateway__MockForConsolidationBus");

    const impl = await ethers.deployContract("ConsolidationBus", [await consolidationGateway.getAddress()]);
    [consolidationBus] = await proxify({ impl, admin });
    await consolidationBus.initialize(admin.address, 10, 10, 0);

    MANAGE_ROLE = await consolidationBus.MANAGE_ROLE();
    PUBLISH_ROLE = await consolidationBus.PUBLISH_ROLE();

    // Grant roles
    await consolidationBus.connect(admin).grantRole(MANAGE_ROLE, manager.address);
    await consolidationBus.connect(admin).grantRole(PUBLISH_ROLE, publisher.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("addConsolidationRequests", () => {
    it("should add consolidation requests", async () => {
      const groups = [{ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] }];

      const batchData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"],
        [groups],
      );
      const batchHash = ethers.keccak256(batchData);

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups))
        .to.emit(consolidationBus, "RequestsAdded")
        .withArgs(publisher.address, batchData);

      const batchInfo = await consolidationBus.getBatchInfo(batchHash);
      expect(batchInfo.publisher).to.equal(publisher.address);
      expect(batchInfo.addedAt).to.be.greaterThan(0);
    });

    it("should add multiple requests in a batch", async () => {
      const groups = [
        { sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] },
        { sourcePubkeys: [PUBKEYS[1]], targetPubkey: PUBKEYS[2] },
      ];

      const batchData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"],
        [groups],
      );
      const batchHash = ethers.keccak256(batchData);

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups))
        .to.emit(consolidationBus, "RequestsAdded")
        .withArgs(publisher.address, batchData);

      const batchInfo = await consolidationBus.getBatchInfo(batchHash);
      expect(batchInfo.publisher).to.not.equal(ethers.ZeroAddress);
    });

    it("should revert if caller does not have PUBLISH_ROLE", async () => {
      const groups = [{ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] }];

      await expect(consolidationBus.connect(stranger).addConsolidationRequests(groups))
        .to.be.revertedWithCustomError(consolidationBus, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, PUBLISH_ROLE);
    });

    it("should revert if batch is empty", async () => {
      await expect(consolidationBus.connect(publisher).addConsolidationRequests([])).to.be.revertedWithCustomError(
        consolidationBus,
        "EmptyBatch",
      );
    });

    it("should revert if a source group is empty", async () => {
      // First group is non-empty, second group is empty
      const groups = [
        { sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] },
        { sourcePubkeys: [] as string[], targetPubkey: PUBKEYS[2] },
      ];

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups))
        .to.be.revertedWithCustomError(consolidationBus, "EmptyGroup")
        .withArgs(1);
    });

    it("should revert with EmptyGroup at first index if first group is empty", async () => {
      const groups = [
        { sourcePubkeys: [] as string[], targetPubkey: PUBKEYS[1] },
        { sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[2] },
      ];

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups))
        .to.be.revertedWithCustomError(consolidationBus, "EmptyGroup")
        .withArgs(0);
    });

    it("should revert if batch size exceeds limit", async () => {
      // Create a batch with total source pubkeys exceeding the limit (10)
      // Use fewer groups but with multiple source keys each to avoid TooManyGroups
      const groups = [
        { sourcePubkeys: Array(6).fill(PUBKEYS[0]), targetPubkey: PUBKEYS[1] },
        { sourcePubkeys: Array(6).fill(PUBKEYS[0]), targetPubkey: PUBKEYS[2] },
      ];

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups))
        .to.be.revertedWithCustomError(consolidationBus, "BatchTooLarge")
        .withArgs(12, 10);
    });

    it("should allow batch at exact limit", async () => {
      const groups = Array(10).fill({ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] });

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups)).to.not.be.reverted;
    });

    it("should revert if groups count exceeds max groups in batch", async () => {
      // Set maxGroupsInBatch to 3 (batchSize stays at 10)
      await consolidationBus.connect(manager).setMaxGroupsInBatch(3);

      // Create 4 groups, each with 1 source pubkey (total size 4 <= batchSize 10, but groups 4 > maxGroups 3)
      const groups = Array(4).fill({ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] });

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups))
        .to.be.revertedWithCustomError(consolidationBus, "TooManyGroups")
        .withArgs(4, 3);
    });

    it("should allow batch at exact max groups limit", async () => {
      // Set maxGroupsInBatch to 3
      await consolidationBus.connect(manager).setMaxGroupsInBatch(3);

      const groups = Array(3).fill({ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] });

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups)).to.not.be.reverted;
    });

    it("should check both batch size and max groups limits independently", async () => {
      // Set maxGroupsInBatch to 5, batchSize stays at 10
      await consolidationBus.connect(manager).setMaxGroupsInBatch(5);

      // 3 groups with 4 source pubkeys each = 12 total > batchSize 10
      // but groups 3 <= maxGroups 5
      // TooManyGroups check comes first, but this should pass it and fail on BatchTooLarge
      const groups = [
        { sourcePubkeys: [PUBKEYS[0], PUBKEYS[1], PUBKEYS[2], PUBKEYS[0]], targetPubkey: PUBKEYS[1] },
        { sourcePubkeys: [PUBKEYS[0], PUBKEYS[1], PUBKEYS[2], PUBKEYS[0]], targetPubkey: PUBKEYS[2] },
        { sourcePubkeys: [PUBKEYS[0], PUBKEYS[1], PUBKEYS[2], PUBKEYS[0]], targetPubkey: PUBKEYS[0] },
      ];

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups))
        .to.be.revertedWithCustomError(consolidationBus, "BatchTooLarge")
        .withArgs(12, 10);
    });

    it("should revert if batch already added", async () => {
      const groups = [{ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] }];

      // Add first time
      await consolidationBus.connect(publisher).addConsolidationRequests(groups);

      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"], [groups]),
      );

      // Try to add again
      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups))
        .to.be.revertedWithCustomError(consolidationBus, "BatchAlreadyPending")
        .withArgs(batchHash);
    });

    it("should revert if source equals target pubkey", async () => {
      const samePubkey = PUBKEYS[0];
      const groups = [{ sourcePubkeys: [samePubkey], targetPubkey: samePubkey }];

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups))
        .to.be.revertedWithCustomError(consolidationBus, "SourceEqualsTarget")
        .withArgs(0);
    });

    it("should revert if source equals target pubkey at any index", async () => {
      // First group is valid, second group has source == target
      const groups = [
        { sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[2] },
        { sourcePubkeys: [PUBKEYS[1]], targetPubkey: PUBKEYS[1] }, // PUBKEYS[1] == PUBKEYS[1] at group index 1
      ];

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups))
        .to.be.revertedWithCustomError(consolidationBus, "SourceEqualsTarget")
        .withArgs(1);
    });

    it("should revert if any source in a multi-source group equals the target", async () => {
      // Group has multiple sources, one of which matches the target
      const groups = [
        { sourcePubkeys: [PUBKEYS[0], PUBKEYS[1]], targetPubkey: PUBKEYS[1] }, // PUBKEYS[1] is both source and target
      ];

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups))
        .to.be.revertedWithCustomError(consolidationBus, "SourceEqualsTarget")
        .withArgs(0);
    });

    it("should allow re-adding batch after removal", async () => {
      const REMOVE_ROLE = await consolidationBus.REMOVE_ROLE();
      await consolidationBus.connect(admin).grantRole(REMOVE_ROLE, manager.address);

      const groups = [{ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] }];

      // Add first time
      await consolidationBus.connect(publisher).addConsolidationRequests(groups);

      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"], [groups]),
      );

      // Remove
      await consolidationBus.connect(manager).removeBatches([batchHash]);

      // Batch should be cleared
      const batchInfo = await consolidationBus.getBatchInfo(batchHash);
      expect(batchInfo.publisher).to.equal(ethers.ZeroAddress);

      // Re-add should succeed
      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups)).to.emit(
        consolidationBus,
        "RequestsAdded",
      );
    });

    it("should allow re-adding batch after execution", async () => {
      const groups = [{ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] }];

      // Add first time
      await consolidationBus.connect(publisher).addConsolidationRequests(groups);

      // Execute
      await consolidationBus.executeConsolidation(buildWitnessGroups([[PUBKEYS[0]]], [PUBKEYS[1]]), {
        value: 10,
      });

      // Re-add should succeed
      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups)).to.emit(
        consolidationBus,
        "RequestsAdded",
      );
    });

    it("should revert if target pubkey length is not 48 bytes", async () => {
      const invalidTargetPubkey = "0x1234";
      const groups = [{ sourcePubkeys: [PUBKEYS[0]], targetPubkey: invalidTargetPubkey }];

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups))
        .to.be.revertedWithCustomError(consolidationBus, "InvalidTargetPubkeyLength")
        .withArgs(0, 2);
    });

    it("should revert if source pubkey length is not 48 bytes", async () => {
      const invalidSourcePubkey = "0x1234";
      const groups = [{ sourcePubkeys: [invalidSourcePubkey], targetPubkey: PUBKEYS[1] }];

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(groups))
        .to.be.revertedWithCustomError(consolidationBus, "InvalidSourcePubkeyLength")
        .withArgs(0, 0, 2);
    });

    it("should allow different publishers to add different batches", async () => {
      // Register another publisher
      const [, , , , publisher2] = await ethers.getSigners();
      await consolidationBus.connect(admin).grantRole(PUBLISH_ROLE, publisher2.address);

      const groups1 = [{ sourcePubkeys: [PUBKEYS[0]], targetPubkey: PUBKEYS[1] }];
      const groups2 = [{ sourcePubkeys: [PUBKEYS[1]], targetPubkey: PUBKEYS[2] }];

      await consolidationBus.connect(publisher).addConsolidationRequests(groups1);
      await consolidationBus.connect(publisher2).addConsolidationRequests(groups2);

      const batchHash1 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"], [groups1]),
      );
      const batchHash2 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"], [groups2]),
      );

      expect((await consolidationBus.getBatchInfo(batchHash1)).publisher).to.equal(publisher.address);
      expect((await consolidationBus.getBatchInfo(batchHash2)).publisher).to.equal(publisher2.address);
    });
  });

  context("view methods", () => {
    it("getBatchInfo should return zero values for non-existent batch", async () => {
      const fakeBatchHash = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      const batchInfo = await consolidationBus.getBatchInfo(fakeBatchHash);
      expect(batchInfo.publisher).to.equal(ethers.ZeroAddress);
      expect(batchInfo.addedAt).to.equal(0);
    });
  });
});
