import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationBus, ConsolidationGateway__MockForConsolidationBus } from "typechain-types";

import { Snapshot } from "test/suite";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
];

describe("ConsolidationBus.sol: management", () => {
  let consolidationBus: ConsolidationBus;
  let consolidationGateway: ConsolidationGateway__MockForConsolidationBus;
  let admin: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let MANAGE_ROLE: string;
  let PUBLISH_ROLE: string;
  let REMOVE_ROLE: string;

  let originalState: string;

  before(async () => {
    [admin, manager, publisher, stranger] = await ethers.getSigners();

    consolidationGateway = await ethers.deployContract("ConsolidationGateway__MockForConsolidationBus");

    consolidationBus = await ethers.deployContract("ConsolidationBus", [
      admin.address,
      await consolidationGateway.getAddress(),
      100,
    ]);

    MANAGE_ROLE = await consolidationBus.MANAGE_ROLE();
    PUBLISH_ROLE = await consolidationBus.PUBLISH_ROLE();
    REMOVE_ROLE = await consolidationBus.REMOVE_ROLE();

    // Grant manager role
    await consolidationBus.connect(admin).grantRole(MANAGE_ROLE, manager.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("setBatchSize", () => {
    it("should set batch size", async () => {
      await expect(consolidationBus.connect(manager).setBatchSize(200))
        .to.emit(consolidationBus, "BatchLimitUpdated")
        .withArgs(200);

      expect(await consolidationBus.batchSize()).to.equal(200);
    });

    it("should revert setting batch size to zero", async () => {
      await expect(consolidationBus.connect(manager).setBatchSize(0))
        .to.be.revertedWithCustomError(consolidationBus, "ZeroArgument")
        .withArgs("batchSizeLimit");
    });

    it("should revert if caller does not have MANAGE_ROLE", async () => {
      await expect(consolidationBus.connect(stranger).setBatchSize(200))
        .to.be.revertedWithCustomError(consolidationBus, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, MANAGE_ROLE);
    });
  });

  context("removeBatches", () => {
    let batchHash: string;

    beforeEach(async () => {
      // Register publisher and add a batch
      await consolidationBus.connect(admin).grantRole(PUBLISH_ROLE, publisher.address);
      await consolidationBus.connect(admin).grantRole(REMOVE_ROLE, publisher.address);

      const sourcePubkeys = [PUBKEYS[0]];
      const targetPubkeys = [PUBKEYS[1]];

      await consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys, targetPubkeys);

      // Compute batch hash
      batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [sourcePubkeys, targetPubkeys]),
      );
    });

    it("should remove batches", async () => {
      await consolidationBus.connect(admin).grantRole(REMOVE_ROLE, manager.address);
      expect(await consolidationBus.getBatchPublisher(batchHash)).to.not.equal(ethers.ZeroAddress);

      await expect(consolidationBus.connect(manager).removeBatches([batchHash]))
        .to.emit(consolidationBus, "BatchesRemoved")
        .withArgs([batchHash]);

      expect(await consolidationBus.getBatchPublisher(batchHash)).to.equal(ethers.ZeroAddress);
    });

    it("should revert if caller does not have REMOVE_ROLE", async () => {
      await expect(consolidationBus.connect(stranger).removeBatches([batchHash]))
        .to.be.revertedWithCustomError(consolidationBus, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, REMOVE_ROLE);
    });

    it("should revert if batch not found", async () => {
      await consolidationBus.connect(admin).grantRole(REMOVE_ROLE, manager.address);

      const fakeBatchHash = ethers.keccak256(ethers.toUtf8Bytes("fake"));

      await expect(consolidationBus.connect(manager).removeBatches([fakeBatchHash]))
        .to.be.revertedWithCustomError(consolidationBus, "BatchNotFound")
        .withArgs(fakeBatchHash);
    });

    it("should revert if batch already executed", async () => {
      // Grant executor role and execute the batch
      const EXECUTE_ROLE = await consolidationBus.EXECUTE_ROLE();
      await consolidationBus.connect(admin).grantRole(EXECUTE_ROLE, manager.address);
      await consolidationBus.connect(admin).grantRole(REMOVE_ROLE, manager.address);

      const sourcePubkeys = [PUBKEYS[0]];
      const targetPubkeys = [PUBKEYS[1]];

      await consolidationBus.connect(manager).executeConsolidation(sourcePubkeys, targetPubkeys, { value: 10 });

      // Try to remove the executed batch — batch was deleted, so it's not found
      await expect(consolidationBus.connect(manager).removeBatches([batchHash]))
        .to.be.revertedWithCustomError(consolidationBus, "BatchNotFound")
        .withArgs(batchHash);
    });

    it("should remove multiple batches", async () => {
      // Add another batch
      const sourcePubkeys2 = [PUBKEYS[1]];
      const targetPubkeys2 = [PUBKEYS[0]];

      await consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys2, targetPubkeys2);
      await consolidationBus.connect(admin).grantRole(REMOVE_ROLE, manager.address);

      const batchHash2 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [sourcePubkeys2, targetPubkeys2]),
      );

      await expect(consolidationBus.connect(manager).removeBatches([batchHash, batchHash2]))
        .to.emit(consolidationBus, "BatchesRemoved")
        .withArgs([batchHash, batchHash2]);

      expect(await consolidationBus.getBatchPublisher(batchHash)).to.equal(ethers.ZeroAddress);
      expect(await consolidationBus.getBatchPublisher(batchHash2)).to.equal(ethers.ZeroAddress);
    });
  });
});
