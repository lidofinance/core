import { expect } from "chai";
import { randomBytes } from "crypto";
import { hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositCallerWrapper__MockForStakingRouter,
  DepositContract__MockForBeaconChainDepositor,
  StakingModuleV2__MockForStakingRouter,
  StakingRouter__Harness,
} from "typechain-types";

import { ether, StakingModuleType } from "lib";

import { Snapshot } from "test/suite";

import { deployStakingRouter } from "../../deploy/stakingRouter";

describe("StakingRouter.sol:keys-02-type", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;

  let stakingRouter: StakingRouter__Harness;

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

  before(async () => {
    [deployer, admin] = await ethers.getSigners();

    ({ stakingRouter, depositContract } = await deployStakingRouter({ deployer, admin }));

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
      moduleType: StakingModuleType.New,
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
    it("correctly returns max initial deposits amount", async () => {
      // mock allocation that will return staking module of second type
      // 2 keys + 2 keys + 0 + 1
      const opIds = [1, 2, 3, 4];
      const opAllocs = [ether("4096"), ether("4000"), ether("31"), ether("32")];
      const totalAlloc = opAllocs.reduce((a, b) => a + b, 0n);
      await stakingModuleV2.mock_getAllocation(opIds, opAllocs);
      await stakingRouter.testing_setStakingModuleAccounting(moduleId, totalAlloc, totalAlloc, 0n);

      const depositableEth = ether("10242");
      // _getTargetDepositsAllocation mocked currently to return the same amount it received
      const [moduleDepositEth, moduleDepositCount] =
        await stakingRouter.getStakingModuleMaxInitialDepositsAmount.staticCall(moduleId, depositableEth);

      expect(moduleDepositEth).to.equal(ether("160"));
      expect(moduleDepositCount).to.equal(5);
    });
  });
});
