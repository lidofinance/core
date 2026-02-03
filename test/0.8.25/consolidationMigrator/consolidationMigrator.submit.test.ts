import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ConsolidationBus__MockForConsolidationMigrator,
  ConsolidationMigrator,
  SourceModule__MockForConsolidationMigrator,
  StakingRouter__MockForConsolidationMigrator,
  TargetModule__MockForConsolidationMigrator,
} from "typechain-types";

import { Snapshot } from "test/suite";

// Sample 48-byte pubkeys for testing
const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
];

describe("ConsolidationMigrator.sol: submit", () => {
  let consolidationMigrator: ConsolidationMigrator;
  let stakingRouter: StakingRouter__MockForConsolidationMigrator;
  let sourceModule: SourceModule__MockForConsolidationMigrator;
  let targetModule: TargetModule__MockForConsolidationMigrator;
  let consolidationBus: ConsolidationBus__MockForConsolidationMigrator;
  let admin: HardhatEthersSigner;
  let allowPairManager: HardhatEthersSigner;
  let submitter: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const SOURCE_MODULE_ID = 1;
  const TARGET_MODULE_ID = 2;
  const SOURCE_OPERATOR_ID = 100;
  const TARGET_OPERATOR_ID = 200;

  let originalState: string;

  before(async () => {
    [admin, allowPairManager, submitter, stranger] = await ethers.getSigners();

    // Deploy mocks
    stakingRouter = await ethers.deployContract("StakingRouter__MockForConsolidationMigrator");
    sourceModule = await ethers.deployContract("SourceModule__MockForConsolidationMigrator");
    targetModule = await ethers.deployContract("TargetModule__MockForConsolidationMigrator");
    consolidationBus = await ethers.deployContract("ConsolidationBus__MockForConsolidationMigrator");

    // Set up staking router to return module addresses
    await stakingRouter.mock__setStakingModule(SOURCE_MODULE_ID, await sourceModule.getAddress());
    await stakingRouter.mock__setStakingModule(TARGET_MODULE_ID, await targetModule.getAddress());

    // Deploy ConsolidationMigrator
    consolidationMigrator = await ethers.deployContract("ConsolidationMigrator", [
      admin.address,
      await stakingRouter.getAddress(),
      await consolidationBus.getAddress(),
      SOURCE_MODULE_ID,
      TARGET_MODULE_ID,
    ]);

    const ALLOW_PAIR_ROLE = await consolidationMigrator.ALLOW_PAIR_ROLE();
    await consolidationMigrator.connect(admin).grantRole(ALLOW_PAIR_ROLE, allowPairManager.address);

    // Allow the test pair with submitter
    await consolidationMigrator
      .connect(allowPairManager)
      .allowPair(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, submitter.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("submitConsolidationBatch", () => {
    beforeEach(async () => {
      // Set up source module with used keys
      await sourceModule.mock__setSigningKey(SOURCE_OPERATOR_ID, 0, PUBKEYS[0], true);
      await sourceModule.mock__setSigningKey(SOURCE_OPERATOR_ID, 1, PUBKEYS[1], true);

      // Set up target module with deposited keys (active validators)
      // totalDepositedValidators = 2, so keys at index 0,1 are deposited
      await targetModule.mock__setOperatorData(TARGET_OPERATOR_ID, 2, [PUBKEYS[2], PUBKEYS[3]]);
    });

    it("should submit consolidation batch from designated submitter", async () => {
      const sourceIndices = [0, 1];
      const targetIndices = [0, 1];

      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, sourceIndices, targetIndices),
      )
        .to.emit(consolidationMigrator, "ConsolidationSubmitted")
        .withArgs(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, sourceIndices, targetIndices);

      // Verify ConsolidationBus was called
      expect(await consolidationBus.callCount()).to.equal(1);
      expect(await consolidationBus.lastCaller()).to.equal(await consolidationMigrator.getAddress());
      expect(await consolidationBus.getLastBatchSize()).to.equal(2);
    });

    it("should forward correct pubkeys to ConsolidationBus", async () => {
      const sourceIndices = [0];
      const targetIndices = [0];

      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, sourceIndices, targetIndices);

      // Verify the pubkeys
      const sourcePubkey = await consolidationBus.getLastSourcePubkey(0);
      const targetPubkey = await consolidationBus.getLastTargetPubkey(0);

      expect(sourcePubkey.toLowerCase()).to.equal(PUBKEYS[0].toLowerCase());
      expect(targetPubkey.toLowerCase()).to.equal(PUBKEYS[2].toLowerCase());
    });

    it("should revert if caller is not the designated submitter", async () => {
      await expect(
        consolidationMigrator
          .connect(stranger)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0], [0]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(stranger.address, SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID);
    });

    it("should revert if pair is not allowed (no submitter set)", async () => {
      const unknownTargetOpId = 999;

      // When pair is not allowed, there's no submitter set (address(0))
      // So caller will fail authorization check first
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, unknownTargetOpId, [0], [0]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(submitter.address, SOURCE_OPERATOR_ID, unknownTargetOpId);
    });

    it("should revert if batch is empty", async () => {
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [], []),
      ).to.be.revertedWithCustomError(consolidationMigrator, "EmptyBatch");
    });

    it("should revert if arrays have different lengths", async () => {
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0, 1], [0]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "ArraysLengthMismatch")
        .withArgs(2, 1);
    });

    it("should revert if source key is not used", async () => {
      // Set key at index 2 as NOT used
      await sourceModule.mock__setSigningKey(SOURCE_OPERATOR_ID, 2, PUBKEYS[2], false);
      // Add more target keys and make index 2 deposited
      await targetModule.mock__setOperatorData(TARGET_OPERATOR_ID, 3, [PUBKEYS[2], PUBKEYS[3], PUBKEYS[0]]);

      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [2], [2]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "SourceKeyNotDeposited")
        .withArgs(SOURCE_OPERATOR_ID, 2);
    });

    it("should revert if target key is not deposited", async () => {
      // totalDepositedValidators = 1, so key at index 0 is deposited, but index 1 is NOT
      await targetModule.mock__setOperatorData(TARGET_OPERATOR_ID, 1, [PUBKEYS[2], PUBKEYS[3]]);

      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0], [1]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "TargetKeyNotDeposited")
        .withArgs(TARGET_OPERATOR_ID, 1, 1);
    });

    it("should emit ConsolidationBus event", async () => {
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0], [0]),
      ).to.emit(consolidationBus, "AddConsolidationRequestsCalled");
    });

    it("should handle multiple validators in a batch", async () => {
      const sourceIndices = [0, 1];
      const targetIndices = [0, 1];

      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, sourceIndices, targetIndices);

      expect(await consolidationBus.getLastBatchSize()).to.equal(2);

      const sourcePubkey0 = await consolidationBus.getLastSourcePubkey(0);
      const sourcePubkey1 = await consolidationBus.getLastSourcePubkey(1);
      const targetPubkey0 = await consolidationBus.getLastTargetPubkey(0);
      const targetPubkey1 = await consolidationBus.getLastTargetPubkey(1);

      expect(sourcePubkey0.toLowerCase()).to.equal(PUBKEYS[0].toLowerCase());
      expect(sourcePubkey1.toLowerCase()).to.equal(PUBKEYS[1].toLowerCase());
      expect(targetPubkey0.toLowerCase()).to.equal(PUBKEYS[2].toLowerCase());
      expect(targetPubkey1.toLowerCase()).to.equal(PUBKEYS[3].toLowerCase());
    });
  });
});
