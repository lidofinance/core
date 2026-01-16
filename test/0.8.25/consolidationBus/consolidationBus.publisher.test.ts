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

  let MANAGER_ROLE: string;
  let PUBLISHER_ROLE: string;

  let originalState: string;

  before(async () => {
    [admin, manager, publisher, stranger] = await ethers.getSigners();

    consolidationGateway = await ethers.deployContract("ConsolidationGateway__MockForConsolidationBus");

    consolidationBus = await ethers.deployContract("ConsolidationBus", [
      admin.address,
      await consolidationGateway.getAddress(),
      10, // batch size limit
    ]);

    MANAGER_ROLE = await consolidationBus.MANAGER_ROLE();
    PUBLISHER_ROLE = await consolidationBus.PUBLISHER_ROLE();

    // Grant roles
    await consolidationBus.connect(admin).grantRole(MANAGER_ROLE, manager.address);
    await consolidationBus.connect(manager).registerPublisher(publisher.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("addConsolidationRequests", () => {
    it("should add consolidation requests", async () => {
      const sourcePubkeys = [PUBKEYS[0]];
      const targetPubkeys = [PUBKEYS[1]];

      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [sourcePubkeys, targetPubkeys]),
      );

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys, targetPubkeys))
        .to.emit(consolidationBus, "RequestsAdded")
        .withArgs(publisher.address, batchHash);

      expect(await consolidationBus.isBatchAdded(batchHash)).to.be.true;
      expect(await consolidationBus.addedBy(batchHash)).to.equal(publisher.address);
    });

    it("should add multiple requests in a batch", async () => {
      const sourcePubkeys = [PUBKEYS[0], PUBKEYS[1]];
      const targetPubkeys = [PUBKEYS[1], PUBKEYS[2]];

      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [sourcePubkeys, targetPubkeys]),
      );

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys, targetPubkeys))
        .to.emit(consolidationBus, "RequestsAdded")
        .withArgs(publisher.address, batchHash);

      expect(await consolidationBus.isBatchAdded(batchHash)).to.be.true;
    });

    it("should revert if caller does not have PUBLISHER_ROLE", async () => {
      const sourcePubkeys = [PUBKEYS[0]];
      const targetPubkeys = [PUBKEYS[1]];

      await expect(consolidationBus.connect(stranger).addConsolidationRequests(sourcePubkeys, targetPubkeys))
        .to.be.revertedWithCustomError(consolidationBus, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, PUBLISHER_ROLE);
    });

    it("should revert if batch is empty", async () => {
      await expect(consolidationBus.connect(publisher).addConsolidationRequests([], [])).to.be.revertedWithCustomError(
        consolidationBus,
        "EmptyBatch",
      );
    });

    it("should revert if arrays have different lengths", async () => {
      const sourcePubkeys = [PUBKEYS[0]];
      const targetPubkeys = [PUBKEYS[1], PUBKEYS[2]];

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys, targetPubkeys))
        .to.be.revertedWithCustomError(consolidationBus, "ArraysLengthMismatch")
        .withArgs(1, 2);
    });

    it("should revert if batch size exceeds limit", async () => {
      // Create a batch larger than the limit (10)
      const sourcePubkeys = Array(11).fill(PUBKEYS[0]);
      const targetPubkeys = Array(11).fill(PUBKEYS[1]);

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys, targetPubkeys))
        .to.be.revertedWithCustomError(consolidationBus, "BatchTooLarge")
        .withArgs(11, 10);
    });

    it("should allow batch at exact limit", async () => {
      const sourcePubkeys = Array(10).fill(PUBKEYS[0]);
      const targetPubkeys = Array(10).fill(PUBKEYS[1]);

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys, targetPubkeys)).to.not.be
        .reverted;
    });

    it("should allow unlimited batch size when limit is 0", async () => {
      // Set batch size to 0 (unlimited)
      await consolidationBus.connect(manager).setBatchSize(0);

      const sourcePubkeys = Array(100).fill(PUBKEYS[0]);
      const targetPubkeys = Array(100).fill(PUBKEYS[1]);

      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys, targetPubkeys)).to.not.be
        .reverted;
    });

    it("should revert if batch already added", async () => {
      const sourcePubkeys = [PUBKEYS[0]];
      const targetPubkeys = [PUBKEYS[1]];

      // Add first time
      await consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys, targetPubkeys);

      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [sourcePubkeys, targetPubkeys]),
      );

      // Try to add again
      await expect(consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys, targetPubkeys))
        .to.be.revertedWithCustomError(consolidationBus, "BatchAlreadyAdded")
        .withArgs(batchHash);
    });

    it("should allow different publishers to add different batches", async () => {
      // Register another publisher
      const [, , , , publisher2] = await ethers.getSigners();
      await consolidationBus.connect(manager).registerPublisher(publisher2.address);

      const sourcePubkeys1 = [PUBKEYS[0]];
      const targetPubkeys1 = [PUBKEYS[1]];

      const sourcePubkeys2 = [PUBKEYS[1]];
      const targetPubkeys2 = [PUBKEYS[2]];

      await consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys1, targetPubkeys1);
      await consolidationBus.connect(publisher2).addConsolidationRequests(sourcePubkeys2, targetPubkeys2);

      const batchHash1 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [sourcePubkeys1, targetPubkeys1]),
      );
      const batchHash2 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [sourcePubkeys2, targetPubkeys2]),
      );

      expect(await consolidationBus.addedBy(batchHash1)).to.equal(publisher.address);
      expect(await consolidationBus.addedBy(batchHash2)).to.equal(publisher2.address);
    });
  });

  context("view methods", () => {
    it("isBatchAdded should return false for non-existent batch", async () => {
      const fakeBatchHash = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      expect(await consolidationBus.isBatchAdded(fakeBatchHash)).to.be.false;
    });

    it("addedBy should return zero address for non-existent batch", async () => {
      const fakeBatchHash = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      expect(await consolidationBus.addedBy(fakeBatchHash)).to.equal(ethers.ZeroAddress);
    });
  });
});
