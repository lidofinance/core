import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracle__MockForStakingRouter,
  Lido__MockForStakingRouter,
  LidoLocator,
  StakingRouter__Harness,
} from "typechain-types";

import { randomWCType1 } from "lib";
import { MAX_TOP_UP_PER_BLOCK_GWEI, ONE_GWEI, StakingModuleStatus, WithdrawalCredentialsType } from "lib/constants";

import { deployLidoLocator, deployStakingRouter } from "test/deploy";
import { Snapshot } from "test/suite";

import { CtxConfig, DEFAULT_CONFIG, DEFAULT_MEB, setupModule } from "./helpers";

describe("StakingRouter.sol:getDepositAllocations", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;

  let locator: LidoLocator;
  let stakingRouter: StakingRouter__Harness;
  let lidoMock: Lido__MockForStakingRouter;
  let accountingOracle: AccountingOracle__MockForStakingRouter;

  let originalState: string;

  let ctx: CtxConfig;

  const withdrawalCredentials = randomWCType1();
  const depositSecurityModule = "0x0000000000000000000000000000000000000002";

  before(async () => {
    [deployer, admin] = await ethers.getSigners();

    lidoMock = await ethers.deployContract("Lido__MockForStakingRouter", deployer);
    accountingOracle = await ethers.deployContract("AccountingOracle__MockForStakingRouter", deployer);

    locator = await deployLidoLocator({
      lido: await lidoMock.getAddress(),
      depositSecurityModule,
      accountingOracle: await accountingOracle.getAddress(),
    });

    ({ stakingRouter } = await deployStakingRouter({ deployer, admin }, { lidoLocator: locator, lido: lidoMock }));

    await lidoMock.setStakingRouter(await stakingRouter.getAddress());
    await stakingRouter.initialize(admin, withdrawalCredentials, MAX_TOP_UP_PER_BLOCK_GWEI);
    await stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin);

    ctx = {
      deployer,
      admin,
      stakingRouter,
    };
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("getDepositAllocations (seed deposits)", () => {
    it("Returns empty arrays when there are no modules registered", async () => {
      const result = await stakingRouter.getDepositAllocations(100n, false);
      expect(result.totalAllocated).to.equal(0n);
      expect(result.allocated).to.deep.equal([]);
      expect(result.newAllocations).to.deep.equal([]);
    });

    it("Returns all allocations to a single module if there is only one", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 100n,
      };

      await setupModule(ctx, config);

      const ethToDeposit = 150n * DEFAULT_MEB;
      const moduleAllocation = config.depositable * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);
      expect(result.totalAllocated).to.equal(moduleAllocation);
      expect(result.newAllocations).to.deep.equal([moduleAllocation]);
      expect(result.allocated).to.deep.equal([moduleAllocation]);
    });

    it("Allocates evenly if target shares are equal and capacities allow for that", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 50n,
      };

      await setupModule(ctx, config);
      await setupModule(ctx, config);

      const ethToDeposit = 200n * DEFAULT_MEB;
      const moduleAllocation = config.depositable * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);
      expect(result.totalAllocated).to.equal(moduleAllocation * 2n);
      expect(result.newAllocations).to.deep.equal([moduleAllocation, moduleAllocation]);
      expect(result.allocated).to.deep.equal([moduleAllocation, moduleAllocation]);
    });

    it("Does not allocate to non-Active modules", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 50n,
      };

      await setupModule(ctx, config);
      await setupModule(ctx, { ...config, status: StakingModuleStatus.DepositsPaused });

      const ethToDeposit = 200n * DEFAULT_MEB;
      const moduleAllocation = config.depositable * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);
      expect(result.totalAllocated).to.equal(moduleAllocation);
      expect(result.newAllocations).to.deep.equal([moduleAllocation, 0n]);
      expect(result.allocated).to.deep.equal([moduleAllocation, 0n]);
    });

    it("Allocates according to capacities at equal target shares", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 100n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 50n,
      };

      await setupModule(ctx, module1Config);
      await setupModule(ctx, module2Config);

      const ethToDeposit = 200n * DEFAULT_MEB;
      const module1Allocation = module1Config.depositable * DEFAULT_MEB;
      const module2Allocation = module2Config.depositable * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);
      expect(result.totalAllocated).to.equal(module1Allocation + module2Allocation);
      expect(result.newAllocations).to.deep.equal([module1Allocation, module2Allocation]);
      expect(result.allocated).to.deep.equal([module1Allocation, module2Allocation]);
    });

    it("Allocates according to target shares", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 60_00n,
        priorityExitShareThreshold: 60_00n,
        depositable: 100n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 40_00n,
        priorityExitShareThreshold: 40_00n,
        depositable: 100n,
      };

      await setupModule(ctx, module1Config);
      await setupModule(ctx, module2Config);

      const ethToDeposit = 200n * DEFAULT_MEB;
      const module1Allocation = 100n * DEFAULT_MEB;
      const module2Allocation = 80n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);
      expect(result.totalAllocated).to.equal(module1Allocation + module2Allocation);
      expect(result.newAllocations).to.deep.equal([module1Allocation, module2Allocation]);
    });

    it("Allocates with unlimited (100%) and 20% limited share modules", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 100_00n,
        priorityExitShareThreshold: 100_00n,
        depositable: 200n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 20_00n,
        priorityExitShareThreshold: 20_00n,
        depositable: 200n,
      };

      await setupModule(ctx, module1Config);
      await setupModule(ctx, module2Config);

      // totalValidators = 0 + 0 + 200 = 200
      // Module 1 target: (10000 * 200) / 10000 = 200, cap = min(200, 200) = 200
      // Module 2 target: (2000 * 200) / 10000 = 40, cap = min(40, 200) = 40
      // MinFirst: [0,0] caps [200,40]
      //   fill both to 40: cost 80, remaining 120
      //   module 2 at cap, module 1 gets 120
      //   result: [160, 40], total = 200
      const ethToDeposit = 200n * DEFAULT_MEB;
      const module1Allocation = 160n * DEFAULT_MEB;
      const module2Allocation = 40n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);
      expect(result.totalAllocated).to.equal(module1Allocation + module2Allocation);
      expect(result.newAllocations).to.deep.equal([module1Allocation, module2Allocation]);
      expect(result.allocated).to.deep.equal([module1Allocation, module2Allocation]);
    });

    it("Unlimited module absorbs excess when 20% module hits share limit with pre-existing deposits", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 100_00n,
        priorityExitShareThreshold: 100_00n,
        depositable: 100n,
        deposited: 50n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 20_00n,
        priorityExitShareThreshold: 20_00n,
        depositable: 100n,
        deposited: 50n,
      };

      await setupModule(ctx, module1Config);
      await setupModule(ctx, module2Config);

      // totalValidators = 50 + 50 + 200 = 300
      // Module 1 target: (10000 * 300) / 10000 = 300, cap = min(300, 150) = 150
      // Module 2 target: (2000 * 300) / 10000 = 60, cap = min(60, 150) = 60
      // MinFirst: [50,50] caps [150,60]
      //   fill both to 60: cost 20, remaining 180
      //   module 2 at cap, module 1 gets min(180, 90) = 90
      //   result: [150, 60], total allocated = 110
      const ethToDeposit = 200n * DEFAULT_MEB;
      const module1Delta = 100n * DEFAULT_MEB;
      const module2Delta = 10n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);
      expect(result.totalAllocated).to.equal(module1Delta + module2Delta);
      expect(result.newAllocations).to.deep.equal([150n * DEFAULT_MEB, 60n * DEFAULT_MEB]);
      expect(result.allocated).to.deep.equal([module1Delta, module2Delta]);
    });

    it("Returns zero allocated array when deposit amount is zero", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 50n,
      };

      await setupModule(ctx, config);

      const result = await stakingRouter.getDepositAllocations(0n, false);
      expect(result.totalAllocated).to.equal(0n);
      expect(result.allocated).to.deep.equal([0n]);
      // newAllocations should reflect current allocation state (no deposited = 0)
      expect(result.newAllocations).to.deep.equal([0n]);
    });

    it("Reverts for a top-up allocation request", async () => {
      await setupModule(ctx, { ...DEFAULT_CONFIG, withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02 });

      await expect(stakingRouter.getDepositAllocations(100n * DEFAULT_MEB, true)).to.be.revertedWithCustomError(
        stakingRouter,
        "TopUpAllocationNotSupported",
      );
    });
  });

  context("getStakingModuleTopUpAllocation", () => {
    it("Reverts for an unregistered module", async () => {
      await expect(stakingRouter.getStakingModuleTopUpAllocation(1n, 100n)).to.be.revertedWithCustomError(
        stakingRouter,
        "StakingModuleUnregistered",
      );
    });

    it("Returns 0 for a 0x01 module", async () => {
      const [, id] = await setupModule(ctx, { ...DEFAULT_CONFIG, deposited: 10n, depositable: 50n });

      expect(await stakingRouter.getStakingModuleTopUpAllocation(id, 100n * DEFAULT_MEB)).to.equal(0n);
    });

    it("Returns the whole room of a single 0x02 module", async () => {
      // capacity = activeValidators * maxEBType2 / maxEBType1
      // We need deposited validators with initial balance (32 ETH each) to create top-up room
      const deposited = 10n;
      const [, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * ONE_GWEI, // each validator at initial 32 ETH
      });

      // capacity_equiv = 10 * 2048/32 = 640, current_equiv = 10, room = 630
      const ethToDeposit = 631n * DEFAULT_MEB;
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id, ethToDeposit)).to.equal(630n * DEFAULT_MEB);
    });

    it("Gives each of two equal modules the same allocation when it is the one topped up", async () => {
      const deposited = 1n;
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * ONE_GWEI,
      };

      const [, id1] = await setupModule(ctx, config);
      const [, id2] = await setupModule(ctx, config);

      // capacity_equiv = 1 * 2048/32 = 64, current_equiv = 1, room = 63
      // total = 1 + 1 + 50 = 52, target = 26: the topped-up module grows from 1 to 26
      const ethToDeposit = 50n * DEFAULT_MEB;
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id1, ethToDeposit)).to.equal(25n * DEFAULT_MEB);
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id2, ethToDeposit)).to.equal(25n * DEFAULT_MEB);
    });

    it("Returns 0 for a non-Active module", async () => {
      const deposited = 1n;
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * ONE_GWEI,
      };

      const [, id1] = await setupModule(ctx, config);
      const [, id2] = await setupModule(ctx, { ...config, status: StakingModuleStatus.DepositsPaused });

      // Module 1: capacity_equiv = 1 * 2048/32 = 64, current_equiv = 1, room = 63
      const ethToDeposit = 200n * DEFAULT_MEB;
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id1, ethToDeposit)).to.equal(63n * DEFAULT_MEB);
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id2, ethToDeposit)).to.equal(0n);
    });

    it("Limits the allocation by the active keys capacity at equal target shares", async () => {
      // Module with more active validators has more top-up capacity
      const module1Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        deposited: 10n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: 10n * 32n * ONE_GWEI,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        deposited: 2n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: 2n * 32n * ONE_GWEI,
      };

      const [, id1] = await setupModule(ctx, module1Config);
      const [, id2] = await setupModule(ctx, module2Config);

      // total = 10+2+1000 = 1012, target = 506 each
      // Module 1 topped up: capacity = min(506, 10*64) = 506, module 2 stays at 2, delta = 496
      // Module 2 topped up: capacity = min(506, 2*64) = 128, module 1 stays at 10, delta = 126
      const ethToDeposit = 1000n * DEFAULT_MEB;
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id1, ethToDeposit)).to.equal(496n * DEFAULT_MEB);
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id2, ethToDeposit)).to.equal(126n * DEFAULT_MEB);
    });

    it("Limits the allocation by the target share", async () => {
      // Same deposited count, different share limits → allocation driven by target shares
      const deposited = 10n;
      const module1Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 60_00n,
        priorityExitShareThreshold: 60_00n,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * ONE_GWEI,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 40_00n,
        priorityExitShareThreshold: 40_00n,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * ONE_GWEI,
      };

      const [, id1] = await setupModule(ctx, module1Config);
      const [, id2] = await setupModule(ctx, module2Config);

      // total = 10+10+80 = 100, target1 = 60, target2 = 40
      // Module 1 topped up: grows from 10 to 60, delta = 50
      // Module 2 topped up: grows from 10 to 40, delta = 30
      const ethToDeposit = 80n * DEFAULT_MEB;
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id1, ethToDeposit)).to.equal(50n * DEFAULT_MEB);
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id2, ethToDeposit)).to.equal(30n * DEFAULT_MEB);
    });

    it("Gives the unlimited (100%) module the whole buffer while the 20% module has no seed demand", async () => {
      const deposited = 10n;
      const module1Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 100_00n,
        priorityExitShareThreshold: 100_00n,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * ONE_GWEI,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 20_00n,
        priorityExitShareThreshold: 20_00n,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * ONE_GWEI,
      };

      const [, id1] = await setupModule(ctx, module1Config);
      const [, id2] = await setupModule(ctx, module2Config);

      // totalValidators = 10 + 10 + 100 = 120
      // Module 1 topped up: capacity = min(120, 640) = 120; module 2 has no seed demand and stays at 10,
      //   so module 1 takes all 100
      // Module 2 topped up: capacity = min(24, 640) = 24, grows from 10 to 24
      const ethToDeposit = 100n * DEFAULT_MEB;
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id1, ethToDeposit)).to.equal(100n * DEFAULT_MEB);
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id2, ethToDeposit)).to.equal(14n * DEFAULT_MEB);
    });

    it("Limits the 20% module by its active keys when it has fewer of them", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 100_00n,
        priorityExitShareThreshold: 100_00n,
        deposited: 10n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: 10n * 32n * ONE_GWEI,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 20_00n,
        priorityExitShareThreshold: 20_00n,
        deposited: 1n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: 1n * 32n * ONE_GWEI,
      };

      const [, id1] = await setupModule(ctx, module1Config);
      const [, id2] = await setupModule(ctx, module2Config);

      // Module 1: cap_raw = 10 * 64 = 640, current = 10
      // Module 2: cap_raw = 1 * 64 = 64, current = 1
      // totalValidators = 10 + 1 + 600 = 611
      // Module 1 topped up: cap = min(611, 640) = 611; module 2 stays at 1, so module 1 takes all 600
      // Module 2 topped up: cap = min(122, 64) = 64, grows from 1 to 64
      const ethToDeposit = 600n * DEFAULT_MEB;
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id1, ethToDeposit)).to.equal(600n * DEFAULT_MEB);
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id2, ethToDeposit)).to.equal(63n * DEFAULT_MEB);
    });

    it("Returns 0 when deposit amount is zero", async () => {
      const [, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        deposited: 10n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: 10n * 32n * ONE_GWEI,
      });

      expect(await stakingRouter.getStakingModuleTopUpAllocation(id, 0n)).to.equal(0n);
    });

    it("Returns 0 when the deposit amount is below one unit", async () => {
      const [, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        deposited: 10n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: 10n * 32n * ONE_GWEI,
      });

      expect(await stakingRouter.getStakingModuleTopUpAllocation(id, DEFAULT_MEB - 1n)).to.equal(0n);
    });

    for (const { depositable, expectedTopUp } of [
      { depositable: 30n, expectedTopUp: 20n * DEFAULT_MEB },
      { depositable: 50n, expectedTopUp: 0n },
    ]) {
      it(`Reserves ${depositable} seed deposits for a less filled 0x02 module`, async () => {
        const [, id] = await setupModule(ctx, {
          ...DEFAULT_CONFIG,
          withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
          deposited: 20n,
          totalModuleStake: 10_000n * 10n ** 18n,
        });
        await setupModule(ctx, {
          ...DEFAULT_CONFIG,
          withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
          deposited: 16n,
          depositable,
          totalModuleStake: 16n * DEFAULT_MEB,
        });

        // The neighbour's seed capacity stays below the target's level of 313 units.
        const buffer = 50n * DEFAULT_MEB;
        const seed = await stakingRouter.getDepositAllocations(buffer, false);
        expect(seed.allocated).to.deep.equal([0n, depositable * DEFAULT_MEB]);
        expect(await stakingRouter.getStakingModuleTopUpAllocation(id, buffer)).to.equal(expectedTopUp);
      });
    }
  });

  context("multi-module top-up scenarios", () => {
    // Module balances from SR accounting (wei)
    const MODULE_1_BALANCE_GWEI = 960_006_155_190_000_000_000n / ONE_GWEI; // ~960.006 ETH ~ 31 validators
    const MODULE_2_BALANCE_GWEI = 0n;
    const MODULE_3_BALANCE_GWEI = 1_600_010_258_650_000_000_000n / ONE_GWEI; // ~1600.01 ETH ~ 51 validators
    const MODULE_4_BALANCE_GWEI = 1_988_080_734_502_000_000_000n / ONE_GWEI; // ~1988.08 ETH ~ 63 validators
    // in total 145 validators

    const BUFFER = 5_552_649_867_953_000_000_001n; // ~5552.65 ETH

    const sharesDefault = new Map<number, { stakeShareLimit: bigint; priorityExitShareThreshold: bigint }>();
    sharesDefault.set(1, { stakeShareLimit: 10000n, priorityExitShareThreshold: 10000n });
    sharesDefault.set(2, { stakeShareLimit: 400n, priorityExitShareThreshold: 10000n });
    sharesDefault.set(3, { stakeShareLimit: 2000n, priorityExitShareThreshold: 2500n });
    sharesDefault.set(4, { stakeShareLimit: 2000n, priorityExitShareThreshold: 2500n });

    async function setupModules(
      shares: Map<number, { stakeShareLimit: bigint; priorityExitShareThreshold: bigint }> = sharesDefault,
    ) {
      // Module 1: Curated (0x01, 100% share limit, 30 deposited, 0 depositable)
      await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        stakeShareLimit: shares.get(1)!.stakeShareLimit,
        priorityExitShareThreshold: shares.get(1)!.priorityExitShareThreshold,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
        deposited: 30n,
        exited: 0n,
        depositable: 0n,
        validatorsBalanceGwei: MODULE_1_BALANCE_GWEI,
      });

      // Module 2: SimpleDVT (0x01, 4% share limit, 0 deposited, 0 depositable)
      await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        stakeShareLimit: shares.get(2)!.stakeShareLimit,
        priorityExitShareThreshold: shares.get(2)!.priorityExitShareThreshold,
        moduleFee: 8_00n,
        treasuryFee: 2_00n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
        deposited: 0n,
        exited: 0n,
        depositable: 0n,
        validatorsBalanceGwei: MODULE_2_BALANCE_GWEI,
      });

      // Module 3: Community Staking (0x01, 20% share limit, 50 deposited, 0 depositable)
      await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        stakeShareLimit: shares.get(3)!.stakeShareLimit,
        priorityExitShareThreshold: shares.get(3)!.priorityExitShareThreshold,
        moduleFee: 8_00n,
        treasuryFee: 2_00n,
        maxDepositsPerBlock: 30n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
        deposited: 50n,
        exited: 0n,
        depositable: 0n,
        validatorsBalanceGwei: MODULE_3_BALANCE_GWEI,
      });

      // Module 4: curated-onchain-v2 (0x02, variable share limit, 25 deposited, 0 depositable)
      await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        stakeShareLimit: shares.get(4)!.stakeShareLimit,
        priorityExitShareThreshold: shares.get(4)!.priorityExitShareThreshold,
        moduleFee: 8_00n,
        treasuryFee: 2_00n,
        maxDepositsPerBlock: 30n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        deposited: 25n,
        exited: 0n,
        depositable: 0n,
        validatorsBalanceGwei: MODULE_4_BALANCE_GWEI,
        totalModuleStake: MODULE_4_BALANCE_GWEI * ONE_GWEI,
      });
    }

    const MODULE_4_ID = 4n;

    it("Returns zero top-up allocation when the 0x02 module is at its share limit", async () => {
      await setupModules();

      expect(await stakingRouter.getStakingModuleTopUpAllocation(MODULE_4_ID, BUFFER)).to.equal(0n);

      // seed allocation is zero as well: 0x01 modules have no depositable keys
      const seed = await stakingRouter.getDepositAllocations(BUFFER, false);
      expect(seed.totalAllocated).to.equal(0n, "totalAllocated should be 0 — no capacity in any modules");
      expect(seed.newAllocations.length).to.equal(4);

      const ETH32 = 32n * 10n ** 18n;
      // for type2 modules: newAllocations[i] = ceilDiv(totalModuleStake, 32 ETH) * 32 ETH
      const toValidatorETH = (balance: bigint) => ((balance + ETH32 - 1n) / ETH32) * ETH32;

      expect(seed.newAllocations[0]).to.equal(30n * ETH32);
      expect(seed.newAllocations[1]).to.equal(0n);
      expect(seed.newAllocations[2]).to.equal(50n * ETH32);
      expect(seed.newAllocations[3]).to.equal(toValidatorETH(MODULE_4_BALANCE_GWEI * ONE_GWEI));
    });

    it("Allocates to the 0x02 module when the buffer pushes its target above its current allocation", async () => {
      await setupModules();

      // to make some top up in 4 module -> it should have 64 validators
      // 64 * 32 = X * 32 * 20/100 -> X = 320 validators in total
      // already have 143 validators (30 + 50 + 63)
      // need 177 validators = 320 - 143
      // 177*32 = 5664 eth - minimum buffer

      const INCREASED_BUFFER = 5670n * 10n ** 18n;

      expect(await stakingRouter.getStakingModuleTopUpAllocation(MODULE_4_ID, BUFFER)).to.equal(
        0n,
        "sanity check: original buffer gives 0",
      );

      const allocation = await stakingRouter.getStakingModuleTopUpAllocation(MODULE_4_ID, INCREASED_BUFFER);
      expect(allocation).to.be.gt(32n, "allocation should be > 0 with larger buffer");

      // the whole allocation is one validator unit above the current level: 64 - 63 = 1
      const ETH32 = 32n * 10n ** 18n;
      expect(allocation).to.equal(ETH32);
    });
  });

  context("top-up with another 0x02 module whose keys wait for activation", () => {
    const ETH32 = 32n * 10n ** 18n;
    const BUFFER = 50n * ETH32; // 1600 ETH

    // Module 1: 0x01, 100 validators, `module1Depositable` new keys.
    // Module 2: large 0x02 module (CMv2-like), 20 keys holding 10 000 ETH in total.
    // Module 3: new 0x02 module (0x02 CSM-like), 16 seeded keys that are not active on CL yet,
    //           its top-up queue is full, so it reports 0 depositable keys.
    const LARGE_ID = 2n;
    const NEW_ID = 3n;

    async function setupModules(module1Depositable: bigint) {
      await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
        deposited: 100n,
        depositable: module1Depositable,
      });
      await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        deposited: 20n,
        totalModuleStake: 10_000n * 10n ** 18n,
      });
      await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        deposited: 16n,
        depositable: 0n,
        totalModuleStake: 16n * ETH32,
      });
    }

    it("Gives the large 0x02 module its allocation", async () => {
      await setupModules(0n);

      expect(await stakingRouter.getStakingModuleTopUpAllocation(LARGE_ID, BUFFER)).to.equal(BUFFER);
    });

    it("Keeps the priority of the least filled 0x02 module when it is topped up", async () => {
      await setupModules(0n);

      expect(await stakingRouter.getStakingModuleTopUpAllocation(NEW_ID, BUFFER)).to.equal(BUFFER);
    });

    it("Leaves the seed demand of a less filled 0x01 module in the buffer", async () => {
      await setupModules(30n);

      // MinFirst raises module 1 from 100 to 130 validators first; module 2 gets the remaining 20.
      expect(await stakingRouter.getStakingModuleTopUpAllocation(LARGE_ID, BUFFER)).to.equal(20n * ETH32);
    });

    it("Works with three 0x02 modules", async () => {
      await setupModules(0n);
      // Module 4: another new 0x02 module with 8 keys waiting for activation
      await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        deposited: 8n,
        depositable: 0n,
        totalModuleStake: 8n * ETH32,
      });

      expect(await stakingRouter.getStakingModuleTopUpAllocation(LARGE_ID, BUFFER)).to.equal(BUFFER);
    });
  });

  context("getDepositAllocations allocated (delta) array", () => {
    it("Returns per-module deltas that sum to totalAllocated", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 50n,
      };

      await setupModule(ctx, config);
      await setupModule(ctx, config);

      const ethToDeposit = 200n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);

      let allocatedSum = 0n;
      for (const a of result.allocated) {
        allocatedSum += a;
      }
      expect(allocatedSum).to.equal(result.totalAllocated);
    });

    it("Delta is zero for modules with no capacity", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 50n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 0n,
      };

      await setupModule(ctx, module1Config);
      await setupModule(ctx, module2Config);

      const ethToDeposit = 200n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);
      expect(result.allocated.length).to.equal(2);
      expect(result.allocated[0]).to.equal(module1Config.depositable * DEFAULT_MEB);
      expect(result.allocated[1]).to.equal(0n);
    });

    it("Delta reflects newly allocated amount with pre-existing deposits", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 50n,
        deposited: 100n,
      };

      await setupModule(ctx, config);

      const ethToDeposit = 50n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);

      // allocated[0] is the delta (new allocation)
      // newAllocations[0] includes existing validators + new
      expect(result.allocated[0]).to.equal(result.totalAllocated);
      expect(result.newAllocations[0]).to.be.equal(150n * DEFAULT_MEB); // 100 existing + 50 new = 150 total allocation after deposit
    });

    it("Returns 0 top-up allocation for 0x01 modules", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 50n,
      };

      const [, id1] = await setupModule(ctx, config);
      const [, id2] = await setupModule(ctx, config);

      expect(await stakingRouter.getStakingModuleTopUpAllocation(id1, 200n * DEFAULT_MEB)).to.equal(0n);
      expect(await stakingRouter.getStakingModuleTopUpAllocation(id2, 200n * DEFAULT_MEB)).to.equal(0n);
    });
  });
});
