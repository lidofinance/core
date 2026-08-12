import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ConsolidationBus__MockForConsolidationMigrator,
  ConsolidationMigrator,
  StakingRouter__MockForConsolidationMigrator,
} from "typechain-types";

import { proxify } from "lib/proxy";

import { Snapshot } from "test/suite";

describe("ConsolidationMigrator.sol: allowlist", () => {
  let consolidationMigrator: ConsolidationMigrator;
  let stakingRouter: StakingRouter__MockForConsolidationMigrator;
  let consolidationBus: ConsolidationBus__MockForConsolidationMigrator;
  let admin: HardhatEthersSigner;
  let allowPairManager: HardhatEthersSigner;
  let disallowPairManager: HardhatEthersSigner;
  let submitter: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let ALLOW_PAIR_ROLE: string;
  let DISALLOW_PAIR_ROLE: string;

  let originalState: string;

  before(async () => {
    [admin, allowPairManager, disallowPairManager, submitter, stranger] = await ethers.getSigners();

    stakingRouter = await ethers.deployContract("StakingRouter__MockForConsolidationMigrator");
    consolidationBus = await ethers.deployContract("ConsolidationBus__MockForConsolidationMigrator");

    const impl = await ethers.deployContract("ConsolidationMigrator", [
      await stakingRouter.getAddress(),
      await consolidationBus.getAddress(),
      1, // sourceModuleId
      2, // targetModuleId
    ]);
    [consolidationMigrator] = await proxify({ impl, admin });
    await consolidationMigrator.initialize(admin.address);

    ALLOW_PAIR_ROLE = await consolidationMigrator.ALLOW_PAIR_ROLE();
    DISALLOW_PAIR_ROLE = await consolidationMigrator.DISALLOW_PAIR_ROLE();

    // Grant roles
    await consolidationMigrator.connect(admin).grantRole(ALLOW_PAIR_ROLE, allowPairManager.address);
    await consolidationMigrator.connect(admin).grantRole(DISALLOW_PAIR_ROLE, disallowPairManager.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("allowPair", () => {
    it("should allow a pair with submitter", async () => {
      const sourceOpId = 1;
      const targetOpId = 10;

      await expect(consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, targetOpId, submitter.address))
        .to.emit(consolidationMigrator, "ConsolidationPairAllowed")
        .withArgs(sourceOpId, targetOpId, submitter.address);

      expect(await consolidationMigrator.isPairAllowed(sourceOpId, targetOpId)).to.be.true;
      expect(await consolidationMigrator.getSubmitter(sourceOpId, targetOpId)).to.equal(submitter.address);
    });

    it("should revert if caller does not have ALLOW_PAIR_ROLE", async () => {
      await expect(consolidationMigrator.connect(stranger).allowPair(1, 10, submitter.address))
        .to.be.revertedWithCustomError(consolidationMigrator, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, ALLOW_PAIR_ROLE);
    });

    it("should revert if submitter is zero address", async () => {
      await expect(consolidationMigrator.connect(allowPairManager).allowPair(1, 10, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(consolidationMigrator, "ZeroArgument")
        .withArgs("submitter");
    });

    it("should allow updating submitter for existing pair (idempotent)", async () => {
      const sourceOpId = 1;
      const targetOpId = 10;

      // First allow with submitter
      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, targetOpId, submitter.address);
      expect(await consolidationMigrator.getSubmitter(sourceOpId, targetOpId)).to.equal(submitter.address);

      // Update submitter to stranger
      await expect(consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, targetOpId, stranger.address))
        .to.emit(consolidationMigrator, "ConsolidationPairAllowed")
        .withArgs(sourceOpId, targetOpId, stranger.address);

      expect(await consolidationMigrator.isPairAllowed(sourceOpId, targetOpId)).to.be.true;
      expect(await consolidationMigrator.getSubmitter(sourceOpId, targetOpId)).to.equal(stranger.address);
    });

    it("should allow multiple targets for same source with different submitters", async () => {
      const sourceOpId = 1;
      const targetOpId1 = 10;
      const targetOpId2 = 20;
      const targetOpId3 = 30;

      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, targetOpId1, submitter.address);
      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, targetOpId2, stranger.address);
      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, targetOpId3, admin.address);

      expect(await consolidationMigrator.isPairAllowed(sourceOpId, targetOpId1)).to.be.true;
      expect(await consolidationMigrator.isPairAllowed(sourceOpId, targetOpId2)).to.be.true;
      expect(await consolidationMigrator.isPairAllowed(sourceOpId, targetOpId3)).to.be.true;

      expect(await consolidationMigrator.getSubmitter(sourceOpId, targetOpId1)).to.equal(submitter.address);
      expect(await consolidationMigrator.getSubmitter(sourceOpId, targetOpId2)).to.equal(stranger.address);
      expect(await consolidationMigrator.getSubmitter(sourceOpId, targetOpId3)).to.equal(admin.address);

      const targets = await consolidationMigrator.getAllowedTargets(sourceOpId);
      expect(targets.length).to.equal(3);
      expect(targets).to.include(BigInt(targetOpId1));
      expect(targets).to.include(BigInt(targetOpId2));
      expect(targets).to.include(BigInt(targetOpId3));
    });
  });

  context("disallowPair", () => {
    beforeEach(async () => {
      await consolidationMigrator.connect(allowPairManager).allowPair(1, 10, submitter.address);
    });

    it("should disallow a pair and clear submitter", async () => {
      const sourceOpId = 1;
      const targetOpId = 10;

      // Verify submitter is set before disallow
      expect(await consolidationMigrator.getSubmitter(sourceOpId, targetOpId)).to.equal(submitter.address);

      await expect(consolidationMigrator.connect(disallowPairManager).disallowPair(sourceOpId, targetOpId))
        .to.emit(consolidationMigrator, "ConsolidationPairDisallowed")
        .withArgs(sourceOpId, targetOpId, submitter.address);

      expect(await consolidationMigrator.isPairAllowed(sourceOpId, targetOpId)).to.be.false;
      expect(await consolidationMigrator.getSubmitter(sourceOpId, targetOpId)).to.equal(ethers.ZeroAddress);
    });

    it("should revert if caller does not have DISALLOW_PAIR_ROLE", async () => {
      await expect(consolidationMigrator.connect(stranger).disallowPair(1, 10))
        .to.be.revertedWithCustomError(consolidationMigrator, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, DISALLOW_PAIR_ROLE);
    });

    it("should revert if caller has ALLOW_PAIR_ROLE but not DISALLOW_PAIR_ROLE", async () => {
      await expect(consolidationMigrator.connect(allowPairManager).disallowPair(1, 10))
        .to.be.revertedWithCustomError(consolidationMigrator, "AccessControlUnauthorizedAccount")
        .withArgs(allowPairManager.address, DISALLOW_PAIR_ROLE);
    });

    it("should revert if pair not in allowlist", async () => {
      const sourceOpId = 999;
      const targetOpId = 888;

      await expect(consolidationMigrator.connect(disallowPairManager).disallowPair(sourceOpId, targetOpId))
        .to.be.revertedWithCustomError(consolidationMigrator, "PairNotInAllowlist")
        .withArgs(sourceOpId, targetOpId);
    });
  });

  context("selfDisallowPair", () => {
    const sourceOpId = 1;
    const targetOpId = 10;

    beforeEach(async () => {
      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, targetOpId, submitter.address);
    });

    it("should allow submitter to self-disallow their pair", async () => {
      expect(await consolidationMigrator.isPairAllowed(sourceOpId, targetOpId)).to.be.true;
      expect(await consolidationMigrator.getSubmitter(sourceOpId, targetOpId)).to.equal(submitter.address);

      await expect(consolidationMigrator.connect(submitter).selfDisallowPair(sourceOpId, targetOpId))
        .to.emit(consolidationMigrator, "ConsolidationPairDisallowed")
        .withArgs(sourceOpId, targetOpId, submitter.address);

      expect(await consolidationMigrator.isPairAllowed(sourceOpId, targetOpId)).to.be.false;
      expect(await consolidationMigrator.getSubmitter(sourceOpId, targetOpId)).to.equal(ethers.ZeroAddress);
    });

    it("should revert if caller is not the submitter", async () => {
      await expect(consolidationMigrator.connect(stranger).selfDisallowPair(sourceOpId, targetOpId))
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(stranger.address, sourceOpId, targetOpId);
    });

    it("should revert if pair does not exist", async () => {
      const unknownSourceOpId = 999;
      const unknownTargetOpId = 888;

      await expect(consolidationMigrator.connect(submitter).selfDisallowPair(unknownSourceOpId, unknownTargetOpId))
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(submitter.address, unknownSourceOpId, unknownTargetOpId);
    });

    it("should remove pair from getAllowedTargets", async () => {
      // Add another pair
      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, 20, submitter.address);

      let targets = await consolidationMigrator.getAllowedTargets(sourceOpId);
      expect(targets.length).to.equal(2);

      await consolidationMigrator.connect(submitter).selfDisallowPair(sourceOpId, targetOpId);

      targets = await consolidationMigrator.getAllowedTargets(sourceOpId);
      expect(targets.length).to.equal(1);
      expect(targets[0]).to.be.equal(20n);
    });

    it("should revert if called twice for the same pair", async () => {
      await consolidationMigrator.connect(submitter).selfDisallowPair(sourceOpId, targetOpId);

      await expect(consolidationMigrator.connect(submitter).selfDisallowPair(sourceOpId, targetOpId))
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(submitter.address, sourceOpId, targetOpId);
    });

    it("should not require any role", async () => {
      // submitter has no roles granted, but is the designated submitter for the pair
      expect(await consolidationMigrator.hasRole(ALLOW_PAIR_ROLE, submitter.address)).to.be.false;
      expect(await consolidationMigrator.hasRole(DISALLOW_PAIR_ROLE, submitter.address)).to.be.false;

      await expect(consolidationMigrator.connect(submitter).selfDisallowPair(sourceOpId, targetOpId)).to.emit(
        consolidationMigrator,
        "ConsolidationPairDisallowed",
      );
    });
  });

  context("view methods", () => {
    it("isPairAllowed should return false for non-existent pair", async () => {
      expect(await consolidationMigrator.isPairAllowed(999, 888)).to.be.false;
    });

    it("getAllowedTargets should return empty array for new source", async () => {
      const targets = await consolidationMigrator.getAllowedTargets(999);
      expect(targets.length).to.equal(0);
    });

    it("getSubmitter should return zero address for non-existent pair", async () => {
      expect(await consolidationMigrator.getSubmitter(999, 888)).to.equal(ethers.ZeroAddress);
    });

    it("getAllowedTargets should return correct list after adding and removing", async () => {
      const sourceOpId = 1;

      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, 10, submitter.address);
      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, 20, stranger.address);
      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, 30, admin.address);

      let targets = await consolidationMigrator.getAllowedTargets(sourceOpId);
      expect(targets.length).to.equal(3);

      await consolidationMigrator.connect(disallowPairManager).disallowPair(sourceOpId, 20);

      targets = await consolidationMigrator.getAllowedTargets(sourceOpId);
      expect(targets.length).to.equal(2);
      expect(targets).to.include(BigInt(10));
      expect(targets).to.include(BigInt(30));
      expect(targets).to.not.include(BigInt(20));

      // Verify submitter was cleared for removed pair
      expect(await consolidationMigrator.getSubmitter(sourceOpId, 20)).to.equal(ethers.ZeroAddress);
      // Verify remaining submitters are intact
      expect(await consolidationMigrator.getSubmitter(sourceOpId, 10)).to.equal(submitter.address);
      expect(await consolidationMigrator.getSubmitter(sourceOpId, 30)).to.equal(admin.address);
    });
  });
});
