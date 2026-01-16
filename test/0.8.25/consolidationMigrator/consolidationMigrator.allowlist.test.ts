import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ConsolidationBus__MockForConsolidationMigrator,
  ConsolidationMigrator,
  StakingRouter__MockForConsolidationMigrator,
} from "typechain-types";

import { Snapshot } from "test/suite";

describe("ConsolidationMigrator.sol: allowlist", () => {
  let consolidationMigrator: ConsolidationMigrator;
  let stakingRouter: StakingRouter__MockForConsolidationMigrator;
  let consolidationBus: ConsolidationBus__MockForConsolidationMigrator;
  let admin: HardhatEthersSigner;
  let allowPairManager: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let ALLOW_PAIR_ROLE: string;

  let originalState: string;

  before(async () => {
    [admin, allowPairManager, stranger] = await ethers.getSigners();

    stakingRouter = await ethers.deployContract("StakingRouter__MockForConsolidationMigrator");
    consolidationBus = await ethers.deployContract("ConsolidationBus__MockForConsolidationMigrator");

    consolidationMigrator = await ethers.deployContract("ConsolidationMigrator", [
      admin.address,
      await stakingRouter.getAddress(),
      await consolidationBus.getAddress(),
      1, // sourceModuleId
      2, // targetModuleId
    ]);

    ALLOW_PAIR_ROLE = await consolidationMigrator.ALLOW_PAIR_ROLE();

    // Grant role
    await consolidationMigrator.connect(admin).grantRole(ALLOW_PAIR_ROLE, allowPairManager.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("allowPair", () => {
    it("should allow a pair", async () => {
      const sourceOpId = 1;
      const targetOpId = 10;

      await expect(consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, targetOpId))
        .to.emit(consolidationMigrator, "ConsolidationPairAllowed")
        .withArgs(sourceOpId, targetOpId);

      expect(await consolidationMigrator.isPairAllowed(sourceOpId, targetOpId)).to.be.true;
    });

    it("should revert if caller does not have ALLOW_PAIR_ROLE", async () => {
      await expect(consolidationMigrator.connect(stranger).allowPair(1, 10))
        .to.be.revertedWithCustomError(consolidationMigrator, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, ALLOW_PAIR_ROLE);
    });

    it("should revert if pair already allowed", async () => {
      const sourceOpId = 1;
      const targetOpId = 10;

      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, targetOpId);

      await expect(consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, targetOpId))
        .to.be.revertedWithCustomError(consolidationMigrator, "PairAlreadyAllowed")
        .withArgs(sourceOpId, targetOpId);
    });

    it("should allow multiple targets for same source", async () => {
      const sourceOpId = 1;
      const targetOpId1 = 10;
      const targetOpId2 = 20;
      const targetOpId3 = 30;

      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, targetOpId1);
      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, targetOpId2);
      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, targetOpId3);

      expect(await consolidationMigrator.isPairAllowed(sourceOpId, targetOpId1)).to.be.true;
      expect(await consolidationMigrator.isPairAllowed(sourceOpId, targetOpId2)).to.be.true;
      expect(await consolidationMigrator.isPairAllowed(sourceOpId, targetOpId3)).to.be.true;

      const targets = await consolidationMigrator.getAllowedTargets(sourceOpId);
      expect(targets.length).to.equal(3);
      expect(targets).to.include(BigInt(targetOpId1));
      expect(targets).to.include(BigInt(targetOpId2));
      expect(targets).to.include(BigInt(targetOpId3));
    });
  });

  context("disallowPair", () => {
    beforeEach(async () => {
      await consolidationMigrator.connect(allowPairManager).allowPair(1, 10);
    });

    it("should disallow a pair", async () => {
      const sourceOpId = 1;
      const targetOpId = 10;

      await expect(consolidationMigrator.connect(allowPairManager).disallowPair(sourceOpId, targetOpId))
        .to.emit(consolidationMigrator, "ConsolidationPairDisallowed")
        .withArgs(sourceOpId, targetOpId);

      expect(await consolidationMigrator.isPairAllowed(sourceOpId, targetOpId)).to.be.false;
    });

    it("should revert if caller does not have ALLOW_PAIR_ROLE", async () => {
      await expect(consolidationMigrator.connect(stranger).disallowPair(1, 10))
        .to.be.revertedWithCustomError(consolidationMigrator, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, ALLOW_PAIR_ROLE);
    });

    it("should revert if pair not in allowlist", async () => {
      const sourceOpId = 999;
      const targetOpId = 888;

      await expect(consolidationMigrator.connect(allowPairManager).disallowPair(sourceOpId, targetOpId))
        .to.be.revertedWithCustomError(consolidationMigrator, "PairNotInAllowlist")
        .withArgs(sourceOpId, targetOpId);
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

    it("getAllowedTargets should return correct list after adding and removing", async () => {
      const sourceOpId = 1;

      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, 10);
      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, 20);
      await consolidationMigrator.connect(allowPairManager).allowPair(sourceOpId, 30);

      let targets = await consolidationMigrator.getAllowedTargets(sourceOpId);
      expect(targets.length).to.equal(3);

      await consolidationMigrator.connect(allowPairManager).disallowPair(sourceOpId, 20);

      targets = await consolidationMigrator.getAllowedTargets(sourceOpId);
      expect(targets.length).to.equal(2);
      expect(targets).to.include(BigInt(10));
      expect(targets).to.include(BigInt(30));
      expect(targets).to.not.include(BigInt(20));
    });
  });
});
