import { expect } from "chai";
import { randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracle__MockForStakingRouter,
  Lido__MockForStakingRouter,
  LidoLocator,
  StakingModuleV2__MockForStakingRouter,
  StakingRouter__Harness,
} from "typechain-types";

import { randomWCType1, wcTypeMaxEB } from "lib";
import { StakingModuleStatus, TOTAL_BASIS_POINTS, WithdrawalCredentialsType } from "lib/constants";

import { deployLidoLocator, deployStakingRouter } from "test/deploy";
import { Snapshot } from "test/suite";

describe("StakingRouter.sol:getTopUpAllocation", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let topUpGatewaySigner: HardhatEthersSigner;

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

  const withdrawalCredentials = randomWCType1();
  const depositSecurityModule = "0x0000000000000000000000000000000000000002";

  before(async () => {
    [deployer, admin, topUpGatewaySigner] = await ethers.getSigners();

    lidoMock = await ethers.deployContract("Lido__MockForStakingRouter", deployer);
    accountingOracle = await ethers.deployContract("AccountingOracle__MockForStakingRouter", deployer);

    locator = await deployLidoLocator({
      lido: await lidoMock.getAddress(),
      topUpGateway: await topUpGatewaySigner.getAddress(),
      depositSecurityModule,
      accountingOracle: await accountingOracle.getAddress(),
    });

    ({ stakingRouter } = await deployStakingRouter({ deployer, admin }, { lidoLocator: locator, lido: lidoMock }));

    await lidoMock.setStakingRouter(await stakingRouter.getAddress());
    await stakingRouter.initialize(admin, withdrawalCredentials);
    await stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  context("getTopUpAllocation", () => {
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
        priorityExitShareThreshold: shares.get(4)!.priorityExitShareThreshold, //module4ShareLimit < 25_00n ? 25_00n : module4ShareLimit,
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
      const { allocated, allocations } = await stakingRouter.getTopUpAllocation(BUFFER);
      expect(allocated).to.equal(0n, "totalAllocated should be 0 — no capacity in any modules");

      // allocations array returns per-module new total allocations (including existing),
      // verify it has an entry per module
      expect(allocations.length).to.equal(4);

      // allocations[i] = ceilDiv(moduleBalance, 32 ETH) * 32 ETH
      const ETH32 = 32n * 10n ** 18n;
      const toValidatorETH = (balance: bigint) => ((balance + ETH32 - 1n) / ETH32) * ETH32;

      const moduleBalance1 = await stakingRouter.getStakingModuleBalance(1);
      expect(allocations[0]).to.equal(toValidatorETH(moduleBalance1));

      const moduleBalance2 = await stakingRouter.getStakingModuleBalance(2);
      expect(allocations[1]).to.equal(toValidatorETH(moduleBalance2));

      const moduleBalance3 = await stakingRouter.getStakingModuleBalance(3);
      expect(allocations[2]).to.equal(toValidatorETH(moduleBalance3));

      const moduleBalance4 = await stakingRouter.getStakingModuleBalance(4);
      expect(allocations[3]).to.equal(toValidatorETH(moduleBalance4));
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
      const allocBefore = await stakingRouter.getTopUpAllocation(BUFFER);
      expect(allocBefore.allocated).to.equal(0n, "sanity check: original buffer gives 0");

      const { allocated, allocations } = await stakingRouter.getTopUpAllocation(INCREASED_BUFFER);

      // Module 4 (0x02) now has capacity — new ETH is allocated
      expect(allocated).to.be.gt(32n, "totalAllocated should be > 0 with larger buffer");

      // Modules 1-3 didn't change (0x01, no depositable keys — capacity == current)
      expect(allocations[0]).to.equal(allocBefore.allocations[0], "module 1 unchanged");
      expect(allocations[1]).to.equal(allocBefore.allocations[1], "module 2 unchanged");
      expect(allocations[2]).to.equal(allocBefore.allocations[2], "module 3 unchanged");

      // Module 4 grew
      expect(allocations[3]).to.be.gt(allocBefore.allocations[3], "module 4 allocation increased");

      // Delta for module 4 = newAllocation - currentAllocation = allocated (since only module 4 grew)
      const module4Delta = allocations[3] - allocBefore.allocations[3];
      expect(module4Delta).to.equal(allocated, "all new allocation went to module 4");
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
    if (validatorsBalanceGwei == 0n && deposited > 0n) {
      validatorsBalanceGwei = (deposited * wcTypeMaxEB(withdrawalCredentialsType)) / GWEI;
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
  withdrawalCredentialsType?: WithdrawalCredentialsType;
  exited?: bigint;
  deposited?: bigint;
  depositable?: bigint;
  status?: StakingModuleStatus;
  validatorsBalanceGwei?: bigint;
  pendingBalanceGwei?: bigint;
}
