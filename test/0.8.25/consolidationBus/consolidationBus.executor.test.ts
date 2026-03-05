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

describe("ConsolidationBus.sol: executor", () => {
  let consolidationBus: ConsolidationBus;
  let consolidationGateway: ConsolidationGateway__MockForConsolidationBus;
  let admin: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let MANAGER_ROLE: string;
  let EXECUTER_ROLE: string;

  let originalState: string;

  before(async () => {
    [admin, manager, publisher, executor, stranger] = await ethers.getSigners();

    consolidationGateway = await ethers.deployContract("ConsolidationGateway__MockForConsolidationBus");

    consolidationBus = await ethers.deployContract("ConsolidationBus", [
      admin.address,
      await consolidationGateway.getAddress(),
      100,
    ]);

    MANAGER_ROLE = await consolidationBus.MANAGER_ROLE();
    EXECUTER_ROLE = await consolidationBus.EXECUTER_ROLE();

    // Grant roles
    await consolidationBus.connect(admin).grantRole(MANAGER_ROLE, manager.address);
    await consolidationBus.connect(admin).grantRole(EXECUTER_ROLE, executor.address);
    await consolidationBus.connect(manager).registerPublisher(publisher.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("executeConsolidation", () => {
    let sourcePubkeys: string[];
    let targetPubkeys: string[];
    let batchHash: string;

    beforeEach(async () => {
      sourcePubkeys = [PUBKEYS[0]];
      targetPubkeys = [PUBKEYS[1]];

      // Add a batch
      await consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys, targetPubkeys);

      batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [sourcePubkeys, targetPubkeys]),
      );
    });

    it("should execute consolidation", async () => {
      const fee = 10n;

      await expect(
        consolidationBus.connect(executor).executeConsolidation(sourcePubkeys, targetPubkeys, { value: fee }),
      )
        .to.emit(consolidationBus, "RequestsExecuted")
        .withArgs(batchHash, fee);

      // Verify batch is removed from storage after execution
      expect(await consolidationBus.getBatchPublisher(batchHash)).to.equal(ethers.ZeroAddress);
    });

    it("should forward call to ConsolidationGateway", async () => {
      const fee = 10n;

      await expect(
        consolidationBus.connect(executor).executeConsolidation(sourcePubkeys, targetPubkeys, { value: fee }),
      )
        .to.emit(consolidationGateway, "AddConsolidationRequestsCalled")
        .withArgs(sourcePubkeys, targetPubkeys, executor.address, fee);
    });

    it("should revert if caller does not have EXECUTER_ROLE", async () => {
      await expect(consolidationBus.connect(stranger).executeConsolidation(sourcePubkeys, targetPubkeys, { value: 10 }))
        .to.be.revertedWithCustomError(consolidationBus, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, EXECUTER_ROLE);
    });

    it("should revert if batch not found", async () => {
      const fakeSources = [PUBKEYS[2]];
      const fakeTargets = [PUBKEYS[0]];

      const fakeBatchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [fakeSources, fakeTargets]),
      );

      await expect(consolidationBus.connect(executor).executeConsolidation(fakeSources, fakeTargets, { value: 10 }))
        .to.be.revertedWithCustomError(consolidationBus, "BatchNotFound")
        .withArgs(fakeBatchHash);
    });

    it("should revert if batch already executed", async () => {
      // Execute first time
      await consolidationBus.connect(executor).executeConsolidation(sourcePubkeys, targetPubkeys, { value: 10 });

      // Try to execute again — batch was deleted, so it's not found
      await expect(consolidationBus.connect(executor).executeConsolidation(sourcePubkeys, targetPubkeys, { value: 10 }))
        .to.be.revertedWithCustomError(consolidationBus, "BatchNotFound")
        .withArgs(batchHash);
    });

    it("should revert if batch was removed", async () => {
      // Remove the batch
      await consolidationBus.connect(manager).removeBatches([batchHash]);

      // Try to execute
      await expect(consolidationBus.connect(executor).executeConsolidation(sourcePubkeys, targetPubkeys, { value: 10 }))
        .to.be.revertedWithCustomError(consolidationBus, "BatchNotFound")
        .withArgs(batchHash);
    });

    it("should execute multiple batches sequentially", async () => {
      // Add second batch
      const sourcePubkeys2 = [PUBKEYS[1]];
      const targetPubkeys2 = [PUBKEYS[2]];
      await consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys2, targetPubkeys2);

      const batchHash2 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [sourcePubkeys2, targetPubkeys2]),
      );

      // Execute first batch
      await expect(consolidationBus.connect(executor).executeConsolidation(sourcePubkeys, targetPubkeys, { value: 10 }))
        .to.emit(consolidationBus, "RequestsExecuted")
        .withArgs(batchHash, 10);

      // Execute second batch
      await expect(
        consolidationBus.connect(executor).executeConsolidation(sourcePubkeys2, targetPubkeys2, { value: 15 }),
      )
        .to.emit(consolidationBus, "RequestsExecuted")
        .withArgs(batchHash2, 15);
    });

    it("should work with zero value (if gateway allows)", async () => {
      await expect(consolidationBus.connect(executor).executeConsolidation(sourcePubkeys, targetPubkeys, { value: 0 }))
        .to.emit(consolidationBus, "RequestsExecuted")
        .withArgs(batchHash, 0);
    });

    it("should forward exact msg.value to gateway", async () => {
      const exactValue = 12345n;

      await expect(
        consolidationBus.connect(executor).executeConsolidation(sourcePubkeys, targetPubkeys, { value: exactValue }),
      )
        .to.emit(consolidationGateway, "AddConsolidationRequestsCalled")
        .withArgs(sourcePubkeys, targetPubkeys, executor.address, exactValue);
    });

    it("should pass executor as refundRecipient", async () => {
      await expect(consolidationBus.connect(executor).executeConsolidation(sourcePubkeys, targetPubkeys, { value: 10 }))
        .to.emit(consolidationGateway, "AddConsolidationRequestsCalled")
        .withArgs(sourcePubkeys, targetPubkeys, executor.address, 10);
    });
  });

  context("ETH balance", () => {
    it("should not hold ETH after execution", async () => {
      const sourcePubkeys = [PUBKEYS[0]];
      const targetPubkeys = [PUBKEYS[1]];

      await consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeys, targetPubkeys);

      const balanceBefore = await ethers.provider.getBalance(await consolidationBus.getAddress());

      await consolidationBus.connect(executor).executeConsolidation(sourcePubkeys, targetPubkeys, { value: 100 });

      const balanceAfter = await ethers.provider.getBalance(await consolidationBus.getAddress());

      expect(balanceAfter).to.equal(balanceBefore);
    });
  });
});
