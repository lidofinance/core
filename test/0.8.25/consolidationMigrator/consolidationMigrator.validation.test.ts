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

describe("ConsolidationMigrator.sol: validation", () => {
  let consolidationMigrator: ConsolidationMigrator;
  let stakingRouter: StakingRouter__MockForConsolidationMigrator;
  let sourceModule: SourceModule__MockForConsolidationMigrator;
  let targetModule: TargetModule__MockForConsolidationMigrator;
  let consolidationBus: ConsolidationBus__MockForConsolidationMigrator;
  let admin: HardhatEthersSigner;
  let allowPairManager: HardhatEthersSigner;
  let submitter: HardhatEthersSigner;

  const SOURCE_MODULE_ID = 1;
  const TARGET_MODULE_ID = 2;
  const SOURCE_OPERATOR_ID = 100;
  const TARGET_OPERATOR_ID = 200;

  let originalState: string;

  before(async () => {
    [admin, allowPairManager, submitter] = await ethers.getSigners();

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

  context("validateConsolidationBatch", () => {
    beforeEach(async () => {
      // Set up source module with used keys
      await sourceModule.mock__setSigningKey(SOURCE_OPERATOR_ID, 0, PUBKEYS[0], true);
      await sourceModule.mock__setSigningKey(SOURCE_OPERATOR_ID, 1, PUBKEYS[1], true);

      // Set up target module with deposited keys (active validators)
      // totalDepositedValidators = 2, so keys at index 0,1 are deposited (active)
      await targetModule.mock__setOperatorData(TARGET_OPERATOR_ID, 2, [PUBKEYS[2], PUBKEYS[3]]);
    });

    it("should validate a correct batch", async () => {
      const sourceIndices = [0, 1];
      const targetIndices = [0, 1];

      // Should not revert - both source and target are deposited
      await consolidationMigrator.validateConsolidationBatch(
        SOURCE_OPERATOR_ID,
        TARGET_OPERATOR_ID,
        sourceIndices,
        targetIndices,
      );
    });

    it("should revert if batch is empty", async () => {
      await expect(
        consolidationMigrator.validateConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [], []),
      ).to.be.revertedWithCustomError(consolidationMigrator, "EmptyBatch");
    });

    it("should revert if arrays have different lengths", async () => {
      await expect(
        consolidationMigrator.validateConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0, 1], [0]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "ArraysLengthMismatch")
        .withArgs(2, 1);
    });

    it("should revert if pair is not allowed", async () => {
      const unknownSourceOpId = 999;
      const unknownTargetOpId = 888;

      await expect(consolidationMigrator.validateConsolidationBatch(unknownSourceOpId, unknownTargetOpId, [0], [0]))
        .to.be.revertedWithCustomError(consolidationMigrator, "PairNotAllowed")
        .withArgs(unknownSourceOpId, unknownTargetOpId);
    });

    it("should revert if source key is not used", async () => {
      // Set key at index 2 as NOT used
      await sourceModule.mock__setSigningKey(SOURCE_OPERATOR_ID, 2, PUBKEYS[2], false);
      // Add more target keys and make index 2 deposited
      await targetModule.mock__setOperatorData(TARGET_OPERATOR_ID, 3, [PUBKEYS[2], PUBKEYS[3], PUBKEYS[0]]);

      await expect(consolidationMigrator.validateConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [2], [2]))
        .to.be.revertedWithCustomError(consolidationMigrator, "SourceKeyNotDeposited")
        .withArgs(SOURCE_OPERATOR_ID, 2);
    });

    it("should revert if target key is not deposited", async () => {
      // totalDepositedValidators = 1, so key at index 0 is deposited, but index 1 is NOT
      await targetModule.mock__setOperatorData(TARGET_OPERATOR_ID, 1, [PUBKEYS[2], PUBKEYS[3]]);

      await expect(consolidationMigrator.validateConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0], [1]))
        .to.be.revertedWithCustomError(consolidationMigrator, "TargetKeyNotDeposited")
        .withArgs(TARGET_OPERATOR_ID, 1, 1);
    });

    it("should allow multiple source validators to consolidate to the same target index", async () => {
      // This is a valid scenario - multiple source validators can consolidate to same target
      // The contract does not check for target uniqueness (by design, per spec)
      const sourceIndices = [0, 1];
      const targetIndices = [0, 0]; // Same target for both sources (both deposited)

      // Should not revert
      await consolidationMigrator.validateConsolidationBatch(
        SOURCE_OPERATOR_ID,
        TARGET_OPERATOR_ID,
        sourceIndices,
        targetIndices,
      );
    });
  });
});
