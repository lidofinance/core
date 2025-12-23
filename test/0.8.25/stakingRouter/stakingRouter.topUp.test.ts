import { expect } from "chai";
import { hexlify, randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  BeaconChainDepositor,
  DepositContract__MockForBeaconChainDepositor,
  StakingModuleV2__MockForStakingRouter,
  StakingRouter__Harness,
} from "typechain-types";

import { findEventsWithInterfaces } from "lib";
import { getModuleMEB, StakingModuleStatus, TOTAL_BASIS_POINTS, WithdrawalCredentialsType } from "lib/constants";

import { Snapshot } from "test/suite";

import { deployStakingRouter } from "../../deploy/stakingRouter";

describe("StakingRouter.sol:topUp", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let lido: HardhatEthersSigner;

  let stakingRouter: StakingRouter__Harness;
  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let beaconChainDepositor: BeaconChainDepositor;

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

  const GWEI = 1_000_000_000n;
  const NEW_MEB = getModuleMEB(WithdrawalCredentialsType.WC0x02);
  const NEW_MEB_GWEI = 2048n * GWEI;
  const WEI_PER_ETH = 10n ** 18n;
  const withdrawalCredentials = hexlify(randomBytes(32));

  before(async () => {
    [deployer, admin, lido] = await ethers.getSigners();
    ({ stakingRouter, depositContract, beaconChainDepositor } = await deployStakingRouter({ deployer, admin }));

    // initialize staking router
    await stakingRouter.initialize(
      admin,
      lido.address, // mock lido address
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

      const topUpKey1Eth = 548n;
      const topUpKey2Eth = 1048n;
      const topUpLimits = [topUpKey1Eth * GWEI, topUpKey2Eth * GWEI]; // gwei amounts
      const expectedTopUp = (topUpKey1Eth + topUpKey2Eth) * WEI_PER_ETH;

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
        NEW_MEB_GWEI - 32n, // almost full key (2048 ETH - 32 gwei)
        NEW_MEB_GWEI - 32n, // another almost full key
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
        stakingRouter.connect(lido).topUp(1n, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleUnregistered");
    });

    it("Reverts if the module is Legacy (top-ups only supported for New)", async () => {
      const [, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
      });

      const { keyIndices, operatorIds, topUpLimitsGwei, pubkeysPacked } = makeValidTopUpData();

      await expect(
        stakingRouter.connect(lido).topUp(id, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingRouter, "WrongWithdrawalCredentialsType");
    });

    it("Does not perform a deposit when msg.value is 0 for a New module with zero limits", async () => {
      const [module, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const keyIndices = [0n];
      const operatorIds = [1n];
      const topUpLimitsGwei = [0n]; // Zero limit
      const pubkeysPacked = hexlify(randomBytes(48));

      // Mock module to return zero allocation matching msg.value
      const customPubkeys = [hexlify(randomBytes(48))];
      const zeroAllocations = [0n];
      await module.mock__setTopUpDepositData(customPubkeys, zeroAllocations);

      // Should succeed without making a deposit - module is still called for CSM cursor advancement
      const tx = await stakingRouter
        .connect(lido)
        .topUp(id, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, { value: 0n });

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);

      expect(depositEvents.length).to.equal(0);
    });

    it("Performs top-up for a New module for all keys", async () => {
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

      const tx = await stakingRouter.connect(lido).topUp(id, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, {
        value: depositsValueWei,
      });

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);

      expect(depositEvents.length).to.equal(keyIndices.length);
    });

    it("Performs top-up for a New module for subset of keys", async () => {
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

      const pubkeys = [hexlify(randomBytes(48)), hexlify(randomBytes(48)), hexlify(randomBytes(48))];

      const customPubkeys = pubkeys.slice(0, 2);
      const customTopUpsGwei = [topUpLimitsGwei[0], topUpLimitsGwei[2]];

      const pubkeysPacked = ethers.concat(pubkeys);

      await module.mock__setTopUpDepositData(customPubkeys, customTopUpsGwei);

      const totalCustomTopUpGwei = customTopUpsGwei.reduce((acc, v) => acc + v, 0n);

      const depositsValueWei = totalCustomTopUpGwei * GWEI;

      const tx = await stakingRouter.connect(lido).topUp(id, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, {
        value: depositsValueWei,
      });

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);

      expect(depositEvents.length).to.equal(customPubkeys.length);
    });

    it("Reverts when module returns sub-minimum allocation (< 1 ETH)", async () => {
      const [module, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const keyIndices = [0n];
      const operatorIds = [1n];
      const topUpLimitsGwei = [2n * GWEI]; // 2 ETH limit
      // Mock module to return allocation below 1 ETH minimum
      const customPubkeys = [hexlify(randomBytes(48))];
      const pubkeysPacked = ethers.concat(customPubkeys);
      const subMinimumAllocation = [500_000_000n]; // 0.5
      // ETH in Gwei - below minimum

      await module.mock__setTopUpDepositData(customPubkeys, subMinimumAllocation);

      const depositAmount = subMinimumAllocation[0] * GWEI; // 0.5 ETH

      // BeaconChainDepositor should revert with DepositAmountTooLow
      await expect(
        stakingRouter
          .connect(lido)
          .topUp(id, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, { value: depositAmount }),
      ).to.be.revertedWithCustomError(beaconChainDepositor, "DepositAmountTooLow");
    });

    it("depositAmount can be less than sum of topUpLimits", async () => {
      const [module, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const keyIndices = [0n, 1n];
      const operatorIds = [1n, 2n];

      // TopUpGateway calculated limits totaling 10 ETH
      const topUpLimitsGwei = [
        5n * GWEI, // 5 ETH limit
        5n * GWEI, // 5 ETH limit (total 10 ETH)
      ];

      // Module decides to allocate less than the limits
      const customPubkeys = [hexlify(randomBytes(48)), hexlify(randomBytes(48))];
      const pubkeysPacked = ethers.concat(customPubkeys);

      const allocations = [3n * GWEI, 3n * GWEI]; // 3 ETH each = 6 ETH total (less than 10 ETH limit)

      await module.mock__setTopUpDepositData(customPubkeys, allocations);

      // Lido sends 6 ETH based on allocation
      const depositAmount = 6n * GWEI * GWEI; // 6 ETH

      const tx = await stakingRouter.connect(lido).topUp(id, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, {
        value: depositAmount,
      });

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);

      expect(depositEvents.length).to.equal(2);
    });

    it("topUp should revert if module returned different amount from depositAmount", async () => {
      const [module, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const keyIndices = [0n, 1n];
      const operatorIds = [1n, 2n];

      // TopUpGateway calculated limits totaling 10 ETH
      const topUpLimitsGwei = [
        5n * GWEI, // 5 ETH limit
        5n * GWEI, // 5 ETH limit (total 10 ETH)
      ];

      // Module decides to allocate less than the limits
      const customPubkeys = [hexlify(randomBytes(48)), hexlify(randomBytes(48))];
      const pubkeysPacked = ethers.concat(customPubkeys);

      const allocations = [2n * GWEI, 2n * GWEI]; // 3 ETH each = 6 ETH total (less than 10 ETH limit)

      await module.mock__setTopUpDepositData(customPubkeys, allocations);

      // Lido sends 6 ETH based on allocation
      const depositAmount = 6n * GWEI * GWEI; // 6 ETH

      await expect(
        stakingRouter.topUp(id, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, {
          value: depositAmount,
        }),
      ).to.be.reverted;
    });

    it("propagates revert when module's obtainDepositData reverts", async () => {
      const [module, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const keyIndices = [0n];
      const operatorIds = [1n];
      const topUpLimitsGwei = [10n * GWEI];
      const pubkeysPacked = hexlify(randomBytes(48));
      const depositAmount = 10n * GWEI * GWEI;

      // Set module to revert
      await module.mock__setShouldRevert(true);

      await expect(
        stakingRouter.connect(lido).topUp(id, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, {
          value: depositAmount,
        }),
      ).to.be.revertedWith("Mock: revert requested");
    });

    it("tracks deposits via deposit tracker", async () => {
      const [, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const keyIndices = [0n];
      const operatorIds = [1n];
      const topUpLimitsGwei = [10n * GWEI];
      const pubkeysPacked = hexlify(randomBytes(48));
      const depositAmount = 10n * GWEI * GWEI;

      // Get deposit amount tracked before
      const depositBefore = await stakingRouter.getDepositAmountFromLastSlot(999999999n);

      await stakingRouter.connect(lido).topUp(id, keyIndices, operatorIds, pubkeysPacked, topUpLimitsGwei, {
        value: depositAmount,
      });

      // Get deposit amount tracked after
      const depositAfter = await stakingRouter.getDepositAmountFromLastSlot(999999999n);

      expect(depositAfter).to.equal(depositBefore + depositAmount);
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
      effBalanceGwei = (deposited * getModuleMEB(withdrawalCredentialsType)) / 1_000_000_000n; // in gwei
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
