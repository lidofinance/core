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

import { PUBKEYS } from "../consolidation-helpers";

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
    const DISALLOW_PAIR_ROLE = await consolidationMigrator.DISALLOW_PAIR_ROLE();
    await consolidationMigrator.connect(admin).grantRole(ALLOW_PAIR_ROLE, allowPairManager.address);
    await consolidationMigrator.connect(admin).grantRole(DISALLOW_PAIR_ROLE, allowPairManager.address);

    // Allow the test pair with submitter
    await consolidationMigrator
      .connect(allowPairManager)
      .allowPair(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, submitter.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("submitConsolidationBatch", () => {
    beforeEach(async () => {
      // Set up source module with deposited keys (totalDeposited=2)
      await sourceModule.mock__setOperatorData(SOURCE_OPERATOR_ID, 2, [PUBKEYS[0], PUBKEYS[1]]);

      // Set up target module with deposited keys (totalDeposited=2)
      await targetModule.mock__setOperatorData(TARGET_OPERATOR_ID, 2, [PUBKEYS[2], PUBKEYS[3]]);
    });

    it("should submit consolidation batch from designated submitter", async () => {
      const sourceIndicesPerTarget = [[0], [1]];
      const targetIndices = [0, 1];

      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, sourceIndicesPerTarget, targetIndices),
      )
        .to.emit(consolidationMigrator, "ConsolidationSubmitted")
        .withArgs(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, sourceIndicesPerTarget, targetIndices);

      // Verify ConsolidationBus was called
      expect(await consolidationBus.callCount()).to.equal(1);
      expect(await consolidationBus.lastCaller()).to.equal(await consolidationMigrator.getAddress());
      expect(await consolidationBus.getLastTotalPairsCount()).to.equal(2);
    });

    it("should forward correct pubkeys to ConsolidationBus", async () => {
      const sourceIndicesPerTarget = [[0]];
      const targetIndices = [0];

      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, sourceIndicesPerTarget, targetIndices);

      // Verify the pubkeys
      const sourcePubkey = await consolidationBus.getLastSourcePubkeyFromGroup(0, 0);
      const targetPubkey = await consolidationBus.getLastTargetPubkey(0);

      expect(sourcePubkey.toLowerCase()).to.equal(PUBKEYS[0].toLowerCase());
      expect(targetPubkey.toLowerCase()).to.equal(PUBKEYS[2].toLowerCase());
    });

    it("should revert if caller is not the designated submitter", async () => {
      await expect(
        consolidationMigrator
          .connect(stranger)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [[0]], [0]),
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
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, unknownTargetOpId, [[0]], [0]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(submitter.address, SOURCE_OPERATOR_ID, unknownTargetOpId);
    });

    it("should revert if arrays have different lengths", async () => {
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [[0], [1]], [0]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "ArraysLengthMismatch")
        .withArgs(2, 1);
    });

    it("should revert if source key is not deposited", async () => {
      // Key at index 2 exists but is not deposited (totalDeposited=2, 3 keys total)
      await sourceModule.mock__setOperatorData(SOURCE_OPERATOR_ID, 2, [PUBKEYS[0], PUBKEYS[1], PUBKEYS[2]]);
      // Add more target keys and make index 2 deposited
      await targetModule.mock__setOperatorData(TARGET_OPERATOR_ID, 3, [PUBKEYS[2], PUBKEYS[3], PUBKEYS[0]]);

      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [[2]], [2]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "KeyNotDeposited")
        .withArgs(SOURCE_MODULE_ID, SOURCE_OPERATOR_ID, 2);
    });

    it("should revert if target key is not deposited", async () => {
      // totalDepositedValidators = 1, so key at index 0 is deposited, but index 1 is NOT
      await targetModule.mock__setOperatorData(TARGET_OPERATOR_ID, 1, [PUBKEYS[2], PUBKEYS[3]]);

      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [[0]], [1]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "KeyNotDeposited")
        .withArgs(TARGET_MODULE_ID, TARGET_OPERATOR_ID, 1);
    });

    it("should emit ConsolidationBus event", async () => {
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [[0]], [0]),
      ).to.emit(consolidationBus, "AddConsolidationRequestsCalled");
    });

    it("should handle multiple validators in a batch", async () => {
      const sourceIndicesPerTarget = [[0], [1]];
      const targetIndices = [0, 1];

      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, sourceIndicesPerTarget, targetIndices);

      expect(await consolidationBus.getLastTotalPairsCount()).to.equal(2);

      const sourcePubkey0 = await consolidationBus.getLastSourcePubkeyFromGroup(0, 0);
      const sourcePubkey1 = await consolidationBus.getLastSourcePubkeyFromGroup(1, 0);
      const targetPubkey0 = await consolidationBus.getLastTargetPubkey(0);
      const targetPubkey1 = await consolidationBus.getLastTargetPubkey(1);

      expect(sourcePubkey0.toLowerCase()).to.equal(PUBKEYS[0].toLowerCase());
      expect(sourcePubkey1.toLowerCase()).to.equal(PUBKEYS[1].toLowerCase());
      expect(targetPubkey0.toLowerCase()).to.equal(PUBKEYS[2].toLowerCase());
      expect(targetPubkey1.toLowerCase()).to.equal(PUBKEYS[3].toLowerCase());
    });

    it("should handle multi-source group consolidation (multiple sources to one target)", async () => {
      // Two source keys consolidated to one target
      const sourceIndicesPerTarget = [[0, 1]];
      const targetIndices = [0];

      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, sourceIndicesPerTarget, targetIndices);

      // Should produce 2 pairs in 1 group
      expect(await consolidationBus.getLastTotalPairsCount()).to.equal(2);
      expect(await consolidationBus.getLastGroupsCount()).to.equal(1);
      expect(await consolidationBus.getLastGroupSize(0)).to.equal(2);

      const sourcePubkey0 = await consolidationBus.getLastSourcePubkeyFromGroup(0, 0);
      const sourcePubkey1 = await consolidationBus.getLastSourcePubkeyFromGroup(0, 1);
      const targetPubkey = await consolidationBus.getLastTargetPubkey(0);

      expect(sourcePubkey0.toLowerCase()).to.equal(PUBKEYS[0].toLowerCase());
      expect(sourcePubkey1.toLowerCase()).to.equal(PUBKEYS[1].toLowerCase());
      expect(targetPubkey.toLowerCase()).to.equal(PUBKEYS[2].toLowerCase());
    });

    it("should allow new submitter to submit after allowPair update", async () => {
      // Update the pair with a new submitter (stranger)
      await consolidationMigrator
        .connect(allowPairManager)
        .allowPair(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, stranger.address);

      // Old submitter should now fail
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [[0]], [0]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(submitter.address, SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID);

      // New submitter should succeed
      await expect(
        consolidationMigrator
          .connect(stranger)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [[0]], [0]),
      ).to.emit(consolidationMigrator, "ConsolidationSubmitted");
    });

    it("should revert after pair is disallowed", async () => {
      // Disallow the pair
      await consolidationMigrator.connect(allowPairManager).disallowPair(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID);

      // Submitter should no longer be able to submit
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [[0]], [0]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(submitter.address, SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID);
    });
  });
});
