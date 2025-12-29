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
      await expect(
        stakingRouter.getTopUpDepositAmount(1n, 100n, [0n, 1n], [0n, 0n], hexlify(randomBytes(96)), [10n, 20n]),
      ).to.be.revertedWithCustomError(stakingRouter, "AppAuthLidoFailed");
    });

    it("Reverts if the module is not support 0x02 keys", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 100n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
      };

      const [, id] = await setupModule(config);

      await expect(
        stakingRouter
          .connect(lido)
          .getTopUpDepositAmount(id, 100n, [0n, 1n], [0n, 0n], hexlify(randomBytes(96)), [10n, 20n]),
      ).to.be.revertedWithCustomError(stakingRouter, "WrongWithdrawalCredentialsType");
    });

    it("Returns 0 if target allocation for the module is 0", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 0n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      };

      const [stakingModule, id] = await setupModule(config);
      const pubkey = hexlify(randomBytes(48));
      // if module return sum allocations > module target allocation, sr will revert.
      // so to check behavior with zero deposit amount, mock module with 0 allocations
      await stakingModule.mock__setTopUpDepositData([pubkey], [0n]);

      const depositableEth = 100n * NEW_MEB;

      const [amount, ,] = await stakingRouter
        .connect(lido)
        .getTopUpDepositAmount.staticCall(id, depositableEth, [0n], [0n], pubkey, [10n]);

      expect(amount).to.equal(0n);
    });

    it("Returns 0 if module returned 0 allocations for keys, even if module can be deposited", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 100n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      };

      // as in our test only one module with 100 target share
      // it is target allocation will be depositable * 2048
      const [stakingModule, id] = await setupModule(config);

      // const NEW_MEB = 2048 ether
      const depositableEth = 80n * NEW_MEB;
      // mock of module.obtainDepositData
      const pubkey = hexlify(randomBytes(48));
      await stakingModule.mock__setTopUpDepositData([pubkey], [0n]);

      const [amount, pubkeys, allocations] = await stakingRouter
        .connect(lido)
        .getTopUpDepositAmount.staticCall(id, depositableEth, [0n], [0n], pubkey, [0n]);

      expect(amount).to.eq(0);
      expect(pubkeys).to.eq(pubkey);
      expect(allocations).to.deep.eq([0n]);
    });

    it("Returns the sum of keys top up values when it is below module allocation", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 100n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      };

      const [stakingModule, id] = await setupModule(config);
      // const NEW_MEB = getModuleMEB(WithdrawalCredentialsType.WC0x02);
      // Big enough so that allocation is capped only by module capacity
      const depositableEth = 200n * NEW_MEB;

      const pubkey1 = hexlify(randomBytes(48));
      const pubkey2 = hexlify(randomBytes(48));
      const packedPubkeys = ethers.concat([pubkey1, pubkey2]);
      const topUpKey1Eth = 548n;
      const topUpKey2Eth = 1048n;
      const topUpLimits = [topUpKey1Eth * GWEI, topUpKey2Eth * GWEI]; // gwei amounts
      const expectedTopUp = (topUpKey1Eth + topUpKey2Eth) * WEI_PER_ETH;
      await stakingModule.mock__setTopUpDepositData([pubkey1, pubkey2], topUpLimits);

      const [amount, pubkeys, allocations] = await stakingRouter
        .connect(lido)
        .getTopUpDepositAmount.staticCall(id, depositableEth, [0n, 1n], [0n, 0n], packedPubkeys, topUpLimits);
      expect(amount).to.equal(expectedTopUp);
      expect(pubkeys).to.equal(packedPubkeys);
      expect(allocations).to.deep.equal(topUpLimits);
    });

    it("throw error if module returned allocation > than allowed for module", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 2n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      };

      const [stakingModule, id] = await setupModule(config);
      await setupModule(config); // second module with the same config

      const depositableEth = 2n * NEW_MEB;

      const topUpLimits = [
        100n * GWEI, // 100 gwei
        NEW_MEB_GWEI - 32n, // almost full key (2048 ETH - 32 gwei)
        NEW_MEB_GWEI - 32n, // another almost full key
      ];

      const pubkey1 = hexlify(randomBytes(48));
      const pubkey2 = hexlify(randomBytes(48));
      const pubkey3 = hexlify(randomBytes(48));
      const packedPubkeys = ethers.concat([pubkey1, pubkey2, pubkey3]);
      await stakingModule.mock__setTopUpDepositData([pubkey1, pubkey2, pubkey3], topUpLimits);

      await expect(
        stakingRouter
          .connect(lido)
          .getTopUpDepositAmount(id, depositableEth, [0n, 1n, 2n], [0n, 0n, 0n], packedPubkeys, topUpLimits),
      ).to.be.revertedWithCustomError(stakingRouter, "AllocationExceedsTarget");
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
      const { topUpLimitsGwei, pubkeysPacked } = makeValidTopUpData();

      await expect(
        stakingRouter.connect(lido).topUp(1n, pubkeysPacked, topUpLimitsGwei, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleUnregistered");
    });

    it("Reverts if the module is Legacy (top-ups only supported for New)", async () => {
      const [, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
      });

      const { topUpLimitsGwei, pubkeysPacked } = makeValidTopUpData();

      await expect(
        stakingRouter.connect(lido).topUp(id, pubkeysPacked, topUpLimitsGwei, { value: 1n }),
      ).to.be.revertedWithCustomError(stakingRouter, "WrongWithdrawalCredentialsType");
    });

    it("Does not perform a deposit when msg.value is 0 for a New module with zero limits", async () => {
      const [, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const topUpLimitsGwei = [0n]; // Zero limit
      const pubkeysPacked = hexlify(randomBytes(48));

      const tx = await stakingRouter.connect(lido).topUp(id, pubkeysPacked, topUpLimitsGwei, { value: 0n });

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);

      expect(depositEvents.length).to.equal(0);
    });

    it("Performs top-up for a New module for all keys", async () => {
      const [, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const topUpGwei = [
        10n * GWEI, // 10 ETH
        20n * GWEI, // 20 ETH
        30n * GWEI, // 30 ETH
      ];

      const pubkeysPacked = hexlify(randomBytes(48 * topUpGwei.length));

      const totalTopUpGwei = topUpGwei.reduce((acc, v) => acc + v, 0n);

      const depositsValueWei = totalTopUpGwei * GWEI;

      const tx = await stakingRouter.connect(lido).topUp(id, pubkeysPacked, topUpGwei, {
        value: depositsValueWei,
      });

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);

      expect(depositEvents.length).to.equal(topUpGwei.length);
    });

    it("Reverts when top up for key < 1 ETH", async () => {
      const [, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const pubkeysPacked = hexlify(randomBytes(48));
      const topUpGwei = [500_000_000n]; // 0.5

      const depositAmount = topUpGwei[0] * GWEI; // 0.5 ETH

      // BeaconChainDepositor should revert with DepositAmountTooLow
      await expect(
        stakingRouter.connect(lido).topUp(id, pubkeysPacked, topUpGwei, { value: depositAmount }),
      ).to.be.revertedWithCustomError(beaconChainDepositor, "DepositAmountTooLow");
    });

    it("tracks deposits via deposit tracker", async () => {
      const [, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });
      const topUpGwei = [10n * GWEI];
      const pubkeysPacked = hexlify(randomBytes(48));
      const depositAmount = 10n * GWEI * GWEI;

      // Get deposit amount tracked before
      const depositBefore = await stakingRouter.getDepositAmountFromLastSlot(999999999n);

      await stakingRouter.connect(lido).topUp(id, pubkeysPacked, topUpGwei, {
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
    console.log("module count =", modulesCount);
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
