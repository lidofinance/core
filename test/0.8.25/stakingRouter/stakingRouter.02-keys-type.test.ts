import { expect } from "chai";
import { randomBytes } from "crypto";
import { hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositCallerWrapper__MockForStakingRouter,
  DepositContract__MockForBeaconChainDepositor,
  StakingModuleV2__MockForStakingRouter,
  StakingRouter,
} from "typechain-types";

import { ether, proxify } from "lib";

import { Snapshot } from "test/suite";

describe("StakingRouter.sol:keys-02-type", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;

  let stakingRouter: StakingRouter;

  let originalState: string;

  let stakingModuleV2: StakingModuleV2__MockForStakingRouter;
  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let depositCallerWrapper: DepositCallerWrapper__MockForStakingRouter;

  const name = "myStakingModule";
  const stakingModuleFee = 5_00n;
  const treasuryFee = 5_00n;
  const stakeShareLimit = 1_00n;
  const priorityExitShareThreshold = 2_00n;
  const maxDepositsPerBlock = 150n;
  const minDepositBlockDistance = 25n;

  let moduleId: bigint;
  let stakingModuleAddress: string;
  const withdrawalCredentials = hexlify(randomBytes(32));
  const withdrawalCredentials02 = hexlify(randomBytes(32));

  const SECONDS_PER_SLOT = 12n;
  const GENESIS_TIME = 1606824023;
  const WITHDRAWAL_CREDENTIALS_TYPE_02 = 2;

  before(async () => {
    [deployer, admin] = await ethers.getSigners();

    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);
    const beaconChainDepositor = await ethers.deployContract("BeaconChainDepositor", deployer);
    const depositsTempStorage = await ethers.deployContract("DepositsTempStorage", deployer);
    const depositsTracker = await ethers.deployContract("DepositsTracker", deployer);

    const stakingRouterFactory = await ethers.getContractFactory("StakingRouter__Harness", {
      libraries: {
        ["contracts/0.8.25/lib/BeaconChainDepositor.sol:BeaconChainDepositor"]: await beaconChainDepositor.getAddress(),
        ["contracts/common/lib/DepositsTempStorage.sol:DepositsTempStorage"]: await depositsTempStorage.getAddress(),
        ["contracts/common/lib/DepositsTracker.sol:DepositsTracker"]: await depositsTracker.getAddress(),
      },
    });

    const impl = await stakingRouterFactory.connect(deployer).deploy(depositContract, SECONDS_PER_SLOT, GENESIS_TIME);

    [stakingRouter] = await proxify({ impl, admin });

    depositCallerWrapper = await ethers.deployContract(
      "DepositCallerWrapper__MockForStakingRouter",
      [stakingRouter],
      deployer,
    );

    const depositCallerWrapperAddress = await depositCallerWrapper.getAddress();

    // initialize staking router
    await stakingRouter.initialize(admin, depositCallerWrapperAddress, withdrawalCredentials, withdrawalCredentials02);

    // grant roles

    await Promise.all([
      stakingRouter.grantRole(await stakingRouter.MANAGE_WITHDRAWAL_CREDENTIALS_ROLE(), admin),
      stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin),
    ]);

    // Add staking module v2
    stakingModuleV2 = await ethers.deployContract("StakingModuleV2__MockForStakingRouter", deployer);
    stakingModuleAddress = await stakingModuleV2.getAddress();

    const stakingModuleConfig = {
      stakeShareLimit,
      priorityExitShareThreshold,
      stakingModuleFee,
      treasuryFee,
      maxDepositsPerBlock,
      minDepositBlockDistance,
      withdrawalCredentialsType: WITHDRAWAL_CREDENTIALS_TYPE_02,
    };

    await stakingRouter.addStakingModule(name, stakingModuleAddress, stakingModuleConfig);

    const newWithdrawalCredentials = hexlify(randomBytes(32));

    // set withdrawal credentials for 0x02 type
    await expect(stakingRouter.setWithdrawalCredentials02(newWithdrawalCredentials))
      .to.emit(stakingRouter, "WithdrawalCredentials02Set")
      .withArgs(newWithdrawalCredentials, admin.address)
      .and.to.emit(stakingModuleV2, "Mock__WithdrawalCredentialsChanged");

    moduleId = await stakingRouter.getStakingModulesCount();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("deposit", () => {
    it("make deposits", async () => {
      const operators = [1, 2];
      const depositCounts = [2, 3];
      const depositValue = ether("32.0");
      const amount = 5n * depositValue;
      const tx = await depositCallerWrapper.deposit(moduleId, operators, depositCounts, {
        value: amount,
      });

      const receipt = await tx.wait();

      const depositContractAddress = await depositContract.getAddress();

      let count = 0;
      for (const log of receipt!.logs) {
        if (log.address !== depositContractAddress) continue;
        try {
          const parsed = depositContract.interface.parseLog(log);
          if (parsed!.name === "Deposited__MockEvent") count++;
        } catch {
          // ignore
        }
      }

      expect(count).to.eq(5);

      // here can check deposit tracker too
    });
  });

  context("getStakingModuleMaxInitialDepositsAmount", () => {
    it("", async () => {
      // mock allocation that will return staking module of second type
      // 2 keys + 2 keys + 0 + 1
      await stakingModuleV2.mock_getAllocation([1, 2, 3, 4], [ether("4096"), ether("4000"), ether("31"), ether("32")]);

      const depositableEth = ether("10242");
      // _getTargetDepositsAllocation mocked currently to return the same amount it received
      const moduleDepositEth = await stakingRouter.getStakingModuleMaxInitialDepositsAmount.staticCall(
        moduleId,
        depositableEth,
      );

      expect(moduleDepositEth).to.equal(ether("160"));
    });
  });
});
