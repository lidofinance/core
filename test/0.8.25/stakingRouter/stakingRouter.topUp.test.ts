import { expect } from "chai";
import { hexlify, randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor,
  StakingModuleV2__MockForStakingRouter,
  StakingRouter__Harness,
} from "typechain-types";

import { certainAddress, findEventsWithInterfaces } from "lib";
import { getModuleMEB, StakingModuleStatus, TOTAL_BASIS_POINTS, WithdrawalCredentialsType } from "lib/constants";

import { Snapshot } from "test/suite";

import { deployStakingRouter } from "../../deploy/stakingRouter";

describe("StakingRouter.sol:getTopUpDepositAmount", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;

  let stakingRouter: StakingRouter__Harness;
  let depositContract: DepositContract__MockForBeaconChainDepositor;

  let originalState: string;

  const DEFAULT_CONFIG: ModuleConfig = {
    stakeShareLimit: TOTAL_BASIS_POINTS,
    priorityExitShareThreshold: TOTAL_BASIS_POINTS,
    moduleFee: 5_00n,
    treasuryFee: 5_00n,
    maxDepositsPerBlock: 150n,
    minDepositBlockDistance: 25n,
    withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
  };

  const NEW_MEB = getModuleMEB(WithdrawalCredentialsType.WC0x02);
  const GWEI = 1_000_000_000n;

  const withdrawalCredentials = hexlify(randomBytes(32));

  before(async () => {
    [deployer, admin] = await ethers.getSigners();

    ({ stakingRouter } = await deployStakingRouter({ deployer, admin }));
    ({ stakingRouter, depositContract } = await deployStakingRouter({ deployer, admin }));

    // initialize staking router
    await stakingRouter.initialize(
      admin,
      certainAddress("test:staking-router-modules:lido"), // mock lido address
      withdrawalCredentials,
    );

    // grant roles
    await Promise.all([stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin)]);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  context("getTopUpDepositAmount", () => {
    it("Reverts if the module does not exist", async () => {
      await expect(stakingRouter.getTopUpDepositAmount(1n, 100n, [10n, 20n])).to.be.revertedWithCustomError(
        stakingRouter,
        "StakingModuleUnregistered",
      );
    });

    it("Reverts if the module is not a new module", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 100n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
      };

      const [, id] = await setupModule(config);

      await expect(stakingRouter.getTopUpDepositAmount(id, 100n, [10n])).to.be.revertedWithCustomError(
        stakingRouter,
        "WrongWithdrawalCredentialsType",
      );
    });

    it("Returns 0 if target allocation for the module is 0", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 0n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      };

      const [, id] = await setupModule(config);

      const depositableEth = 100n * NEW_MEB;

      expect(await stakingRouter.getTopUpDepositAmount(id, depositableEth, [10n, 5n])).to.equal(0n);
    });

    it("Returns 0 if there are no top up limits even if module has allocation", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 100n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      };

      const [, id] = await setupModule(config);

      //   const NEW_MEB = getModuleMEB(WithdrawalCredentialsType.WC0x02);
      const depositableEth = 100n * NEW_MEB;

      expect(await stakingRouter.getTopUpDepositAmount(id, depositableEth, [])).to.equal(0n);
    });

    it("Returns the sum of top up limits when it is below module allocation", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 100n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      };

      const [, id] = await setupModule(config);

      //   const NEW_MEB = getModuleMEB(WithdrawalCredentialsType.WC0x02);
      // Big enough so that allocation is capped only by module capacity
      const depositableEth = 200n * NEW_MEB;

      const currentBalanceKey1 = 1500n;
      const currentBalanceKey2 = 1000n;
      const topUpKey1 = NEW_MEB - currentBalanceKey1; // 548
      const topUpKey2 = NEW_MEB - currentBalanceKey2; // 1048

      const topUpLimits = [topUpKey1, topUpKey2]; // [548, 1048], total 1596 < 2 * 2048
      const expectedTopUp = topUpKey1 + topUpKey2;

      expect(await stakingRouter.getTopUpDepositAmount(id, depositableEth, topUpLimits)).to.equal(expectedTopUp);
    });

    it("Caps by module allocation when top up limits exceed it", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 2n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      };

      const [, id] = await setupModule(config);
      await setupModule(config); // second module with the same config

      const depositableEth = 2n * NEW_MEB;

      const topUpLimits = [
        100n * GWEI, // 100 gwei
        NEW_MEB - 32n * GWEI, // almost full key (2048 ETH - 32 gwei)
        NEW_MEB - 32n * GWEI, // another almost full key
      ];

      const expectedAllocation = NEW_MEB;

      expect(await stakingRouter.getTopUpDepositAmount(id, depositableEth, topUpLimits)).to.equal(expectedAllocation);
    });
  });

  context("topUp", () => {
    const KEY_INDEX = 0n;
    const OPERATOR_ID = 1n;
    const TOP_UP_LIMIT_GWEI = 1_000_000_000n;

    function makeValidTopUpData() {
      const keyIndices = [KEY_INDEX];
      const operatorIds = [OPERATOR_ID];
      const topUpLimitsGwei = [TOP_UP_LIMIT_GWEI];
      const pubkeysPacked = hexlify(randomBytes(48));

      return { keyIndices, operatorIds, topUpLimitsGwei, pubkeysPacked };
    }

    it("Reverts if the module does not exist", async () => {
      const { keyIndices, operatorIds, topUpLimitsGwei, pubkeysPacked } = makeValidTopUpData();

      await expect(
        stakingRouter.topUp(1n, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleUnregistered");
    });

    it("Reverts if the module is Legacy (top-ups only supported for New)", async () => {
      const [, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
      });

      const { keyIndices, operatorIds, topUpLimitsGwei, pubkeysPacked } = makeValidTopUpData();

      await expect(
        stakingRouter.topUp(id, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingRouter, "WrongWithdrawalCredentialsType");
    });

    it("Does not perform a deposit when msg.value is 0 for a New module", async () => {
      const [, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const { keyIndices, operatorIds, topUpLimitsGwei, pubkeysPacked } = makeValidTopUpData();

      await expect(
        stakingRouter.topUp(id, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, { value: 0n }),
      ).not.to.emit(depositContract, "Deposited__MockEvent");
    });

    it("Performs top-up for a New module with default obtainDepositData (all keys used)", async () => {
      const [, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const keyIndices = [0n, 1n, 2n];
      const operatorIds = [1n, 2n, 3n];

      const topUpLimitsGwei = [
        10n * GWEI, // 10 ETH
        20n * GWEI, // 20 ETH
        30n * GWEI, // 30 ETH
      ];

      const pubkeysPacked = hexlify(randomBytes(48 * keyIndices.length));

      const totalTopUpGwei = topUpLimitsGwei.reduce((acc, v) => acc + v, 0n);

      const depositsValueWei = totalTopUpGwei * GWEI;

      const tx = await stakingRouter.topUp(id, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, {
        value: depositsValueWei,
      });

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);

      expect(depositEvents.length).to.equal(keyIndices.length);
    });

    it("Performs top-up for a New module with custom module top-up data (subset of keys)", async () => {
      const [module, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const keyIndices = [0n, 1n, 2n];
      const operatorIds = [1n, 2n, 3n];

      const topUpLimitsGwei = [
        100n * GWEI, // 100 ETH
        500n * GWEI, // 500 ETH
        800n * GWEI, // 800 ETH
      ];

      const pubkeysPacked = hexlify(randomBytes(48 * keyIndices.length));

      const customPubkeys = [hexlify(randomBytes(48)), hexlify(randomBytes(48))];

      // Суммы топ-апа в gwei для выбранных ключей
      const customTopUpsGwei = [topUpLimitsGwei[0], topUpLimitsGwei[2]];

      // Готовим mock-ответ модуля
      await module.mock__setTopUpDepositData(customPubkeys, customTopUpsGwei);

      const totalCustomTopUpGwei = customTopUpsGwei.reduce((acc, v) => acc + v, 0n);

      const depositsValueWei = totalCustomTopUpGwei * GWEI;

      const tx = await stakingRouter.topUp(id, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, {
        value: depositsValueWei,
      });

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);

      expect(depositEvents.length).to.equal(customPubkeys.length);
    });
  });

  async function setupModule({
    stakeShareLimit,
    priorityExitShareThreshold,
    moduleFee,
    treasuryFee,
    maxDepositsPerBlock,
    minDepositBlockDistance,
    exited = 0n,
    deposited = 0n,
    depositable = 0n,
    status = StakingModuleStatus.Active,
    withdrawalCredentialsType = WithdrawalCredentialsType.WC0x01,
    effBalanceGwei = 0n,
  }: ModuleConfig): Promise<[StakingModuleV2__MockForStakingRouter, bigint]> {
    const modulesCount = await stakingRouter.getStakingModulesCount();
    const module = await ethers.deployContract("StakingModuleV2__MockForStakingRouter", deployer);

    const stakingModuleConfig = {
      stakeShareLimit,
      priorityExitShareThreshold,
      stakingModuleFee: moduleFee,
      treasuryFee,
      maxDepositsPerBlock,
      minDepositBlockDistance,
      withdrawalCredentialsType,
    };

    await stakingRouter
      .connect(admin)
      .addStakingModule(randomBytes(8).toString(), await module.getAddress(), stakingModuleConfig);

    const moduleId = modulesCount + 1n;
    expect(await stakingRouter.getStakingModulesCount()).to.equal(modulesCount + 1n);

    await module.mock__getStakingModuleSummary(exited, deposited, depositable);
    if (effBalanceGwei == 0n && deposited > 0n) {
      effBalanceGwei =
        (deposited * getModuleMEB(withdrawalCredentialsType)) / 1_000_000_000n; // in gwei
    }
    await stakingRouter.testing_setStakingModuleAccounting(moduleId, effBalanceGwei, effBalanceGwei, exited);

    if (status != StakingModuleStatus.Active) {
      await stakingRouter.setStakingModuleStatus(moduleId, status);
    }

    return [module, moduleId];
  }
});

interface ModuleConfig {
  stakeShareLimit: bigint;
  priorityExitShareThreshold: bigint;
  moduleFee: bigint;
  treasuryFee: bigint;
  maxDepositsPerBlock: bigint;
  minDepositBlockDistance: bigint;
  withdrawalCredentialsType: WithdrawalCredentialsType;
  exited?: bigint;
  deposited?: bigint;
  depositable?: bigint;
  status?: StakingModuleStatus;
  effBalanceGwei?: bigint;
}
