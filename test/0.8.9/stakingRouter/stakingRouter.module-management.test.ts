import { expect } from "chai";
import { hexlify, randomBytes, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor__factory,
  MinFirstAllocationStrategy__factory,
  StakingRouter,
  StakingRouter__factory,
} from "typechain-types";
import { StakingRouterLibraryAddresses } from "typechain-types/factories/contracts/0.8.9/StakingRouter__factory";

import { certainAddress, getNextBlock, proxify, randomString } from "lib";

describe("StakingRouter:module-management", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let stakingRouter: StakingRouter;

  beforeEach(async () => {
    [deployer, admin, user] = await ethers.getSigners();

    const depositContract = await new DepositContract__MockForBeaconChainDepositor__factory(deployer).deploy();

    const allocLib = await new MinFirstAllocationStrategy__factory(deployer).deploy();
    const allocLibAddr: StakingRouterLibraryAddresses = {
      ["contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]: await allocLib.getAddress(),
    };

    const impl = await new StakingRouter__factory(allocLibAddr, deployer).deploy(depositContract);
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
    const STAKE_SHARE_LIMIT = 1_00n;
    const PRIORITY_EXIT_SHARE_THRESHOLD = STAKE_SHARE_LIMIT;
    const MODULE_FEE = 5_00n;
    const TREASURY_FEE = 5_00n;
    const MAX_DEPOSITS_PER_BLOCK = 150n;
    const MIN_DEPOSIT_BLOCK_DISTANCE = 25n;

    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter
          .connect(user)
          .addStakingModule(
            NAME,
            ADDRESS,
            STAKE_SHARE_LIMIT,
            PRIORITY_EXIT_SHARE_THRESHOLD,
            MODULE_FEE,
            TREASURY_FEE,
            MAX_DEPOSITS_PER_BLOCK,
            MIN_DEPOSIT_BLOCK_DISTANCE,
          ),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.STAKING_MODULE_MANAGE_ROLE());
    });
    //todo priority < share
    //todo priority > 100
    it("Reverts if the target share is greater than 100%", async () => {
      const STAKE_SHARE_LIMIT_OVER_100 = 100_01;

      await expect(
        stakingRouter.addStakingModule(
          NAME,
          ADDRESS,
          STAKE_SHARE_LIMIT_OVER_100,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          MODULE_FEE,
          TREASURY_FEE,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "ValueOver100Percent")
        .withArgs("_stakeShareLimit");
    });

    it("Reverts if the sum of module and treasury fees is greater than 100%", async () => {
      const MODULE_FEE_INVALID = 100_01n - TREASURY_FEE;

      await expect(
        stakingRouter.addStakingModule(
          NAME,
          ADDRESS,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          MODULE_FEE_INVALID,
          TREASURY_FEE,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "ValueOver100Percent")
        .withArgs("_stakingModuleFee + _treasuryFee");

      const TREASURY_FEE_INVALID = 100_01n - MODULE_FEE;

      await expect(
        stakingRouter.addStakingModule(
          NAME,
          ADDRESS,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          MODULE_FEE,
          TREASURY_FEE_INVALID,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "ValueOver100Percent")
        .withArgs("_stakingModuleFee + _treasuryFee");
    });

    it("Reverts if the staking module address is zero address", async () => {
      await expect(
        stakingRouter.addStakingModule(
          NAME,
          ZeroAddress,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          MODULE_FEE,
          TREASURY_FEE,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "ZeroAddress")
        .withArgs("_stakingModuleAddress");
    });

    it("Reverts if the staking module name is empty string", async () => {
      const NAME_EMPTY_STRING = "";

      await expect(
        stakingRouter.addStakingModule(
          NAME_EMPTY_STRING,
          ADDRESS,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          MODULE_FEE,
          TREASURY_FEE,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleWrongName");
    });

    it("Reverts if the number of staking modules is reached", async () => {
      const MAX_STAKING_MODULE_NAME_LENGTH = await stakingRouter.MAX_STAKING_MODULE_NAME_LENGTH();
      const NAME_TOO_LONG = randomString(Number(MAX_STAKING_MODULE_NAME_LENGTH + 1n));

      await expect(
        stakingRouter.addStakingModule(
          NAME_TOO_LONG,
          ADDRESS,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          MODULE_FEE,
          TREASURY_FEE,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
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
          1_00,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        );
      }

      expect(await stakingRouter.getStakingModulesCount()).to.equal(MAX_STAKING_MODULES_COUNT);

      await expect(
        stakingRouter.addStakingModule(
          NAME,
          ADDRESS,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          MODULE_FEE,
          TREASURY_FEE,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModulesLimitExceeded");
    });

    it("Reverts if adding a module with the same address", async () => {
      await stakingRouter.addStakingModule(
        NAME,
        ADDRESS,
        STAKE_SHARE_LIMIT,
        PRIORITY_EXIT_SHARE_THRESHOLD,
        MODULE_FEE,
        TREASURY_FEE,
        MAX_DEPOSITS_PER_BLOCK,
        MIN_DEPOSIT_BLOCK_DISTANCE,
      );

      await expect(
        stakingRouter.addStakingModule(
          NAME,
          ADDRESS,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          MODULE_FEE,
          TREASURY_FEE,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleAddressExists");
    });

    it("Adds the module to stakingRouter and emits events", async () => {
      const stakingModuleId = (await stakingRouter.getStakingModulesCount()) + 1n;
      const moduleAddedBlock = await getNextBlock();

      await expect(
        stakingRouter.addStakingModule(
          NAME,
          ADDRESS,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          MODULE_FEE,
          TREASURY_FEE,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      )
        .to.be.emit(stakingRouter, "StakingRouterETHDeposited")
        .withArgs(stakingModuleId, 0)
        .and.to.be.emit(stakingRouter, "StakingModuleAdded")
        .withArgs(stakingModuleId, ADDRESS, NAME, admin.address)
        .and.to.be.emit(stakingRouter, "StakingModuleShareLimitSet")
        .withArgs(stakingModuleId, STAKE_SHARE_LIMIT, PRIORITY_EXIT_SHARE_THRESHOLD, admin.address)
        .and.to.be.emit(stakingRouter, "StakingModuleFeesSet")
        .withArgs(stakingModuleId, MODULE_FEE, TREASURY_FEE, admin.address);

      expect(await stakingRouter.getStakingModule(stakingModuleId)).to.deep.equal([
        stakingModuleId,
        ADDRESS,
        MODULE_FEE,
        TREASURY_FEE,
        STAKE_SHARE_LIMIT,
        0n, // status active
        NAME,
        moduleAddedBlock.timestamp,
        moduleAddedBlock.number,
        0n, // exited validators,
        PRIORITY_EXIT_SHARE_THRESHOLD,
        MAX_DEPOSITS_PER_BLOCK,
        MIN_DEPOSIT_BLOCK_DISTANCE,
      ]);
    });
  });

  context("updateStakingModule", () => {
    const NAME = "StakingModule";
    const ADDRESS = certainAddress("test:staking-router-modules:staking-module");
    const STAKE_SHARE_LIMIT = 1_00n;
    const PRIORITY_EXIT_SHARE_THRESHOLD = STAKE_SHARE_LIMIT;
    const MODULE_FEE = 5_00n;
    const TREASURY_FEE = 5_00n;
    const MAX_DEPOSITS_PER_BLOCK = 150n;
    const MIN_DEPOSIT_BLOCK_DISTANCE = 25n;

    let ID: bigint;

    const NEW_STAKE_SHARE_LIMIT = 2_00;
    const NEW_PRIORITY_EXIT_SHARE_THRESHOLD = NEW_STAKE_SHARE_LIMIT;

    const NEW_MODULE_FEE = 6_00n;
    const NEW_TREASURY_FEE = 4_00n;

    const NEW_MAX_DEPOSITS_PER_BLOCK = 100n;
    const NEW_MIN_DEPOSIT_BLOCK_DISTANCE = 20n;

    beforeEach(async () => {
      await stakingRouter.addStakingModule(
        NAME,
        ADDRESS,
        STAKE_SHARE_LIMIT,
        PRIORITY_EXIT_SHARE_THRESHOLD,
        MODULE_FEE,
        TREASURY_FEE,
        MAX_DEPOSITS_PER_BLOCK,
        MIN_DEPOSIT_BLOCK_DISTANCE,
      );
      ID = await stakingRouter.getStakingModulesCount();
    });

    it("Reverts if the caller does not have the role", async () => {
      stakingRouter = stakingRouter.connect(user);

      await expect(
        stakingRouter.updateStakingModule(
          ID,
          NEW_STAKE_SHARE_LIMIT,
          NEW_PRIORITY_EXIT_SHARE_THRESHOLD,
          NEW_MODULE_FEE,
          NEW_TREASURY_FEE,
          NEW_MAX_DEPOSITS_PER_BLOCK,
          NEW_MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.STAKING_MODULE_MANAGE_ROLE());
    });

    it("Reverts if the new target share is greater than 100%", async () => {
      const NEW_STAKE_SHARE_LIMIT_OVER_100 = 100_01;
      await expect(
        stakingRouter.updateStakingModule(
          ID,
          NEW_STAKE_SHARE_LIMIT_OVER_100,
          NEW_PRIORITY_EXIT_SHARE_THRESHOLD,
          NEW_MODULE_FEE,
          NEW_TREASURY_FEE,
          NEW_MAX_DEPOSITS_PER_BLOCK,
          NEW_MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "ValueOver100Percent")
        .withArgs("_stakeShareLimit");
    });

    it("Reverts if the new priority exit share is greater than 100%", async () => {
      const NEW_PRIORITY_EXIT_SHARE_THRESHOLD_OVER_100 = 100_01;
      await expect(
        stakingRouter.updateStakingModule(
          ID,
          NEW_STAKE_SHARE_LIMIT,
          NEW_PRIORITY_EXIT_SHARE_THRESHOLD_OVER_100,
          NEW_MODULE_FEE,
          NEW_TREASURY_FEE,
          NEW_MAX_DEPOSITS_PER_BLOCK,
          NEW_MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "ValueOver100Percent")
        .withArgs("_priorityExitShareThreshold");
    });

    it("Reverts if the new priority exit share is less than stake share limit", async () => {
      const NEW_STAKE_SHARE_LIMIT = 55_00n;
      const NEW_PRIORITY_EXIT_SHARE_THRESHOLD = 50_00n;
      await expect(
        stakingRouter.updateStakingModule(
          ID,
          NEW_STAKE_SHARE_LIMIT,
          NEW_PRIORITY_EXIT_SHARE_THRESHOLD,
          NEW_MODULE_FEE,
          NEW_TREASURY_FEE,
          NEW_MAX_DEPOSITS_PER_BLOCK,
          NEW_MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidPriorityExitShareThreshold");
    });

    it("Reverts if the sum of the new module and treasury fees is greater than 100%", async () => {
      const NEW_MODULE_FEE_INVALID = 100_01n - TREASURY_FEE;

      await expect(
        stakingRouter.updateStakingModule(
          ID,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          NEW_MODULE_FEE_INVALID,
          TREASURY_FEE,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "ValueOver100Percent")
        .withArgs("_stakingModuleFee + _treasuryFee");

      const NEW_TREASURY_FEE_INVALID = 100_01n - MODULE_FEE;
      await expect(
        stakingRouter.updateStakingModule(
          ID,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          MODULE_FEE,
          NEW_TREASURY_FEE_INVALID,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "ValueOver100Percent")
        .withArgs("_stakingModuleFee + _treasuryFee");
    });

    it("Update target share, module and treasury fees and emits events", async () => {
      await expect(
        stakingRouter.updateStakingModule(
          ID,
          NEW_STAKE_SHARE_LIMIT,
          NEW_PRIORITY_EXIT_SHARE_THRESHOLD,
          NEW_MODULE_FEE,
          NEW_TREASURY_FEE,
          NEW_MAX_DEPOSITS_PER_BLOCK,
          NEW_MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      )
        .to.be.emit(stakingRouter, "StakingModuleShareLimitSet")
        .withArgs(ID, NEW_STAKE_SHARE_LIMIT, NEW_PRIORITY_EXIT_SHARE_THRESHOLD, admin.address)
        .and.to.be.emit(stakingRouter, "StakingModuleFeesSet")
        .withArgs(ID, NEW_MODULE_FEE, NEW_TREASURY_FEE, admin.address);
    });
  });
});
