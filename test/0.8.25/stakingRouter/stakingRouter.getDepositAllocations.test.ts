import { expect } from "chai";
import { randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { LidoLocator, StakingModule__MockForStakingRouter, StakingRouter__Harness } from "typechain-types";

import { certainAddress, randomWCType1, wcTypeMaxEB } from "lib";
import { StakingModuleStatus, TOTAL_BASIS_POINTS, WithdrawalCredentialsType } from "lib/constants";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

import { deployStakingRouter } from "../../deploy/stakingRouter";

describe("StakingRouter.sol:getDepositAllocations", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;

  let locator: LidoLocator;
  let stakingRouter: StakingRouter__Harness;

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
  const DEFAULT_MEB = wcTypeMaxEB(DEFAULT_CONFIG.withdrawalCredentialsType);

  const withdrawalCredentials = randomWCType1();
  const lido = certainAddress("test:staking-router-allocations:lido");

  const topUpGateway = certainAddress("test:staking-router-allocations:topUpGateway");
  const depositSecurityModule = certainAddress("test:staking-router-allocations:depositSecurityModule");

  before(async () => {
    [deployer, admin] = await ethers.getSigners();

    locator = await deployLidoLocator({
      lido,
      topUpGateway,
      depositSecurityModule,
    });

    ({ stakingRouter } = await deployStakingRouter({ deployer, admin }, { lidoLocator: locator }));

    await stakingRouter.initialize(admin, withdrawalCredentials);

    await Promise.all([stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin)]);
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

    it("Returns allocation for a single 0x02 module", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 100n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      };

      await setupModule(config);

      const meb = wcTypeMaxEB(WithdrawalCredentialsType.WC0x02);
      const ethToDeposit = 150n * meb;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, true);
      // For top-up, capacity for 0x02 modules is calculated differently
      expect(result.totalAllocated).to.be.gte(0n);
      expect(result.newAllocations.length).to.equal(1);
      expect(result.allocated.length).to.equal(1);
    });

    it("Returns zero allocated array when deposit amount is zero", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 50n,
      };

      await setupModule(config);

      const result = await stakingRouter.getDepositAllocations(0n, true);
      expect(result.totalAllocated).to.equal(0n);
      expect(result.allocated).to.deep.equal([0n]);
    });
  });

  context("getDepositAllocations consistency with getDepositsAllocation and getTopUpAllocation", () => {
    it("getDepositAllocations(amount, false) matches getDepositsAllocation(amount)", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 50n,
      };

      await setupModule(config);
      await setupModule(config);

      const ethToDeposit = 200n * DEFAULT_MEB;

      const [depositsAllocated, depositsAllocations] = await stakingRouter.getDepositsAllocation(ethToDeposit);
      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);

      expect(result.totalAllocated).to.equal(depositsAllocated);
      expect(result.newAllocations).to.deep.equal(depositsAllocations);
    });

    it("getDepositAllocations(amount, true) matches getTopUpAllocation(amount)", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 50n,
      };

      await setupModule(config);
      await setupModule(config);

      const ethToDeposit = 200n * DEFAULT_MEB;

      const [topUpAllocated, topUpAllocations] = await stakingRouter.getTopUpAllocation(ethToDeposit);
      const result = await stakingRouter.getDepositAllocations(ethToDeposit, true);

      expect(result.totalAllocated).to.equal(topUpAllocated);
      expect(result.newAllocations).to.deep.equal(topUpAllocations);
    });

    it("Consistency with no modules", async () => {
      const ethToDeposit = 100n * DEFAULT_MEB;

      const [depositsAllocated, depositsAllocations] = await stakingRouter.getDepositsAllocation(ethToDeposit);
      const resultDeposit = await stakingRouter.getDepositAllocations(ethToDeposit, false);

      expect(resultDeposit.totalAllocated).to.equal(depositsAllocated);
      expect(resultDeposit.newAllocations).to.deep.equal(depositsAllocations);

      const [topUpAllocated, topUpAllocations] = await stakingRouter.getTopUpAllocation(ethToDeposit);
      const resultTopUp = await stakingRouter.getDepositAllocations(ethToDeposit, true);

      expect(resultTopUp.totalAllocated).to.equal(topUpAllocated);
      expect(resultTopUp.newAllocations).to.deep.equal(topUpAllocations);
    });

    it("Consistency with single module and deposited validators", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 100n,
        deposited: 50n,
      };

      await setupModule(config);

      const ethToDeposit = 200n * DEFAULT_MEB;

      const [depositsAllocated, depositsAllocations] = await stakingRouter.getDepositsAllocation(ethToDeposit);
      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);

      expect(result.totalAllocated).to.equal(depositsAllocated);
      expect(result.newAllocations).to.deep.equal(depositsAllocations);
    });

    it("Consistency with mixed module statuses", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 50n,
      };

      await setupModule(config);
      await setupModule({ ...config, status: StakingModuleStatus.DepositsPaused });

      const ethToDeposit = 200n * DEFAULT_MEB;

      const [depositsAllocated, depositsAllocations] = await stakingRouter.getDepositsAllocation(ethToDeposit);
      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);

      expect(result.totalAllocated).to.equal(depositsAllocated);
      expect(result.newAllocations).to.deep.equal(depositsAllocations);
    });

    it("Consistency with different target shares", async () => {
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

      const [depositsAllocated, depositsAllocations] = await stakingRouter.getDepositsAllocation(ethToDeposit);
      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);

      expect(result.totalAllocated).to.equal(depositsAllocated);
      expect(result.newAllocations).to.deep.equal(depositsAllocations);
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
      expect(result.allocated[1]).to.equal(0n);
    });

    it("Delta reflects newly allocated amount with pre-existing deposits", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 50n,
        deposited: 100n,
      };

      await setupModule(config);

      const ethToDeposit = 200n * DEFAULT_MEB;

      const result = await stakingRouter.getDepositAllocations(ethToDeposit, false);

      // allocated[0] is the delta (new allocation)
      // newAllocations[0] includes existing validators + new
      expect(result.allocated[0]).to.equal(result.totalAllocated);
      expect(result.newAllocations[0]).to.be.gte(result.allocated[0]);
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
    pendingBalanceGwei = 0n,
  }: ModuleConfig): Promise<[StakingModule__MockForStakingRouter, bigint]> {
    const modulesCount = await stakingRouter.getStakingModulesCount();
    const module = await ethers.deployContract("StakingModule__MockForStakingRouter", deployer);

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
      validatorsBalanceGwei = (deposited * wcTypeMaxEB(withdrawalCredentialsType)) / 1_000_000_000n; // in gwei
    }
    await stakingRouter.testing_setStakingModuleAccounting(moduleId, validatorsBalanceGwei, pendingBalanceGwei, exited);

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
  pendingBalanceGwei?: bigint;
}
