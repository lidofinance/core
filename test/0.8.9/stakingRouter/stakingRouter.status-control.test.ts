import { expect } from "chai";
import { randomBytes } from "crypto";
import { hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor__factory,
  MinFirstAllocationStrategy__factory,
  StakingRouterMock,
  StakingRouterMock__factory,
} from "typechain-types";
import { StakingRouterLibraryAddresses } from "typechain-types/factories/contracts/0.8.9/StakingRouter__factory";

import { certainAddress, proxify } from "lib";

enum Status {
  Active,
  DepositsPaused,
  Stopped,
}

context("StakingRouter:status-control", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let stakingRouter: StakingRouterMock;
  let moduleId: bigint;

  beforeEach(async () => {
    [deployer, admin, user] = await ethers.getSigners();

    // deploy staking router
    const depositContract = await new DepositContract__MockForBeaconChainDepositor__factory(deployer).deploy();
    const allocLib = await new MinFirstAllocationStrategy__factory(deployer).deploy();
    const allocLibAddr: StakingRouterLibraryAddresses = {
      ["contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]: await allocLib.getAddress(),
    };

    const impl = await new StakingRouterMock__factory(allocLibAddr, deployer).deploy(depositContract);

    [stakingRouter] = await proxify({ impl, admin });

    await stakingRouter.initialize(
      admin,
      certainAddress("test:staking-router-status:lido"), // mock lido address
      hexlify(randomBytes(32)), // mock withdrawal credentials
    );

    // give the necessary role to the admin
    await stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin);

    // add staking module
    await stakingRouter.addStakingModule(
      "myStakingModule",
      certainAddress("test:staking-router-status:staking-module"), // mock staking module address
      1_00, // target share
      1_00, // target share
      5_00, // module fee
      5_00, // treasury fee
      150, // max deposits per block
      25, // min deposit block distance
    );

    moduleId = await stakingRouter.getStakingModulesCount();
  });

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
