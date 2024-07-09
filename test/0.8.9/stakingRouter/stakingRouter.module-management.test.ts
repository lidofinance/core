import { expect } from "chai";
import { hexlify, randomBytes, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor__factory,
  StakingRouter,
  StakingRouter__factory,
} from "typechain-types";

import { certainAddress, getNextBlock, proxify, randomString } from "lib";

describe("StakingRouter:module-management", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let stakingRouter: StakingRouter;

  beforeEach(async () => {
    [deployer, admin, user] = await ethers.getSigners();

    const depositContract = await new DepositContract__MockForBeaconChainDepositor__factory(deployer).deploy();
    const impl = await new StakingRouter__factory(deployer).deploy(depositContract);

    [stakingRouter] = await proxify({ impl, admin });

    // initialize staking router
    await stakingRouter.initialize(
      admin,
      certainAddress("test:staking-router-modules:lido"), // mock lido address
      hexlify(randomBytes(32)), // mock withdrawal credentials
    );

    // grant roles
    await stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin);
  });

  context("addStakingModule", () => {
    const NAME = "StakingModule";
    const ADDRESS = certainAddress("test:staking-router:staking-module");
    const TARGET_SHARE = 1_00n;
    const MODULE_FEE = 5_00n;
    const TREASURY_FEE = 5_00n;

    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter.connect(user).addStakingModule(NAME, ADDRESS, TARGET_SHARE, MODULE_FEE, TREASURY_FEE),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.STAKING_MODULE_MANAGE_ROLE());
    });

    it("Reverts if the target share is greater than 100%", async () => {
      const TARGET_SHARE_OVER_100 = 100_01;

      await expect(stakingRouter.addStakingModule(NAME, ADDRESS, TARGET_SHARE_OVER_100, MODULE_FEE, TREASURY_FEE))
        .to.be.revertedWithCustomError(stakingRouter, "ValueOver100Percent")
        .withArgs("_targetShare");
    });

    it("Reverts if the sum of module and treasury fees is greater than 100%", async () => {
      const MODULE_FEE_INVALID = 100_01n - TREASURY_FEE;

      await expect(stakingRouter.addStakingModule(NAME, ADDRESS, TARGET_SHARE, MODULE_FEE_INVALID, TREASURY_FEE))
        .to.be.revertedWithCustomError(stakingRouter, "ValueOver100Percent")
        .withArgs("_stakingModuleFee + _treasuryFee");

      const TREASURY_FEE_INVALID = 100_01n - MODULE_FEE;

      await expect(stakingRouter.addStakingModule(NAME, ADDRESS, TARGET_SHARE, MODULE_FEE, TREASURY_FEE_INVALID))
        .to.be.revertedWithCustomError(stakingRouter, "ValueOver100Percent")
        .withArgs("_stakingModuleFee + _treasuryFee");
    });

    it("Reverts if the staking module address is zero address", async () => {
      await expect(stakingRouter.addStakingModule(NAME, ZeroAddress, TARGET_SHARE, MODULE_FEE, TREASURY_FEE))
        .to.be.revertedWithCustomError(stakingRouter, "ZeroAddress")
        .withArgs("_stakingModuleAddress");
    });

    it("Reverts if the staking module name is empty string", async () => {
      const NAME_EMPTY_STRING = "";

      await expect(
        stakingRouter.addStakingModule(NAME_EMPTY_STRING, ADDRESS, TARGET_SHARE, MODULE_FEE, TREASURY_FEE),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleWrongName");
    });

    it("Reverts if the number of staking modules is reached", async () => {
      const MAX_STAKING_MODULE_NAME_LENGTH = await stakingRouter.MAX_STAKING_MODULE_NAME_LENGTH();
      const NAME_TOO_LONG = randomString(Number(MAX_STAKING_MODULE_NAME_LENGTH + 1n));

      await expect(
        stakingRouter.addStakingModule(NAME_TOO_LONG, ADDRESS, TARGET_SHARE, MODULE_FEE, TREASURY_FEE),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleWrongName");
    });

    it("Reverts if the max number of staking modules is reached", async () => {
      const MAX_STAKING_MODULES_COUNT = await stakingRouter.MAX_STAKING_MODULES_COUNT();

      for (let i = 0; i < MAX_STAKING_MODULES_COUNT; i++) {
        await stakingRouter.addStakingModule(
          randomString(8),
          certainAddress(`test:staking-router:staking-module-${i}`),
          1_00,
          1_00,
          1_00,
        );
      }

      expect(await stakingRouter.getStakingModulesCount()).to.equal(MAX_STAKING_MODULES_COUNT);

      await expect(
        stakingRouter.addStakingModule(NAME, ADDRESS, TARGET_SHARE, MODULE_FEE, TREASURY_FEE),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModulesLimitExceeded");
    });

    it("Reverts if adding a module with the same address", async () => {
      await stakingRouter.addStakingModule(NAME, ADDRESS, TARGET_SHARE, MODULE_FEE, TREASURY_FEE);

      await expect(
        stakingRouter.addStakingModule(NAME, ADDRESS, TARGET_SHARE, MODULE_FEE, TREASURY_FEE),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleAddressExists");
    });

    it("Adds the module to stakingRouter and emits events", async () => {
      const stakingModuleId = (await stakingRouter.getStakingModulesCount()) + 1n;
      const moduleAddedBlock = await getNextBlock();

      await expect(stakingRouter.addStakingModule(NAME, ADDRESS, TARGET_SHARE, MODULE_FEE, TREASURY_FEE))
        .to.be.emit(stakingRouter, "StakingRouterETHDeposited")
        .withArgs(stakingModuleId, 0)
        .and.to.be.emit(stakingRouter, "StakingModuleAdded")
        .withArgs(stakingModuleId, ADDRESS, NAME, admin.address)
        .and.to.be.emit(stakingRouter, "StakingModuleTargetShareSet")
        .withArgs(stakingModuleId, TARGET_SHARE, admin.address)
        .and.to.be.emit(stakingRouter, "StakingModuleFeesSet")
        .withArgs(stakingModuleId, MODULE_FEE, TREASURY_FEE, admin.address);

      expect(await stakingRouter.getStakingModule(stakingModuleId)).to.deep.equal([
        stakingModuleId,
        ADDRESS,
        MODULE_FEE,
        TREASURY_FEE,
        TARGET_SHARE,
        0n, // status active
        NAME,
        moduleAddedBlock.timestamp,
        moduleAddedBlock.number,
        0n, // exited validators
      ]);
    });
  });

  context("updateStakingModule", () => {
    const NAME = "StakingModule";
    const ADDRESS = certainAddress("test:staking-router-modules:staking-module");
    const TARGET_SHARE = 1_00n;
    const MODULE_FEE = 5_00n;
    const TREASURY_FEE = 5_00n;

    let ID: bigint;

    const NEW_TARGET_SHARE = 2_00;
    const NEW_MODULE_FEE = 6_00n;
    const NEW_TREASURY_FEE = 4_00n;

    beforeEach(async () => {
      await stakingRouter.addStakingModule(NAME, ADDRESS, TARGET_SHARE, MODULE_FEE, TREASURY_FEE);
      ID = await stakingRouter.getStakingModulesCount();
    });

    it("Reverts if the caller does not have the role", async () => {
      stakingRouter = stakingRouter.connect(user);

      await expect(
        stakingRouter.updateStakingModule(ID, NEW_TARGET_SHARE, NEW_MODULE_FEE, NEW_TREASURY_FEE),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.STAKING_MODULE_MANAGE_ROLE());
    });

    it("Reverts if the new target share is greater than 100%", async () => {
      const NEW_TARGET_SHARE_OVER_100 = 100_01;
      await expect(stakingRouter.updateStakingModule(ID, NEW_TARGET_SHARE_OVER_100, NEW_MODULE_FEE, NEW_TREASURY_FEE))
        .to.be.revertedWithCustomError(stakingRouter, "ValueOver100Percent")
        .withArgs("_targetShare");
    });

    it("Reverts if the sum of the new module and treasury fees is greater than 100%", async () => {
      const NEW_MODULE_FEE_INVALID = 100_01n - TREASURY_FEE;

      await expect(stakingRouter.updateStakingModule(ID, TARGET_SHARE, NEW_MODULE_FEE_INVALID, TREASURY_FEE))
        .to.be.revertedWithCustomError(stakingRouter, "ValueOver100Percent")
        .withArgs("_stakingModuleFee + _treasuryFee");

      const NEW_TREASURY_FEE_INVALID = 100_01n - MODULE_FEE;
      await expect(stakingRouter.updateStakingModule(ID, TARGET_SHARE, MODULE_FEE, NEW_TREASURY_FEE_INVALID))
        .to.be.revertedWithCustomError(stakingRouter, "ValueOver100Percent")
        .withArgs("_stakingModuleFee + _treasuryFee");
    });

    it("Update target share, module and treasury fees and emits events", async () => {
      await expect(stakingRouter.updateStakingModule(ID, NEW_TARGET_SHARE, NEW_MODULE_FEE, NEW_TREASURY_FEE))
        .to.be.emit(stakingRouter, "StakingModuleTargetShareSet")
        .withArgs(ID, NEW_TARGET_SHARE, admin.address)
        .and.to.be.emit(stakingRouter, "StakingModuleFeesSet")
        .withArgs(ID, NEW_MODULE_FEE, NEW_TREASURY_FEE, admin.address);
    });
  });
});
