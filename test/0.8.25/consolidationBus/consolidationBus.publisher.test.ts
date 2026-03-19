import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationBus, ConsolidationGateway__MockForConsolidationBus } from "typechain-types";

import { Snapshot } from "test/suite";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
];

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

    consolidationBus = await ethers.deployContract("ConsolidationBus", [
      admin.address,
      await consolidationGateway.getAddress(),
      10, // batch size limit
    ]);

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
      const sourcePubkeysGroups = [[PUBKEYS[0]]];
      const targetPubkeys = [PUBKEYS[1]];

      const batchData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes[][]", "bytes[]"],
        [sourcePubkeysGroups, targetPubkeys],
      );
      const batchHash = ethers.keccak256(batchData);

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeysGroups, targetPubkeys))
        .to.emit(consolidationBus, "RequestsAdded")
        .withArgs(publisher.address, batchData);

      expect(await consolidationBus.getBatchPublisher(batchHash)).to.equal(publisher.address);
    });

    it("should add multiple requests in a batch", async () => {
      const sourcePubkeysGroups = [[PUBKEYS[0]], [PUBKEYS[1]]];
      const targetPubkeys = [PUBKEYS[1], PUBKEYS[2]];

      const batchData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes[][]", "bytes[]"],
        [sourcePubkeysGroups, targetPubkeys],
      );
      const batchHash = ethers.keccak256(batchData);

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeysGroups, targetPubkeys))
        .to.emit(consolidationBus, "RequestsAdded")
        .withArgs(publisher.address, batchData);

      expect(await consolidationBus.getBatchPublisher(batchHash)).to.not.equal(ethers.ZeroAddress);
    });

    it("should revert if caller does not have PUBLISH_ROLE", async () => {
      const sourcePubkeysGroups = [[PUBKEYS[0]]];
      const targetPubkeys = [PUBKEYS[1]];

      await expect(consolidationBus.connect(stranger).addConsolidationRequests(sourcePubkeysGroups, targetPubkeys))
        .to.be.revertedWithCustomError(consolidationBus, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, PUBLISH_ROLE);
    });

    it("should revert if batch is empty", async () => {
      await expect(consolidationBus.connect(publisher).addConsolidationRequests([], [])).to.be.revertedWithCustomError(
        consolidationBus,
        "EmptyBatch",
      );
    });

    it("should revert if arrays have different lengths", async () => {
      const sourcePubkeysGroups = [[PUBKEYS[0]]];
      const targetPubkeys = [PUBKEYS[1], PUBKEYS[2]];

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeysGroups, targetPubkeys))
        .to.be.revertedWithCustomError(consolidationBus, "ArraysLengthMismatch")
        .withArgs(1, 2);
    });

    it("should revert if batch size exceeds limit", async () => {
      // Create a batch larger than the limit (10)
      const sourcePubkeysGroups = Array(11).fill([PUBKEYS[0]]);
      const targetPubkeys = Array(11).fill(PUBKEYS[1]);

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeysGroups, targetPubkeys))
        .to.be.revertedWithCustomError(consolidationBus, "BatchTooLarge")
        .withArgs(11, 10);
    });

    it("should allow batch at exact limit", async () => {
      const sourcePubkeysGroups = Array(10).fill([PUBKEYS[0]]);
      const targetPubkeys = Array(10).fill(PUBKEYS[1]);

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeysGroups, targetPubkeys)).to
        .not.be.reverted;
    });

    it("should revert if batch already added", async () => {
      const sourcePubkeysGroups = [[PUBKEYS[0]]];
      const targetPubkeys = [PUBKEYS[1]];

      // Add first time
      await consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeysGroups, targetPubkeys);

      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[][]", "bytes[]"], [sourcePubkeysGroups, targetPubkeys]),
      );

      // Try to add again
      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeysGroups, targetPubkeys))
        .to.be.revertedWithCustomError(consolidationBus, "BatchAlreadyPending")
        .withArgs(batchHash);
    });

    it("should revert if source equals target pubkey", async () => {
      const samePubkey = PUBKEYS[0];

      await expect(consolidationBus.connect(publisher).addConsolidationRequests([[samePubkey]], [samePubkey]))
        .to.be.revertedWithCustomError(consolidationBus, "SourceEqualsTarget")
        .withArgs(0);
    });

    it("should revert if source equals target pubkey at any index", async () => {
      // First group is valid, second group has source == target
      const sourcePubkeysGroups = [[PUBKEYS[0]], [PUBKEYS[1]]];
      const targetPubkeys = [PUBKEYS[2], PUBKEYS[1]]; // PUBKEYS[1] == PUBKEYS[1] at group index 1

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeysGroups, targetPubkeys))
        .to.be.revertedWithCustomError(consolidationBus, "SourceEqualsTarget")
        .withArgs(1);
    });

    it("should allow different publishers to add different batches", async () => {
      // Register another publisher
      const [, , , , publisher2] = await ethers.getSigners();
      await consolidationBus.connect(admin).grantRole(PUBLISH_ROLE, publisher2.address);

      const sourcePubkeysGroups1 = [[PUBKEYS[0]]];
      const targetPubkeys1 = [PUBKEYS[1]];

      const sourcePubkeysGroups2 = [[PUBKEYS[1]]];
      const targetPubkeys2 = [PUBKEYS[2]];

      await consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeysGroups1, targetPubkeys1);
      await consolidationBus.connect(publisher2).addConsolidationRequests(sourcePubkeysGroups2, targetPubkeys2);

      const batchHash1 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[][]", "bytes[]"], [sourcePubkeysGroups1, targetPubkeys1]),
      );
      const batchHash2 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[][]", "bytes[]"], [sourcePubkeysGroups2, targetPubkeys2]),
      );

      expect(await consolidationBus.getBatchPublisher(batchHash1)).to.equal(publisher.address);
      expect(await consolidationBus.getBatchPublisher(batchHash2)).to.equal(publisher2.address);
    });
  });

  context("view methods", () => {
    it("getBatchPublisher should return zero address for non-existent batch", async () => {
      const fakeBatchHash = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      expect(await consolidationBus.getBatchPublisher(fakeBatchHash)).to.equal(ethers.ZeroAddress);
    });
  });
});
