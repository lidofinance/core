import { expect } from "chai";
import { randomBytes } from "crypto";
import { hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StakingRouter__Harness } from "typechain-types";

import { certainAddress, StakingModuleType } from "lib";

import { Snapshot } from "test/suite";

import { deployStakingRouter } from "../../deploy/stakingRouter";
enum Status {
  Active,
  DepositsPaused,
  Stopped,
}

context("StakingRouter.sol:status-control", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let stakingRouter: StakingRouter__Harness;
  let moduleId: bigint;

  let originalState: string;

  const lido = certainAddress("test:staking-router-status:lido");
  const withdrawalCredentials = hexlify(randomBytes(32));
  const withdrawalCredentials02 = hexlify(randomBytes(32));

  before(async () => {
    [deployer, admin, user] = await ethers.getSigners();

    // deploy staking router
    ({ stakingRouter } = await deployStakingRouter({ deployer, admin }));

    await stakingRouter.initialize(
      admin,
      lido, // mock lido address
      withdrawalCredentials,
      withdrawalCredentials02,
    );

    // give the necessary role to the admin
    await stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin);

    const stakingModuleConfig = {
      stakeShareLimit: 1_00,
      priorityExitShareThreshold: 1_00,
      stakingModuleFee: 5_00,
      treasuryFee: 5_00,
      maxDepositsPerBlock: 150,
      minDepositBlockDistance: 25,
      moduleType: StakingModuleType.Legacy,
    };

    // add staking module
    await stakingRouter.addStakingModule(
      "myStakingModule",
      certainAddress("test:staking-router-status:staking-module"), // mock staking module address
      stakingModuleConfig,
    );

    moduleId = await stakingRouter.getStakingModulesCount();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("setStakingModuleStatus", () => {
    it("Reverts if the caller does not have the role", async () => {
      await expect(stakingRouter.connect(user).setStakingModuleStatus(moduleId, Status.DepositsPaused))
        .to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, await stakingRouter.STAKING_MODULE_MANAGE_ROLE());
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

    it("Not emit event when new status is the same", async () => {
      await stakingRouter.setStakingModuleStatus(moduleId, Status.DepositsPaused);

      await expect(stakingRouter.testing_setStakingModuleStatus(moduleId, Status.DepositsPaused)).to.not.emit(
        stakingRouter,
        "StakingModuleStatusSet",
      );
      expect(await stakingRouter.getStakingModuleStatus(moduleId)).to.equal(Status.DepositsPaused);
    });
  });

  context("getStakingModuleIsStopped", () => {
    it("Returns false if the module is active", async () => {
      expect(await stakingRouter.getStakingModuleStatus(moduleId)).to.equal(Status.Active);
      expect(await stakingRouter.getStakingModuleIsStopped(moduleId)).to.be.false;
    });

    it("Returns false if the module is paused", async () => {
      await stakingRouter.setStakingModuleStatus(moduleId, Status.DepositsPaused);
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
