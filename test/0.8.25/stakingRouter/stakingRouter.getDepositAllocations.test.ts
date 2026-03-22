import { expect } from "chai";
import { randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracle__MockForStakingRouter,
  Lido__MockForStakingRouter,
  LidoLocator,
  StakingModule__MockForStakingRouter,
  StakingModuleV2__MockForStakingRouter,
  StakingRouter__Harness,
} from "typechain-types";

import { randomWCType1, wcTypeMaxEB } from "lib";
import { StakingModuleStatus, TOTAL_BASIS_POINTS, WithdrawalCredentialsType } from "lib/constants";

import { deployLidoLocator, deployStakingRouter } from "test/deploy";
import { Snapshot } from "test/suite";

describe("StakingRouter.sol:getDepositAllocations", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;

  let locator: LidoLocator;
  let stakingRouter: StakingRouter__Harness;
  let lidoMock: Lido__MockForStakingRouter;
  let accountingOracle: AccountingOracle__MockForStakingRouter;

  let originalState: string;

  const GWEI = 1_000_000_000n;

  const DEFAULT_CONFIG: ModuleConfig = {
    stakeShareLimit: TOTAL_BASIS_POINTS,
    priorityExitShareThreshold: TOTAL_BASIS_POINTS,
    moduleFee: 5_00n,
    treasuryFee: 5_00n,
    maxDepositsPerBlock: 150n,
    minDepositBlockDistance: 25n,
    withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
  };
  const DEFAULT_MEB = wcTypeMaxEB(DEFAULT_CONFIG.withdrawalCredentialsType);

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
    await stakingRouter.initialize(admin, withdrawalCredentials);
    await stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("getDepositAllocations with _isTopUp = false (initial deposits)", () => {
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

      await setupModule(config);

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

      await setupModule(config);
      await setupModule(config);

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

      await setupModule(config);
      await setupModule({ ...config, status: StakingModuleStatus.DepositsPaused });

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

      await setupModule(module1Config);
      await setupModule(module2Config);

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

      await setupModule(module1Config);
      await setupModule(module2Config);

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

      await setupModule(module1Config);
      await setupModule(module2Config);

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

      await setupModule(module1Config);
      await setupModule(module2Config);

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

      await setupModule(config);

      const result = await stakingRouter.getDepositAllocations(0n, false);
      expect(result.totalAllocated).to.equal(0n);
      expect(result.allocated).to.deep.equal([0n]);
      // newAllocations should reflect current allocation state (no deposited = 0)
      expect(result.newAllocations).to.deep.equal([0n]);
    });
  });

  context("getDepositAllocations with _isTopUp = true (top-up deposits)", () => {
    it("Returns empty arrays when there are no modules registered", async () => {
      const result = await stakingRouter.getDepositAllocations(100n, true);
      expect(result.totalAllocated).to.equal(0n);
      expect(result.allocated).to.deep.equal([]);
      expect(result.newAllocations).to.deep.equal([]);
    });

    it("Returns all allocations to a single module if there is only one", async () => {
      // For top-up 0x02 modules, capacity = activeValidators * maxEBType2 / maxEBType1
      // We need deposited validators with initial balance (32 ETH each) to create top-up room
      const deposited = 10n;
      const config = {
        ...DEFAULT_CONFIG,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * GWEI, // each validator at initial 32 ETH
      };

      await setupModule(config);

      // capacity_equiv = 10 * 2048/32 = 640, current_equiv = 10, room = 630
      const ethToDeposit = 631n * DEFAULT_MEB;
      const moduleAllocation = 630n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, true);
      expect(result.totalAllocated).to.equal(moduleAllocation);
      expect(result.newAllocations).to.deep.equal([(deposited + 630n) * DEFAULT_MEB]);
      expect(result.allocated).to.deep.equal([moduleAllocation]);
    });

    it("Allocates evenly if target shares are equal and capacities allow for that", async () => {
      const deposited = 1n;
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * GWEI,
      };

      await setupModule(config);
      await setupModule(config);

      // capacity_equiv = 1 * 2048/32 = 64, current_equiv = 1, room = 63
      const ethToDeposit = 50n * DEFAULT_MEB;
      const moduleAllocation = 25n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, true);
      expect(result.totalAllocated).to.equal(moduleAllocation * 2n);
      expect(result.newAllocations).to.deep.equal([(deposited + 25n) * DEFAULT_MEB, (deposited + 25n) * DEFAULT_MEB]);
      expect(result.allocated).to.deep.equal([moduleAllocation, moduleAllocation]);
    });

    it("Does not allocate to non-Active modules", async () => {
      const deposited = 1n;
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * GWEI,
      };

      await setupModule(config);
      await setupModule({ ...config, status: StakingModuleStatus.DepositsPaused });

      // Module 1: capacity_equiv = 1 * 2048/32 = 64, current_equiv = 1, room = 63
      const ethToDeposit = 200n * DEFAULT_MEB;
      const moduleAllocation = deposited * 63n * DEFAULT_MEB; // all to module 1 since module 2 is paused

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, true);
      expect(result.totalAllocated).to.equal(moduleAllocation);
      expect(result.newAllocations).to.deep.equal([(deposited + 63n) * DEFAULT_MEB, deposited * DEFAULT_MEB]);
      expect(result.allocated).to.deep.equal([moduleAllocation, 0n]);
    });

    it("Allocates according to capacities at equal target shares", async () => {
      // Module with more active validators has more top-up capacity
      const module1Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        deposited: 10n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: 10n * 32n * GWEI,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        deposited: 2n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: 2n * 32n * GWEI,
      };

      await setupModule(module1Config);
      await setupModule(module2Config);

      // Module 1: capacity_equiv = 10 * 2048/32 = 640, current_equiv = 10, room = 630
      // Module 2: capacity_equiv = 2 * 2048/32 = 128, current_equiv = 2, room = 126
      //
      // cap1_raw = 10*64=640, cap2_raw = 2*64=128
      // total = 10+2+1000 = 1012, target = 506 each
      // cap1 = min(506, 640)=506, cap2 = min(506, 128)=128
      // MinFirst: [10,2] caps [506,128]
      //   fill 2→10: +8, remaining 992
      //   fill equally to 128: each +118, remaining 756
      //   module 2 at cap, module 1 gets min(756, 506-128)=378
      //   total = 8+236+378 = 622
      // module1 delta = 496, module2 delta = 126
      const ethToDeposit = 1000n * DEFAULT_MEB;
      const module1Allocation = 496n * DEFAULT_MEB;
      const module2Allocation = 126n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, true);
      expect(result.totalAllocated).to.equal(module1Allocation + module2Allocation);
      expect(result.newAllocations).to.deep.equal([506n * DEFAULT_MEB, 128n * DEFAULT_MEB]);
      expect(result.allocated).to.deep.equal([module1Allocation, module2Allocation]);
    });

    it("Allocates according to target shares", async () => {
      // Same deposited count, different share limits → allocation driven by target shares
      const deposited = 10n;
      const module1Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 60_00n,
        priorityExitShareThreshold: 60_00n,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * GWEI,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 40_00n,
        priorityExitShareThreshold: 40_00n,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * GWEI,
      };

      await setupModule(module1Config);
      await setupModule(module2Config);

      // total = 10+10+80 = 100
      // target1 = 60, target2 = 40, cap_raw = 10*64=640 each
      // cap1 = min(60,640)=60, cap2 = min(40,640)=40
      // MinFirst: [10,10] caps [60,40]
      //   fill equally to 40: each +30, remaining 20
      //   module 2 at cap, module 1 gets 20
      //   total = 80
      const ethToDeposit = 80n * DEFAULT_MEB;
      const module1Allocation = 50n * DEFAULT_MEB;
      const module2Allocation = 30n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, true);
      expect(result.totalAllocated).to.equal(module1Allocation + module2Allocation);
      expect(result.newAllocations).to.deep.equal([60n * DEFAULT_MEB, 40n * DEFAULT_MEB]);
    });

    it("Allocates with unlimited (100%) and 20% limited share modules for top-up", async () => {
      const deposited = 10n;
      const module1Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 100_00n,
        priorityExitShareThreshold: 100_00n,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * GWEI,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 20_00n,
        priorityExitShareThreshold: 20_00n,
        deposited,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: deposited * 32n * GWEI,
      };

      await setupModule(module1Config);
      await setupModule(module2Config);

      // Each module: cap_raw = 10 * 2048/32 = 640 equiv validators
      // Current: 10 equiv each
      // totalValidators = 10 + 10 + 100 = 120
      // Module 1 target: (10000 * 120) / 10000 = 120, cap = min(120, 640) = 120
      // Module 2 target: (2000 * 120) / 10000 = 24, cap = min(24, 640) = 24
      // MinFirst: [10,10] caps [120,24]
      //   fill both to 24: cost 28, remaining 72
      //   module 2 at cap, module 1 gets min(72, 96) = 72
      //   result: [96, 24], total allocated = 100
      const ethToDeposit = 100n * DEFAULT_MEB;
      const module1Delta = 86n * DEFAULT_MEB;
      const module2Delta = 14n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, true);
      expect(result.totalAllocated).to.equal(module1Delta + module2Delta);
      expect(result.newAllocations).to.deep.equal([96n * DEFAULT_MEB, 24n * DEFAULT_MEB]);
      expect(result.allocated).to.deep.equal([module1Delta, module2Delta]);
    });

    it("Unlimited module absorbs excess when 20% module has fewer active validators for top-up", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 100_00n,
        priorityExitShareThreshold: 100_00n,
        deposited: 10n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: 10n * 32n * GWEI,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 20_00n,
        priorityExitShareThreshold: 20_00n,
        deposited: 1n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        validatorsBalanceGwei: 1n * 32n * GWEI,
      };

      await setupModule(module1Config);
      await setupModule(module2Config);

      // Module 1: cap_raw = 10 * 64 = 640, current = 10
      // Module 2: cap_raw = 1 * 64 = 64, current = 1
      // totalValidators = 10 + 1 + 600 = 611
      // Module 1 target: (10000 * 611) / 10000 = 611, cap = min(611, 640) = 611
      // Module 2 target: (2000 * 611) / 10000 = 122, cap = min(122, 64) = 64
      const ethToDeposit = 600n * DEFAULT_MEB;
      const module1Delta = 537n * DEFAULT_MEB;
      const module2Delta = 63n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, true);
      expect(result.totalAllocated).to.equal(module1Delta + module2Delta);
      expect(result.newAllocations).to.deep.equal([547n * DEFAULT_MEB, 64n * DEFAULT_MEB]);
      expect(result.allocated).to.deep.equal([module1Delta, module2Delta]);
    });

    it("Returns zero allocated array when deposit amount is zero", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 50n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      };

      await setupModule(config);

      const result = await stakingRouter.getDepositAllocations(0n, true);
      expect(result.totalAllocated).to.equal(0n);
      expect(result.allocated).to.deep.equal([0n]);
    });
  });

  context("multi-module top-up scenarios", () => {
    // Module balances from SR accounting (wei)
    const MODULE_1_BALANCE_GWEI = 960_006_155_190_000_000_000n / GWEI; // ~960.006 ETH ~ 31 validators
    const MODULE_2_BALANCE_GWEI = 0n;
    const MODULE_3_BALANCE_GWEI = 1_600_010_258_650_000_000_000n / GWEI; // ~1600.01 ETH ~ 51 validators
    const MODULE_4_BALANCE_GWEI = 1_988_080_734_502_000_000_000n / GWEI; // ~1988.08 ETH ~ 63 validators
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
      await setupModule({
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
      await setupModule({
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
      await setupModule({
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
      await setupModule({
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
      });
    }

    it("Returns zero new allocation when 0x01 modules have no depositable keys and 0x02 module is at share limit", async () => {
      await setupModules();

      // allocations - is array containing new allocation per module + already allocated amount of Eth
      // allocated - is a total new sum of deposits
      // this test expect 0 new allocated Eth
      const result = await stakingRouter.getDepositAllocations(BUFFER, true);
      expect(result.totalAllocated).to.equal(0n, "totalAllocated should be 0 — no capacity in any modules");

      // newAllocations array returns per-module new total allocations (including existing),
      // verify it has an entry per module
      expect(result.newAllocations.length).to.equal(4);

      // newAllocations[i] = ceilDiv(moduleBalance, 32 ETH) * 32 ETH
      const ETH32 = 32n * 10n ** 18n;
      const toValidatorETH = (balance: bigint) => ((balance + ETH32 - 1n) / ETH32) * ETH32;

      const moduleBalance1 = await stakingRouter.getModuleValidatorsBalance(1);
      expect(result.newAllocations[0]).to.equal(toValidatorETH(moduleBalance1));

      const moduleBalance2 = await stakingRouter.getModuleValidatorsBalance(2);
      expect(result.newAllocations[1]).to.equal(toValidatorETH(moduleBalance2));

      const moduleBalance3 = await stakingRouter.getModuleValidatorsBalance(3);
      expect(result.newAllocations[2]).to.equal(toValidatorETH(moduleBalance3));

      const moduleBalance4 = await stakingRouter.getModuleValidatorsBalance(4);
      expect(result.newAllocations[3]).to.equal(toValidatorETH(moduleBalance4));

      // all allocated deltas should be 0
      for (const a of result.allocated) {
        expect(a).to.equal(0n);
      }
    });

    it("Allocates to 0x02 module when buffer is large enough to push target above current allocation", async () => {
      await setupModules();

      // to make some top up in 4 module -> it should have 64 validators
      // 64 * 32 = X * 32 * 20/100 -> X = 320 validators in total
      // already have 145 validators
      // need 175 validators = 320 - 145
      // 560 eth - minimum buffer

      const INCREASED_BUFFER = 5600n * 10n ** 18n;

      // Snapshot current state for comparison
      const resultBefore = await stakingRouter.getDepositAllocations(BUFFER, true);
      expect(resultBefore.totalAllocated).to.equal(0n, "sanity check: original buffer gives 0");

      const result = await stakingRouter.getDepositAllocations(INCREASED_BUFFER, true);

      // Module 4 (0x02) now has capacity — new ETH is allocated
      expect(result.totalAllocated).to.be.gt(32n, "totalAllocated should be > 0 with larger buffer");

      // Modules 1-3 didn't change (0x01, no depositable keys — capacity == current)
      expect(result.newAllocations[0]).to.equal(resultBefore.newAllocations[0], "module 1 unchanged");
      expect(result.newAllocations[1]).to.equal(resultBefore.newAllocations[1], "module 2 unchanged");
      expect(result.newAllocations[2]).to.equal(resultBefore.newAllocations[2], "module 3 unchanged");

      // Module 4 grew
      expect(result.newAllocations[3]).to.be.gt(resultBefore.newAllocations[3], "module 4 allocation increased");

      // Delta for module 4 = newAllocation - currentAllocation = totalAllocated (since only module 4 grew)
      const module4Delta = result.newAllocations[3] - resultBefore.newAllocations[3];
      expect(module4Delta).to.equal(result.totalAllocated, "all new allocation went to module 4");

      // Verify allocated array reflects the same delta
      expect(result.allocated[0]).to.equal(0n, "module 1 delta is 0");
      expect(result.allocated[1]).to.equal(0n, "module 2 delta is 0");
      expect(result.allocated[2]).to.equal(0n, "module 3 delta is 0");
      expect(result.allocated[3]).to.equal(module4Delta, "module 4 delta matches");
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

      await setupModule(config);
      await setupModule(config);

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

      await setupModule(module1Config);
      await setupModule(module2Config);

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

      await setupModule(config);

      const ethToDeposit = 50n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);

      // allocated[0] is the delta (new allocation)
      // newAllocations[0] includes existing validators + new
      expect(result.allocated[0]).to.equal(result.totalAllocated);
      expect(result.newAllocations[0]).to.be.equal(150n * DEFAULT_MEB); // 100 existing + 50 new = 150 total allocation after deposit
    });

    it("Returns per-module deltas that sum to totalAllocated for top-up", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 50n,
      };

      await setupModule(config);
      await setupModule(config);

      const ethToDeposit = 200n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, true);

      let allocatedSum = 0n;
      for (const a of result.allocated) {
        allocatedSum += a;
      }
      expect(allocatedSum).to.equal(result.totalAllocated);
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
    validatorsBalanceGwei = 0n,
  }: ModuleConfig): Promise<[StakingModule__MockForStakingRouter | StakingModuleV2__MockForStakingRouter, bigint]> {
    const modulesCount = await stakingRouter.getStakingModulesCount();

    const isV2 = withdrawalCredentialsType === WithdrawalCredentialsType.WC0x02;
    const module = isV2
      ? await ethers.deployContract("StakingModuleV2__MockForStakingRouter", deployer)
      : await ethers.deployContract("StakingModule__MockForStakingRouter", deployer);

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
    if (validatorsBalanceGwei == 0n && deposited > 0n) {
      validatorsBalanceGwei = (deposited * wcTypeMaxEB(withdrawalCredentialsType)) / GWEI;
    }
    await stakingRouter.testing_setStakingModuleAccounting(moduleId, validatorsBalanceGwei, exited);

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
  validatorsBalanceGwei?: bigint;
}
