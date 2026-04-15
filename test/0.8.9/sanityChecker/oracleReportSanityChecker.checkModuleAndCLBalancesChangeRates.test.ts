import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForSanityChecker,
  Burner__MockForSanityChecker,
  LidoLocator__MockForSanityChecker,
  OracleReportSanityCheckerWrapper,
  StakingModule__MockForStakingRouter,
  StakingRouter__Harness,
  StakingRouter__MockForAccountingOracle,
  WithdrawalQueue__MockForSanityChecker,
} from "typechain-types";

import { ether, impersonate, ONE_GWEI, randomWCType1, WithdrawalCredentialsType } from "lib";

import { deployStakingRouter } from "test/deploy";
import { Snapshot } from "test/suite";

const ONE_DAY = 24n * 60n * 60n;

describe("OracleReportSanityChecker.sol:checkModuleAndCLBalancesChangeRates", () => {
  type ModuleBalance = {
    id: bigint;
    validatorsBalanceWei: bigint;
    pendingWei?: bigint;
  };

  const limits = {
    exitedEthAmountPerDayLimit: 100n,
    appearedEthAmountPerDayLimit: 100n,
    annualBalanceIncreaseBPLimit: 1_000n,
    simulatedShareRateDeviationBPLimit: 250n,
    maxBalanceExitRequestedPerReportInEth: 65_000n,
    maxEffectiveBalanceWeightWCType01: 32n,
    maxEffectiveBalanceWeightWCType02: 2_048n,
    maxItemsPerExtraDataTransaction: 15n,
    maxNodeOperatorsPerExtraDataItem: 16n,
    requestTimestampMargin: 128n,
    maxPositiveTokenRebase: 5_000_000n,
    maxCLBalanceDecreaseBP: 360n,
    clBalanceOraclesErrorUpperBPLimit: 50n,
    consolidationEthAmountPerDayLimit: 10n,
    exitedValidatorEthAmountLimit: 1n,
  };

  let checker: OracleReportSanityCheckerWrapper;
  let locator: LidoLocator__MockForSanityChecker;
  let burner: Burner__MockForSanityChecker;
  let accounting: Accounting__MockForSanityChecker;
  let withdrawalQueue: WithdrawalQueue__MockForSanityChecker;
  let stakingRouter: StakingRouter__MockForAccountingOracle;
  let accountingOracle: AccountingOracle__MockForSanityChecker;

  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let elRewardsVault: HardhatEthersSigner;

  let originalState: string;

  const toGwei = (weiAmount: bigint) => weiAmount / ONE_GWEI;

  const toModuleInput = (modules: ModuleBalance[]) => {
    const ids = modules.map((m) => m.id);
    const validatorBalancesGweiByStakingModule = modules.map((m) => toGwei(m.validatorsBalanceWei));

    return {
      ids,
      validatorBalancesGweiByStakingModule,
    };
  };

  const seedPreviousBalances = async (modules: ModuleBalance[]) => {
    const input = toModuleInput(modules);
    for (const id of input.ids) {
      await stakingRouter.mock__registerStakingModule(id);
    }
    // Router state seeds validators balance only; pending budget is passed to the checker explicitly.
    await stakingRouter.reportValidatorBalancesByStakingModule(input.ids, input.validatorBalancesGweiByStakingModule);
  };

  const check = async (
    modules: ModuleBalance[],
    {
      preCLPendingBalanceWei = 0n,
      // Module fixtures carry only post-report pending; router state itself no longer stores module pending.
      postCLPendingBalanceWei = modules.reduce((sum, m) => sum + (m.pendingWei ?? 0n), 0n),
      depositsWei = 0n,
      timeElapsed = ONE_DAY,
    }: {
      preCLPendingBalanceWei?: bigint;
      postCLPendingBalanceWei?: bigint;
      depositsWei?: bigint;
      timeElapsed?: bigint;
    } = {},
  ) => {
    const ids = modules.map((m) => m.id);
    const validatorBalancesWeiByStakingModule = modules.map((m) => m.validatorsBalanceWei);
    const postCLValidatorsBalanceWei = validatorBalancesWeiByStakingModule.reduce((sum, val) => sum + val, 0n);
    const previousModuleStates = await Promise.all(ids.map((id) => stakingRouter.getStakingModuleStateAccounting(id)));
    const preCLValidatorsBalanceWei = previousModuleStates.reduce(
      (sum, [validatorsBalanceGwei]) => sum + validatorsBalanceGwei * ONE_GWEI,
      0n,
    );
    return checker.checkModuleAndCLBalancesChangeRates(
      ids,
      validatorBalancesWeiByStakingModule,
      preCLValidatorsBalanceWei,
      preCLPendingBalanceWei,
      postCLValidatorsBalanceWei,
      postCLPendingBalanceWei,
      depositsWei,
      timeElapsed,
    );
  };

  const deployCheckerWithRouterModules = async (modulesCount = 1, postMigrationFirstReportDone = true) => {
    const routerHarness = (await deployStakingRouter({ deployer, admin }, {})) as {
      stakingRouter: StakingRouter__Harness;
    };
    const moduleIds: bigint[] = [];

    await routerHarness.stakingRouter.connect(admin).initialize(admin.address, randomWCType1());
    await routerHarness.stakingRouter
      .connect(admin)
      .grantRole(await routerHarness.stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin.address);
    await routerHarness.stakingRouter
      .connect(admin)
      .grantRole(await routerHarness.stakingRouter.REPORT_EXITED_VALIDATORS_ROLE(), admin.address);
    for (let i = 0; i < modulesCount; i++) {
      const module = (await ethers.deployContract(
        "StakingModule__MockForStakingRouter",
        deployer,
      )) as StakingModule__MockForStakingRouter;

      await routerHarness.stakingRouter
        .connect(admin)
        .addStakingModule(`new module ${i + 1}`, await module.getAddress(), {
          stakeShareLimit: 10_000n,
          priorityExitShareThreshold: 10_000n,
          stakingModuleFee: 500n,
          treasuryFee: 500n,
          maxDepositsPerBlock: 150n,
          minDepositBlockDistance: 25n,
          withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
        });

      moduleIds.push(BigInt(i + 1));
    }

    const locatorWithRouter = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
      {
        lido: deployer.address,
        depositSecurityModule: deployer.address,
        elRewardsVault: elRewardsVault.address,
        accountingOracle: await accountingOracle.getAddress(),
        oracleReportSanityChecker: deployer.address,
        burner: await burner.getAddress(),
        validatorsExitBusOracle: deployer.address,
        stakingRouter: await routerHarness.stakingRouter.getAddress(),
        treasury: deployer.address,
        withdrawalQueue: await withdrawalQueue.getAddress(),
        withdrawalVault: deployer.address,
        postTokenRebaseReceiver: deployer.address,
        oracleDaemonConfig: deployer.address,
        validatorExitDelayVerifier: deployer.address,
        triggerableWithdrawalsGateway: deployer.address,
        consolidationGateway: deployer.address,
        accounting: await accounting.getAddress(),
        predepositGuarantee: deployer.address,
        wstETH: deployer.address,
        vaultHub: deployer.address,
        vaultFactory: deployer.address,
        lazyOracle: deployer.address,
        operatorGrid: deployer.address,
        topUpGateway: deployer.address,
      },
    ]);

    const checkerWithRouter = await ethers.deployContract("OracleReportSanityCheckerWrapper", [
      await locatorWithRouter.getAddress(),
      await accounting.getAddress(),
      admin.address,
      limits,
      postMigrationFirstReportDone,
    ]);

    return {
      checkerWithRouter,
      stakingRouterHarness: routerHarness.stakingRouter,
      moduleIds,
    };
  };

  const checkGlobalReport = (
    sanityChecker: OracleReportSanityCheckerWrapper,
    accountingSigner: HardhatEthersSigner,
    {
      timeElapsed = ONE_DAY,
      preValidatorsWei = 0n,
      prePendingWei = 0n,
      postValidatorsWei = 0n,
      postPendingWei = 0n,
      withdrawalVaultBalanceWei = 0n,
      elRewardsVaultBalanceWei = 0n,
      sharesRequestedToBurn = 0n,
      depositsWei = 0n,
      withdrawalsVaultTransferWei = 0n,
    }: {
      timeElapsed?: bigint;
      preValidatorsWei?: bigint;
      prePendingWei?: bigint;
      postValidatorsWei?: bigint;
      postPendingWei?: bigint;
      withdrawalVaultBalanceWei?: bigint;
      elRewardsVaultBalanceWei?: bigint;
      sharesRequestedToBurn?: bigint;
      depositsWei?: bigint;
      withdrawalsVaultTransferWei?: bigint;
    },
  ) =>
    sanityChecker
      .connect(accountingSigner)
      .checkAccountingOracleReport(
        timeElapsed,
        preValidatorsWei,
        prePendingWei,
        postValidatorsWei,
        postPendingWei,
        withdrawalVaultBalanceWei,
        elRewardsVaultBalanceWei,
        sharesRequestedToBurn,
        depositsWei,
        withdrawalsVaultTransferWei,
      );

  before(async () => {
    [deployer, admin, manager, elRewardsVault] = await ethers.getSigners();

    withdrawalQueue = await ethers.deployContract("WithdrawalQueue__MockForSanityChecker");
    burner = await ethers.deployContract("Burner__MockForSanityChecker");
    accounting = await ethers.deployContract("Accounting__MockForSanityChecker");
    stakingRouter = await ethers.deployContract("StakingRouter__MockForAccountingOracle");

    accountingOracle = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
      deployer.address,
      12,
      1_606_824_023,
    ]);

    locator = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
      {
        lido: deployer.address,
        depositSecurityModule: deployer.address,
        elRewardsVault: elRewardsVault.address,
        accountingOracle: await accountingOracle.getAddress(),
        oracleReportSanityChecker: deployer.address,
        burner: await burner.getAddress(),
        validatorsExitBusOracle: deployer.address,
        stakingRouter: await stakingRouter.getAddress(),
        treasury: deployer.address,
        withdrawalQueue: await withdrawalQueue.getAddress(),
        withdrawalVault: deployer.address,
        postTokenRebaseReceiver: deployer.address,
        oracleDaemonConfig: deployer.address,
        validatorExitDelayVerifier: deployer.address,
        triggerableWithdrawalsGateway: deployer.address,
        consolidationGateway: deployer.address,
        accounting: await accounting.getAddress(),
        predepositGuarantee: deployer.address,
        wstETH: deployer.address,
        vaultHub: deployer.address,
        vaultFactory: deployer.address,
        lazyOracle: deployer.address,
        operatorGrid: deployer.address,
        topUpGateway: deployer.address,
      },
    ]);

    checker = await ethers.deployContract("OracleReportSanityCheckerWrapper", [
      await locator.getAddress(),
      await accounting.getAddress(),
      admin.address,
      limits,
      true,
    ]);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  it("passes for empty module arrays and zero totals", async () => {
    await expect(checker.checkModuleAndCLBalancesChangeRates([], [], 0n, 0n, 0n, 0n, 0n, ONE_DAY)).not.to.be.reverted;
  });

  it("skips module-specific checks for the first report of a newly added module", async () => {
    const { checkerWithRouter, moduleIds } = await deployCheckerWithRouterModules();
    const [moduleId] = moduleIds;
    const firstReportTotalBalanceWei = ether("120");

    await expect(
      checkerWithRouter.checkModuleAndCLBalancesChangeRates(
        [moduleId],
        [firstReportTotalBalanceWei],
        firstReportTotalBalanceWei,
        0n,
        firstReportTotalBalanceWei,
        0n,
        0n,
        ONE_DAY,
      ),
    ).not.to.be.reverted;
  });

  it("skips the module validators balance increase check on the first post-migration report and applies it on the second", async () => {
    const { checkerWithRouter, stakingRouterHarness, moduleIds } = await deployCheckerWithRouterModules(1, false);
    const [moduleId] = moduleIds;
    const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
    const previousValidatorsBalanceWei = ether("40150");
    const prePendingBalanceWei = ether("120");
    const excessiveValidatorsGrowthWei = ether("112");
    const postValidatorsBalanceWei = previousValidatorsBalanceWei + excessiveValidatorsGrowthWei;
    const postPendingBalanceWei = ether("20");
    const activatedBalanceWei = prePendingBalanceWei - postPendingBalanceWei;
    const expectedValidatorsGrowthLimitWei =
      activatedBalanceWei +
      ((previousValidatorsBalanceWei + activatedBalanceWei) * limits.annualBalanceIncreaseBPLimit) / (365n * 10_000n);

    const problematicModuleReport = () =>
      checkerWithRouter.checkModuleAndCLBalancesChangeRates(
        [moduleId],
        [postValidatorsBalanceWei],
        previousValidatorsBalanceWei,
        prePendingBalanceWei,
        postValidatorsBalanceWei,
        postPendingBalanceWei,
        0n,
        ONE_DAY,
      );

    await stakingRouterHarness
      .connect(admin)
      .reportValidatorBalancesByStakingModule([moduleId], [previousValidatorsBalanceWei / ONE_GWEI]);

    await expect(problematicModuleReport()).not.to.be.reverted;

    await expect(
      checkGlobalReport(checkerWithRouter, accountingSigner, {
        preValidatorsWei: previousValidatorsBalanceWei,
        prePendingWei: prePendingBalanceWei,
        postValidatorsWei: previousValidatorsBalanceWei,
        postPendingWei: prePendingBalanceWei,
      }),
    ).not.to.be.reverted;

    await expect(problematicModuleReport())
      .to.be.revertedWithCustomError(checkerWithRouter, "IncorrectTotalCLBalanceIncrease")
      .withArgs(expectedValidatorsGrowthLimitWei, excessiveValidatorsGrowthWei);
  });

  it("supports cold-start onboarding across the global path and module bootstrap flow", async () => {
    const { checkerWithRouter, stakingRouterHarness, moduleIds } = await deployCheckerWithRouterModules();
    const [moduleId] = moduleIds;
    const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
    const depositedWei = ether("200");
    const activatedValidatorsWei = ether("100");
    const remainingPendingWei = depositedWei - activatedValidatorsWei;
    await expect(
      checkGlobalReport(checkerWithRouter, accountingSigner, {
        postPendingWei: depositedWei,
        depositsWei: depositedWei,
      }),
    ).not.to.be.reverted;

    await expect(
      checkerWithRouter.checkModuleAndCLBalancesChangeRates(
        [moduleId],
        [0n],
        0n,
        0n,
        0n,
        depositedWei,
        depositedWei,
        ONE_DAY,
      ),
    ).not.to.be.reverted;

    await stakingRouterHarness.connect(admin).reportValidatorBalancesByStakingModule([moduleId], [0n]);

    await expect(
      checkGlobalReport(checkerWithRouter, accountingSigner, {
        prePendingWei: depositedWei,
        postValidatorsWei: activatedValidatorsWei,
        postPendingWei: remainingPendingWei,
      }),
    ).not.to.be.reverted;

    await expect(
      checkerWithRouter.checkModuleAndCLBalancesChangeRates(
        [moduleId],
        [activatedValidatorsWei],
        0n,
        depositedWei,
        activatedValidatorsWei,
        remainingPendingWei,
        0n,
        ONE_DAY,
      ),
    ).not.to.be.reverted;
  });

  it("supports cold-start onboarding across multiple new modules", async () => {
    const { checkerWithRouter, stakingRouterHarness, moduleIds } = await deployCheckerWithRouterModules(2);
    const [moduleOneId, moduleTwoId] = moduleIds;
    const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
    const moduleOneInitialPendingWei = ether("120");
    const moduleTwoInitialPendingWei = ether("80");
    const totalInitialPendingWei = moduleOneInitialPendingWei + moduleTwoInitialPendingWei;
    const moduleOneActivatedValidatorsWei = ether("60");
    const moduleTwoActivatedValidatorsWei = ether("40");
    const moduleOneRemainingPendingWei = moduleOneInitialPendingWei - moduleOneActivatedValidatorsWei;
    const moduleTwoRemainingPendingWei = moduleTwoInitialPendingWei - moduleTwoActivatedValidatorsWei;
    const totalActivatedValidatorsWei = moduleOneActivatedValidatorsWei + moduleTwoActivatedValidatorsWei;
    const totalRemainingPendingWei = moduleOneRemainingPendingWei + moduleTwoRemainingPendingWei;

    await expect(
      checkGlobalReport(checkerWithRouter, accountingSigner, {
        postPendingWei: totalInitialPendingWei,
        depositsWei: totalInitialPendingWei,
      }),
    ).not.to.be.reverted;

    await expect(
      checkerWithRouter.checkModuleAndCLBalancesChangeRates(
        [moduleOneId, moduleTwoId],
        [0n, 0n],
        0n,
        0n,
        0n,
        totalInitialPendingWei,
        totalInitialPendingWei,
        ONE_DAY,
      ),
    ).not.to.be.reverted;

    await stakingRouterHarness
      .connect(admin)
      .reportValidatorBalancesByStakingModule([moduleOneId, moduleTwoId], [0n, 0n]);

    await expect(
      checkGlobalReport(checkerWithRouter, accountingSigner, {
        prePendingWei: totalInitialPendingWei,
        postValidatorsWei: totalActivatedValidatorsWei,
        postPendingWei: totalRemainingPendingWei,
      }),
    ).not.to.be.reverted;

    await expect(
      checkerWithRouter.checkModuleAndCLBalancesChangeRates(
        [moduleOneId, moduleTwoId],
        [moduleOneActivatedValidatorsWei, moduleTwoActivatedValidatorsWei],
        0n,
        totalInitialPendingWei,
        totalActivatedValidatorsWei,
        totalRemainingPendingWei,
        0n,
        ONE_DAY,
      ),
    ).not.to.be.reverted;
  });

  it("supports cold-start onboarding with timeElapsed = 0 under allowance and rate-normalization fallbacks", async () => {
    const { checkerWithRouter, stakingRouterHarness, moduleIds } = await deployCheckerWithRouterModules();
    const [moduleId] = moduleIds;
    const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
    const zeroTimeElapsed = 0n;
    const initialPendingWei = ether("10");
    const expectedModulePerDayLimitWei =
      (limits.appearedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");
    const maxModuleActivationGwei = expectedModulePerDayLimitWei / ONE_DAY / ONE_GWEI;
    const maxModuleActivationWei = maxModuleActivationGwei * ONE_GWEI;
    const remainingPendingWei = initialPendingWei - maxModuleActivationWei;

    await expect(
      checkGlobalReport(checkerWithRouter, accountingSigner, {
        timeElapsed: zeroTimeElapsed,
        postPendingWei: initialPendingWei,
        depositsWei: initialPendingWei,
      }),
    ).not.to.be.reverted;

    await expect(
      checkerWithRouter.checkModuleAndCLBalancesChangeRates(
        [moduleId],
        [0n],
        0n,
        0n,
        0n,
        initialPendingWei,
        initialPendingWei,
        zeroTimeElapsed,
      ),
    ).not.to.be.reverted;

    await stakingRouterHarness.connect(admin).reportValidatorBalancesByStakingModule([moduleId], [0n]);

    await expect(
      checkGlobalReport(checkerWithRouter, accountingSigner, {
        timeElapsed: zeroTimeElapsed,
        prePendingWei: initialPendingWei,
        postValidatorsWei: maxModuleActivationWei,
        postPendingWei: remainingPendingWei,
      }),
    ).not.to.be.reverted;

    await expect(
      checkerWithRouter.checkModuleAndCLBalancesChangeRates(
        [moduleId],
        [maxModuleActivationWei],
        0n,
        initialPendingWei,
        maxModuleActivationWei,
        remainingPendingWei,
        0n,
        zeroTimeElapsed,
      ),
    ).not.to.be.reverted;
  });

  it("reverts with InvalidClBalancesData on array length mismatch", async () => {
    await expect(
      checker.checkModuleAndCLBalancesChangeRates([1n], [], 0n, 0n, 1n, 0n, 0n, ONE_DAY),
    ).to.be.revertedWithCustomError(checker, "InvalidClBalancesData");
  });

  it("reverts with InconsistentValidatorsBalanceByModule when validators balance sum mismatches", async () => {
    await expect(checker.checkModuleAndCLBalancesChangeRates([1n, 2n], [10n, 20n], 0n, 0n, 40n, 3n, 0n, ONE_DAY))
      .to.be.revertedWithCustomError(checker, "InconsistentValidatorsBalanceByModule")
      .withArgs(40n, 30n);
  });

  it("reverts with IncorrectTotalPendingBalance when reported pending exceeds funded protocol pending", async () => {
    await expect(checker.checkModuleAndCLBalancesChangeRates([1n, 2n], [10n, 20n], 0n, 0n, 30n, 4n, 0n, ONE_DAY))
      .to.be.revertedWithCustomError(checker, "IncorrectTotalPendingBalance")
      .withArgs(0n, 4n);
  });

  it("allows redistribution between modules when total CL balance is unchanged", async () => {
    const redistributionWei = limits.consolidationEthAmountPerDayLimit * ether("1");
    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: redistributionWei },
      { id: 2n, validatorsBalanceWei: redistributionWei },
    ]);

    await expect(
      check([
        { id: 1n, validatorsBalanceWei: 0n },
        { id: 2n, validatorsBalanceWei: redistributionWei * 2n },
      ]),
    ).not.to.be.reverted;
  });

  it("reverts with IncorrectTotalPendingBalance when a module reports more pending than the protocol funded", async () => {
    const previousPendingWei = ether("10");
    const reportedPendingWei = previousPendingWei + ether("1");

    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: 0n }]);

    await expect(
      check([{ id: 1n, validatorsBalanceWei: 0n, pendingWei: reportedPendingWei }], {
        preCLPendingBalanceWei: previousPendingWei,
      }),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalPendingBalance")
      .withArgs(previousPendingWei, reportedPendingWei);
  });

  it("allows pending-to-validators activation within a module when module total is unchanged", async () => {
    const previousPendingWei = ether("100");
    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: 0n }]);

    await expect(
      check([{ id: 1n, validatorsBalanceWei: ether("100"), pendingWei: 0n }], {
        preCLPendingBalanceWei: previousPendingWei,
      }),
    ).not.to.be.reverted;
  });

  it("reverts with IncorrectTotalCLBalanceIncrease when module increase exceeds the global activation budget", async () => {
    const previousValidatorsWei = ether("219000");
    const currentIncreasePerDay = ether("121");
    const previousPendingWei = ether("60");
    const expectedValidatorsGrowthLimitWei =
      previousPendingWei +
      ((previousValidatorsWei + previousPendingWei) * limits.annualBalanceIncreaseBPLimit) / (365n * 10_000n);

    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: previousValidatorsWei }]);

    await expect(
      check([{ id: 1n, validatorsBalanceWei: previousValidatorsWei + currentIncreasePerDay, pendingWei: 0n }], {
        preCLPendingBalanceWei: previousPendingWei,
      }),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalCLBalanceIncrease")
      .withArgs(expectedValidatorsGrowthLimitWei, currentIncreasePerDay);
  });

  it("sums module increases across modules before checking appeared limit", async () => {
    const previousModuleValidatorsWei = ether("109500");
    const previousPendingWei = ether("60");
    const totalPreviousValidatorsWei = previousModuleValidatorsWei * 2n;
    const totalPositiveModuleIncreaseWei = ether("131");
    const expectedModuleIncreaseLimitWei =
      previousPendingWei +
      ((totalPreviousValidatorsWei + previousPendingWei) * limits.annualBalanceIncreaseBPLimit) / (365n * 10_000n) +
      limits.consolidationEthAmountPerDayLimit * ether("1");

    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: previousModuleValidatorsWei },
      { id: 2n, validatorsBalanceWei: previousModuleValidatorsWei },
    ]);

    await expect(
      check(
        [
          {
            id: 1n,
            validatorsBalanceWei: previousModuleValidatorsWei + totalPositiveModuleIncreaseWei,
            pendingWei: 0n,
          },
          { id: 2n, validatorsBalanceWei: previousModuleValidatorsWei - ether("71"), pendingWei: 0n },
        ],
        {
          preCLPendingBalanceWei: previousPendingWei,
        },
      ),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalModuleValidatorsBalanceIncrease")
      .withArgs(expectedModuleIncreaseLimitWei, totalPositiveModuleIncreaseWei);
  });

  it("reverts with IncorrectTotalActivatedBalance when consumed pending exceeds the global appeared limit", async () => {
    const appearedLimitPerPeriodWei = limits.appearedEthAmountPerDayLimit * ether("1");
    const totalConsumedPendingWei = ether("120");

    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: 0n },
      { id: 2n, validatorsBalanceWei: 0n },
    ]);

    await expect(
      check(
        [
          { id: 1n, validatorsBalanceWei: 0n, pendingWei: 0n },
          { id: 2n, validatorsBalanceWei: 0n, pendingWei: 0n },
        ],
        {
          preCLPendingBalanceWei: totalConsumedPendingWei,
        },
      ),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalActivatedBalance")
      .withArgs(appearedLimitPerPeriodWei, totalConsumedPendingWei);
  });

  it("reverts with IncorrectTotalCLBalanceIncrease when reported validators balance growth exceeds consumed pending", async () => {
    const consumedPendingWei = ether("20");
    const reportedValidatorsGrowthWei = ether("60");
    const expectedValidatorsGrowthLimitWei =
      consumedPendingWei + (consumedPendingWei * limits.annualBalanceIncreaseBPLimit) / (365n * 10_000n);

    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: 0n },
      { id: 2n, validatorsBalanceWei: 0n },
    ]);

    await expect(
      check(
        [
          { id: 1n, validatorsBalanceWei: ether("30"), pendingWei: ether("20") },
          { id: 2n, validatorsBalanceWei: ether("30"), pendingWei: ether("20") },
        ],
        {
          preCLPendingBalanceWei: ether("60"),
        },
      ),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalCLBalanceIncrease")
      .withArgs(expectedValidatorsGrowthLimitWei, reportedValidatorsGrowthWei);
  });

  it("allows reported validators balance growth above consumed pending within safetyCap", async () => {
    const previousValidatorsWei = ether("3650");
    const previousPendingWei = ether("10");
    const consumedPendingWei = ether("9");
    const safetyCapWei =
      ((previousValidatorsWei + consumedPendingWei) * limits.annualBalanceIncreaseBPLimit) / (365n * 10_000n);
    const maxAllowedValidatorsGrowthWei = consumedPendingWei + safetyCapWei;
    const currentPendingWei = previousPendingWei - consumedPendingWei;
    const requiredValidatorsIncreaseWei = maxAllowedValidatorsGrowthWei;

    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: previousValidatorsWei }]);

    await expect(
      check(
        [
          {
            id: 1n,
            validatorsBalanceWei: previousValidatorsWei + requiredValidatorsIncreaseWei,
            pendingWei: currentPendingWei,
          },
        ],
        {
          preCLPendingBalanceWei: previousPendingWei,
        },
      ),
    ).not.to.be.reverted;
  });

  it("reverts when reported validators balance growth exceeds consumed pending plus safetyCap by an explicit overflow", async () => {
    const previousValidatorsWei = ether("3650");
    const previousPendingWei = ether("10");
    const consumedPendingWei = ether("9");
    const safetyCapWei =
      ((previousValidatorsWei + consumedPendingWei) * limits.annualBalanceIncreaseBPLimit) / (365n * 10_000n);
    const safetyCapOverflowWei = ether("1");
    const maxAllowedValidatorsGrowthWei = consumedPendingWei + safetyCapWei;
    const reportedValidatorsGrowthWei = maxAllowedValidatorsGrowthWei + safetyCapOverflowWei;
    const currentPendingWei = previousPendingWei - consumedPendingWei;
    const requiredValidatorsIncreaseWei = reportedValidatorsGrowthWei;

    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: previousValidatorsWei }]);

    await expect(
      check(
        [
          {
            id: 1n,
            validatorsBalanceWei: previousValidatorsWei + requiredValidatorsIncreaseWei,
            pendingWei: currentPendingWei,
          },
        ],
        {
          preCLPendingBalanceWei: previousPendingWei,
        },
      ),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalCLBalanceIncrease")
      .withArgs(maxAllowedValidatorsGrowthWei, reportedValidatorsGrowthWei);
  });

  it("allows an exact module increase at the appeared+consolidation limit", async () => {
    const previousValidatorsWei = ether("36500");
    const previousPendingWei = ether("36500");
    const activatedWei = ether("100");
    const exactIncrease = (limits.appearedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");

    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: previousValidatorsWei }]);

    await expect(
      check(
        [
          {
            id: 1n,
            validatorsBalanceWei: previousValidatorsWei + exactIncrease,
            pendingWei: previousPendingWei - activatedWei,
          },
        ],
        {
          preCLPendingBalanceWei: previousPendingWei,
        },
      ),
    ).not.to.be.reverted;
  });

  it("allows validator growth funded by existing pending when total CL is unchanged", async () => {
    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: ether("5") }]);

    await expect(
      check([{ id: 1n, validatorsBalanceWei: ether("105"), pendingWei: 0n }], {
        preCLPendingBalanceWei: ether("100"),
      }),
    ).not.to.be.reverted;
  });

  it("uses timeElapsed in per-day normalization (timeElapsed = 0 path)", async () => {
    const activatedWei = ether("5");
    const appearedLimitForZeroElapsedWei = (limits.appearedEthAmountPerDayLimit * ether("1")) / 24n;

    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: 0n }]);

    await expect(
      check([{ id: 1n, validatorsBalanceWei: activatedWei, pendingWei: 0n }], {
        preCLPendingBalanceWei: activatedWei,
        timeElapsed: 0n,
      }),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalActivatedBalance")
      .withArgs(appearedLimitForZeroElapsedWei, activatedWei);
  });

  it("normalizes module increases by a non-zero elapsed time", async () => {
    const previousValidatorsWei = ether("43800");
    const previousPendingWei = ether("36500");
    const halfDay = ONE_DAY / 2n;
    const activatedWei = ether("50");
    const safetyCapWei =
      ((previousValidatorsWei + activatedWei) * limits.annualBalanceIncreaseBPLimit * halfDay) /
      (365n * ONE_DAY * 10_000n);
    const allowedValidatorsGrowthWei = activatedWei + safetyCapWei;

    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: previousValidatorsWei }]);

    await expect(
      check(
        [
          {
            id: 1n,
            validatorsBalanceWei: previousValidatorsWei + allowedValidatorsGrowthWei,
            pendingWei: previousPendingWei - activatedWei,
          },
        ],
        {
          preCLPendingBalanceWei: previousPendingWei,
          timeElapsed: halfDay,
        },
      ),
    ).not.to.be.reverted;

    const exceededValidatorsGrowthWei = allowedValidatorsGrowthWei + ether("1");
    await expect(
      check(
        [
          {
            id: 1n,
            validatorsBalanceWei: previousValidatorsWei + exceededValidatorsGrowthWei,
            pendingWei: previousPendingWei - activatedWei,
          },
        ],
        {
          preCLPendingBalanceWei: previousPendingWei,
          timeElapsed: halfDay,
        },
      ),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalCLBalanceIncrease")
      .withArgs(allowedValidatorsGrowthWei, exceededValidatorsGrowthWei);
  });

  it("allows redistribution between modules even when maxCLBalanceDecreaseBP is zero", async () => {
    const redistributionWei = limits.consolidationEthAmountPerDayLimit * ether("1");
    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: redistributionWei },
      { id: 2n, validatorsBalanceWei: redistributionWei },
    ]);

    await checker.connect(admin).grantRole(await checker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE(), manager.address);
    await checker.connect(manager).setMaxCLBalanceDecreaseBP(0n);

    await expect(
      check([
        { id: 1n, validatorsBalanceWei: 0n },
        { id: 2n, validatorsBalanceWei: redistributionWei * 2n },
      ]),
    ).not.to.be.reverted;
  });
});
