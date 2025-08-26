import { expect } from "chai";
import { randomBytes } from "crypto";
import { hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StakingRouter__Harness } from "typechain-types";

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

  let stakingRouter: StakingRouter__Harness;
  let moduleId: bigint;

  let originalState: string;

  before(async () => {
    [deployer, admin, user] = await ethers.getSigners();

    // deploy staking router
    const depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);
    const beaconChainDepositor = await ethers.deployContract("BeaconChainDepositor", deployer);
    const depositsTempStorage = await ethers.deployContract("DepositsTempStorage", deployer);
    const depositsTracker = await ethers.deployContract("DepositsTracker", deployer);
    const stakingRouterFactory = await ethers.getContractFactory("StakingRouter__Harness", {
      libraries: {
        ["contracts/0.8.9/BeaconChainDepositor.sol:BeaconChainDepositor"]: await beaconChainDepositor.getAddress(),
        ["contracts/common/lib/DepositsTempStorage.sol:DepositsTempStorage"]: await depositsTempStorage.getAddress(),
        ["contracts/common/lib/DepositsTracker.sol:DepositsTracker"]: await depositsTracker.getAddress(),
      },
    });

    const withdrawalCredentials = hexlify(randomBytes(32));
    const withdrawalCredentials02 = hexlify(randomBytes(32));

    const SECONDS_PER_SLOT = 12n;
    const GENESIS_TIME = 1606824023;
    const WITHDRAWAL_CREDENTIALS_TYPE_01 = 1n;

    const impl = await stakingRouterFactory.connect(deployer).deploy(depositContract, SECONDS_PER_SLOT, GENESIS_TIME);

    [stakingRouter] = await proxify({ impl, admin });

    await stakingRouter.initialize(
      admin,
      certainAddress("test:staking-router-status:lido"), // mock lido address
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
      withdrawalCredentialsType: WITHDRAWAL_CREDENTIALS_TYPE_01,
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
