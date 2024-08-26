import { expect } from "chai";
import { randomBytes } from "crypto";
import { hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StakingRouter } from "typechain-types";

import { certainAddress, proxify } from "lib";

import { Snapshot } from "test/suite";

enum Status {
  Active,
  DepositsPaused,
  Stopped,
}

context("StakingRouter.sol:status-control", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let stakingRouter: StakingRouter;
  let moduleId: bigint;

  let originalState: string;

  before(async () => {
    [deployer, admin, user] = await ethers.getSigners();

    // deploy staking router
    const depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);
    const impl = await ethers.deployContract("StakingRouter", [depositContract], deployer);

    [stakingRouter] = await proxify({ impl, admin });

    await stakingRouter.initialize(
      admin,
      certainAddress("test:staking-router-status:lido"), // mock lido address
      hexlify(randomBytes(32)), // mock withdrawal credentials
    );

    // give the necessary roles to the admin
    await Promise.all([
      stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin),
      stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_PAUSE_ROLE(), admin),
      stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_RESUME_ROLE(), admin),
    ]);

    // add staking module
    await stakingRouter.addStakingModule(
      "myStakingModule",
      certainAddress("test:staking-router-status:staking-module"), // mock staking module address
      1_00, // target share
      5_00, // module fee
      5_00, // treasury fee
    );

    moduleId = await stakingRouter.getStakingModulesCount();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("setStakingModuleStatus", () => {
    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter.connect(user).setStakingModuleStatus(moduleId, Status.DepositsPaused),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.STAKING_MODULE_MANAGE_ROLE());
    });

    it("Reverts if the new status is the same", async () => {
      await expect(
        stakingRouter.setStakingModuleStatus(moduleId, await stakingRouter.getStakingModuleStatus(moduleId)),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleStatusTheSame");
    });

    it("Updates the status of staking module", async () => {
      await expect(stakingRouter.setStakingModuleStatus(moduleId, Status.DepositsPaused))
        .to.emit(stakingRouter, "StakingModuleStatusSet")
        .withArgs(moduleId, Status.DepositsPaused, admin.address);
    });
  });

  context("pauseStakingModule", () => {
    it("Reverts if the caller does not have the role", async () => {
      await expect(stakingRouter.connect(user).pauseStakingModule(moduleId)).to.be.revertedWithOZAccessControlError(
        user.address,
        await stakingRouter.STAKING_MODULE_PAUSE_ROLE(),
      );
    });

    it("Reverts if the status is stopped", async () => {
      await stakingRouter.setStakingModuleStatus(moduleId, Status.Stopped);

      await expect(stakingRouter.pauseStakingModule(moduleId)).to.be.revertedWithCustomError(
        stakingRouter,
        "StakingModuleNotActive",
      );
    });

    it("Reverts if the status is deposits paused", async () => {
      await stakingRouter.setStakingModuleStatus(moduleId, Status.DepositsPaused);

      await expect(stakingRouter.pauseStakingModule(moduleId)).to.be.revertedWithCustomError(
        stakingRouter,
        "StakingModuleNotActive",
      );
    });

    it("Pauses the staking module", async () => {
      await expect(stakingRouter.pauseStakingModule(moduleId))
        .to.emit(stakingRouter, "StakingModuleStatusSet")
        .withArgs(moduleId, Status.DepositsPaused, admin.address);
    });
  });

  context("resumeStakingModule", () => {
    beforeEach(async () => {
      await stakingRouter.pauseStakingModule(moduleId);
    });

    it("Reverts if the caller does not have the role", async () => {
      await expect(stakingRouter.connect(user).resumeStakingModule(moduleId)).to.be.revertedWithOZAccessControlError(
        user.address,
        await stakingRouter.STAKING_MODULE_RESUME_ROLE(),
      );
    });

    it("Reverts if the module is already active", async () => {
      await stakingRouter.resumeStakingModule(moduleId);

      await expect(stakingRouter.resumeStakingModule(moduleId)).to.be.revertedWithCustomError(
        stakingRouter,
        "StakingModuleNotPaused",
      );
    });

    it("Reverts if the module is stopped", async () => {
      await stakingRouter.setStakingModuleStatus(moduleId, Status.Stopped);

      await expect(stakingRouter.resumeStakingModule(moduleId)).to.be.revertedWithCustomError(
        stakingRouter,
        "StakingModuleNotPaused",
      );
    });

    it("Resumes the staking module", async () => {
      await expect(stakingRouter.resumeStakingModule(moduleId))
        .to.emit(stakingRouter, "StakingModuleStatusSet")
        .withArgs(moduleId, Status.Active, admin.address);
    });
  });

  context("getStakingModuleIsStopped", () => {
    it("Returns false if the module is active", async () => {
      expect(await stakingRouter.getStakingModuleStatus(moduleId)).to.equal(Status.Active);
      expect(await stakingRouter.getStakingModuleIsStopped(moduleId)).to.be.false;
    });

    it("Returns false if the module is paused", async () => {
      await stakingRouter.pauseStakingModule(moduleId);
      expect(await stakingRouter.getStakingModuleIsStopped(moduleId)).to.be.false;
    });

    it("Returns true if the module is stopped", async () => {
      await stakingRouter.setStakingModuleStatus(moduleId, Status.Stopped);
      expect(await stakingRouter.getStakingModuleIsStopped(moduleId)).to.be.true;
    });
  });

  context("getStakingModuleIsDepositsPaused", () => {
    it("Returns false if the module is active", async () => {
      expect(await stakingRouter.getStakingModuleStatus(moduleId)).to.equal(Status.Active);
      expect(await stakingRouter.getStakingModuleIsDepositsPaused(moduleId)).to.be.false;
    });

    it("Returns false if the module is stopped", async () => {
      await stakingRouter.setStakingModuleStatus(moduleId, Status.Stopped);
      expect(await stakingRouter.getStakingModuleIsDepositsPaused(moduleId)).to.be.false;
    });

    it("Returns true if deposits are paused", async () => {
      await stakingRouter.setStakingModuleStatus(moduleId, Status.DepositsPaused);
      expect(await stakingRouter.getStakingModuleIsDepositsPaused(moduleId)).to.be.true;
    });
  });

  context("getStakingModuleIsActive", () => {
    it("Returns false if the module is stopped", async () => {
      await stakingRouter.setStakingModuleStatus(moduleId, Status.DepositsPaused);
      expect(await stakingRouter.getStakingModuleIsActive(moduleId)).to.be.false;
    });

    it("Returns false if deposits are paused", async () => {
      await stakingRouter.setStakingModuleStatus(moduleId, Status.DepositsPaused);
      expect(await stakingRouter.getStakingModuleIsActive(moduleId)).to.be.false;
    });

    it("Returns true if the module is active", async () => {
      expect(await stakingRouter.getStakingModuleIsActive(moduleId)).to.be.true;
    });
  });
});
