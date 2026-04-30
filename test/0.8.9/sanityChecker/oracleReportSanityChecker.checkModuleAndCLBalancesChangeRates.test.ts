import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForSanityChecker,
  Burner__MockForSanityChecker,
  LidoLocator__MockForSanityChecker,
  OracleReportSanityChecker,
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

  let checker: OracleReportSanityChecker;
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
    const pendingBalancesGwei = modules.map((m) => toGwei(m.pendingWei ?? 0n));
    const clValidatorsBalanceGwei = validatorBalancesGweiByStakingModule.reduce((sum, val) => sum + val, 0n);
    const clPendingBalanceGwei = pendingBalancesGwei.reduce((sum, val) => sum + val, 0n);

    return {
      ids,
      validatorBalancesGweiByStakingModule,
      pendingBalancesGwei,
      clValidatorsBalanceGwei,
      clPendingBalanceGwei,
    };
  };

  const seedPreviousBalances = async (modules: ModuleBalance[]) => {
    const input = toModuleInput(modules);
    await stakingRouter.reportValidatorBalancesByStakingModule(
      input.ids,
      input.validatorBalancesGweiByStakingModule,
      input.pendingBalancesGwei,
    );
  };

  const check = async (modules: ModuleBalance[], timeElapsed = ONE_DAY) => {
    const input = toModuleInput(modules);
    const previousModuleStates = await Promise.all(
      input.ids.map((id) => stakingRouter.getStakingModuleStateAccounting(id)),
    );
    const preCLValidatorsBalanceGwei = previousModuleStates.reduce(
      (sum, [validatorsBalanceGwei]) => sum + validatorsBalanceGwei,
      0n,
    );
    const postCLValidatorsBalanceGwei = input.clValidatorsBalanceGwei;
    return checker.checkModuleAndCLBalancesChangeRates(
      input.ids,
      input.validatorBalancesGweiByStakingModule,
      input.pendingBalancesGwei,
      preCLValidatorsBalanceGwei,
      postCLValidatorsBalanceGwei,
      input.clValidatorsBalanceGwei,
      input.clPendingBalanceGwei,
      timeElapsed,
    );
  };

  const deployCheckerWithRouterModules = async (modulesCount = 1) => {
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

    const checkerWithRouter = await ethers.deployContract("OracleReportSanityChecker", [
      await locatorWithRouter.getAddress(),
      await accounting.getAddress(),
      admin.address,
      limits,
    ]);

    return {
      checkerWithRouter,
      stakingRouterHarness: routerHarness.stakingRouter,
      moduleIds,
    };
  };

  const checkGlobalReport = (
    sanityChecker: OracleReportSanityChecker,
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

    checker = await ethers.deployContract("OracleReportSanityChecker", [
      await locator.getAddress(),
      await accounting.getAddress(),
      admin.address,
      limits,
    ]);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  it("passes for empty module arrays and zero totals", async () => {
    await expect(checker.checkModuleAndCLBalancesChangeRates([], [], [], 0n, 0n, 0n, 0n, ONE_DAY)).not.to.be.reverted;
  });

  it("skips module-specific checks for the first report of a newly added module", async () => {
    const { checkerWithRouter, moduleIds } = await deployCheckerWithRouterModules();
    const [moduleId] = moduleIds;
    const firstReportTotalBalanceGwei = ether("120") / ONE_GWEI;

    await expect(
      checkerWithRouter.checkModuleAndCLBalancesChangeRates(
        [moduleId],
        [firstReportTotalBalanceGwei],
        [0n],
        firstReportTotalBalanceGwei,
        firstReportTotalBalanceGwei,
        firstReportTotalBalanceGwei,
        0n,
        ONE_DAY,
      ),
    ).not.to.be.reverted;
  });

  it("applies module-specific checks after the first report seeds non-zero module state", async () => {
    const { checkerWithRouter, stakingRouterHarness, moduleIds } = await deployCheckerWithRouterModules();
    const [moduleId] = moduleIds;
    const expectedLimitPerDay =
      (limits.appearedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");
    const firstValidatorsBalanceGwei = ether("40150") / ONE_GWEI;
    const firstPendingBalanceGwei = ether("120") / ONE_GWEI;
    const secondValidatorsBalanceGwei = firstValidatorsBalanceGwei + ether("111") / ONE_GWEI;
    const secondPendingBalanceGwei = ether("20") / ONE_GWEI;
    await expect(
      checkerWithRouter.checkModuleAndCLBalancesChangeRates(
        [moduleId],
        [firstValidatorsBalanceGwei],
        [firstPendingBalanceGwei],
        firstValidatorsBalanceGwei,
        firstValidatorsBalanceGwei,
        firstValidatorsBalanceGwei,
        firstPendingBalanceGwei,
        ONE_DAY,
      ),
    ).not.to.be.reverted;

    await stakingRouterHarness
      .connect(admin)
      .reportValidatorBalancesByStakingModule([moduleId], [firstValidatorsBalanceGwei], [firstPendingBalanceGwei]);

    await expect(
      checkerWithRouter.checkModuleAndCLBalancesChangeRates(
        [moduleId],
        [secondValidatorsBalanceGwei],
        [secondPendingBalanceGwei],
        firstValidatorsBalanceGwei,
        secondValidatorsBalanceGwei,
        secondValidatorsBalanceGwei,
        secondPendingBalanceGwei,
        ONE_DAY,
      ),
    )
      .to.be.revertedWithCustomError(checkerWithRouter, "AppearedEthAmountPerDayLimitExceeded")
      .withArgs(expectedLimitPerDay, ether("111"));
  });

  it("supports cold-start onboarding across the global path and module bootstrap flow", async () => {
    const { checkerWithRouter, stakingRouterHarness, moduleIds } = await deployCheckerWithRouterModules();
    const [moduleId] = moduleIds;
    const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
    const depositedWei = ether("200");
    const depositedPendingBalanceGwei = depositedWei / ONE_GWEI;
    const activatedValidatorsWei = ether("100");
    const remainingPendingWei = depositedWei - activatedValidatorsWei;
    const activatedValidatorsBalanceGwei = activatedValidatorsWei / ONE_GWEI;
    const remainingPendingBalanceGwei = remainingPendingWei / ONE_GWEI;

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
        [depositedPendingBalanceGwei],
        0n,
        0n,
        0n,
        depositedPendingBalanceGwei,
        ONE_DAY,
      ),
    ).not.to.be.reverted;

    await stakingRouterHarness
      .connect(admin)
      .reportValidatorBalancesByStakingModule([moduleId], [0n], [depositedPendingBalanceGwei]);

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
        [activatedValidatorsBalanceGwei],
        [remainingPendingBalanceGwei],
        0n,
        activatedValidatorsBalanceGwei,
        activatedValidatorsBalanceGwei,
        remainingPendingBalanceGwei,
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
        [moduleOneInitialPendingWei / ONE_GWEI, moduleTwoInitialPendingWei / ONE_GWEI],
        0n,
        0n,
        0n,
        totalInitialPendingWei / ONE_GWEI,
        ONE_DAY,
      ),
    ).not.to.be.reverted;

    await stakingRouterHarness
      .connect(admin)
      .reportValidatorBalancesByStakingModule(
        [moduleOneId, moduleTwoId],
        [0n, 0n],
        [moduleOneInitialPendingWei / ONE_GWEI, moduleTwoInitialPendingWei / ONE_GWEI],
      );

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
        [moduleOneActivatedValidatorsWei / ONE_GWEI, moduleTwoActivatedValidatorsWei / ONE_GWEI],
        [moduleOneRemainingPendingWei / ONE_GWEI, moduleTwoRemainingPendingWei / ONE_GWEI],
        0n,
        totalActivatedValidatorsWei / ONE_GWEI,
        totalActivatedValidatorsWei / ONE_GWEI,
        totalRemainingPendingWei / ONE_GWEI,
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
        [initialPendingWei / ONE_GWEI],
        0n,
        0n,
        0n,
        initialPendingWei / ONE_GWEI,
        zeroTimeElapsed,
      ),
    ).not.to.be.reverted;

    await stakingRouterHarness
      .connect(admin)
      .reportValidatorBalancesByStakingModule([moduleId], [0n], [initialPendingWei / ONE_GWEI]);

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
        [maxModuleActivationGwei],
        [remainingPendingWei / ONE_GWEI],
        0n,
        maxModuleActivationGwei,
        maxModuleActivationGwei,
        remainingPendingWei / ONE_GWEI,
        zeroTimeElapsed,
      ),
    ).not.to.be.reverted;
  });

  it("reverts with InvalidClBalancesData on array length mismatch", async () => {
    await expect(
      checker.checkModuleAndCLBalancesChangeRates([1n], [1n], [], 0n, 1n, 1n, 0n, ONE_DAY),
    ).to.be.revertedWithCustomError(checker, "InvalidClBalancesData");
  });

  it("reverts with InconsistentValidatorsBalanceByModule when validators balance sum mismatches", async () => {
    await expect(checker.checkModuleAndCLBalancesChangeRates([1n, 2n], [10n, 20n], [1n, 2n], 0n, 30n, 40n, 3n, ONE_DAY))
      .to.be.revertedWithCustomError(checker, "InconsistentValidatorsBalanceByModule")
      .withArgs(40n, 30n);
  });

  it("reverts with InconsistentPendingBalanceByModule when pending sum mismatches", async () => {
    await expect(checker.checkModuleAndCLBalancesChangeRates([1n, 2n], [10n, 20n], [1n, 2n], 0n, 30n, 30n, 4n, ONE_DAY))
      .to.be.revertedWithCustomError(checker, "InconsistentPendingBalanceByModule")
      .withArgs(4n, 3n);
  });

  it("allows redistribution between modules when total CL balance is unchanged", async () => {
    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: ether("100") },
      { id: 2n, validatorsBalanceWei: ether("100") },
    ]);

    await expect(
      check([
        { id: 1n, validatorsBalanceWei: 0n }, // -100 ETH
        { id: 2n, validatorsBalanceWei: ether("200") }, // +100 ETH
      ]),
    ).not.to.be.reverted;
  });

  it("reverts with IncorrectModulePendingBalance when a module pending balance exceeds its corridor", async () => {
    const previousPendingWei = ether("10");
    const reportedPendingWei = previousPendingWei + ether("1");

    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: 0n, pendingWei: previousPendingWei }]);

    await expect(check([{ id: 1n, validatorsBalanceWei: 0n, pendingWei: reportedPendingWei }]))
      .to.be.revertedWithCustomError(checker, "IncorrectModulePendingBalance")
      .withArgs(1n, 0n, toGwei(previousPendingWei), toGwei(reportedPendingWei));
  });

  it("allows pending-to-validators activation within a module when module total is unchanged", async () => {
    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: 0n, pendingWei: ether("100") }]);

    await expect(check([{ id: 1n, validatorsBalanceWei: ether("100"), pendingWei: 0n }])).not.to.be.reverted;
  });

  it("reverts with AppearedEthAmountPerDayLimitExceeded when module increase exceeds appeared+consolidation", async () => {
    const previousValidatorsWei = ether("219000");
    const currentIncreasePerDay = ether("120");
    const expectedLimitPerDay =
      (limits.appearedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");

    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: previousValidatorsWei, pendingWei: ether("60") }]);

    await expect(
      check([{ id: 1n, validatorsBalanceWei: previousValidatorsWei + currentIncreasePerDay, pendingWei: 0n }]),
    )
      .to.be.revertedWithCustomError(checker, "AppearedEthAmountPerDayLimitExceeded")
      .withArgs(expectedLimitPerDay, currentIncreasePerDay);
  });

  it("sums module increases across modules before checking appeared limit", async () => {
    const previousModuleValidatorsWei = ether("109500");
    const totalIncreasePerDay = ether("120");
    const expectedLimitPerDay =
      (limits.appearedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");

    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: previousModuleValidatorsWei, pendingWei: ether("30") },
      { id: 2n, validatorsBalanceWei: previousModuleValidatorsWei, pendingWei: ether("30") },
    ]);

    await expect(
      check([
        { id: 1n, validatorsBalanceWei: previousModuleValidatorsWei + ether("60"), pendingWei: 0n },
        { id: 2n, validatorsBalanceWei: previousModuleValidatorsWei + ether("60"), pendingWei: 0n },
      ]),
    )
      .to.be.revertedWithCustomError(checker, "AppearedEthAmountPerDayLimitExceeded")
      .withArgs(expectedLimitPerDay, totalIncreasePerDay);
  });

  it("reverts with IncorrectTotalActiveAppearedEth when consumed pending exceeds the global appeared limit", async () => {
    const perDayAppearedLimitGwei = toGwei(ether("100"));
    const totalConsumedPendingGwei = toGwei(ether("120"));

    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: 0n, pendingWei: ether("60") },
      { id: 2n, validatorsBalanceWei: 0n, pendingWei: ether("60") },
    ]);

    await expect(
      check([
        { id: 1n, validatorsBalanceWei: 0n, pendingWei: 0n },
        { id: 2n, validatorsBalanceWei: 0n, pendingWei: 0n },
      ]),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalActiveAppearedEth")
      .withArgs(perDayAppearedLimitGwei, totalConsumedPendingGwei);
  });

  it("reverts with IncorrectTotalCLBalanceIncrease when reported validators balance growth exceeds consumed pending", async () => {
    const consumedPendingGwei = toGwei(ether("20"));
    const reportedValidatorsGrowthGwei = toGwei(ether("60"));

    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: 0n, pendingWei: ether("30") },
      { id: 2n, validatorsBalanceWei: 0n, pendingWei: ether("30") },
    ]);

    await expect(
      check([
        { id: 1n, validatorsBalanceWei: ether("30"), pendingWei: ether("20") },
        { id: 2n, validatorsBalanceWei: ether("30"), pendingWei: ether("20") },
      ]),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalCLBalanceIncrease")
      .withArgs(consumedPendingGwei, reportedValidatorsGrowthGwei);
  });

  it("allows reported validators balance growth above consumed pending within safetyCap", async () => {
    const previousValidatorsWei = ether("3650");
    const previousPendingWei = ether("10");
    const consumedPendingWei = ether("9");
    const safetyCapWei = ether("1");
    const maxAllowedValidatorsGrowthWei = consumedPendingWei + safetyCapWei;
    const currentPendingWei = previousPendingWei - consumedPendingWei;
    const requiredValidatorsIncreaseWei = maxAllowedValidatorsGrowthWei;

    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: previousValidatorsWei, pendingWei: previousPendingWei },
    ]);

    await expect(
      check([
        {
          id: 1n,
          validatorsBalanceWei: previousValidatorsWei + requiredValidatorsIncreaseWei,
          pendingWei: currentPendingWei,
        },
      ]),
    ).not.to.be.reverted;
  });

  it("reverts when reported validators balance growth exceeds consumed pending plus safetyCap by an explicit overflow", async () => {
    const previousValidatorsWei = ether("3650");
    const previousPendingWei = ether("10");
    const consumedPendingWei = ether("9");
    const safetyCapWei = ether("1");
    const safetyCapOverflowWei = ether("1");
    const maxAllowedValidatorsGrowthWei = consumedPendingWei + safetyCapWei;
    const reportedValidatorsGrowthWei = maxAllowedValidatorsGrowthWei + safetyCapOverflowWei;
    const currentPendingWei = previousPendingWei - consumedPendingWei;
    const requiredValidatorsIncreaseWei = reportedValidatorsGrowthWei;

    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: previousValidatorsWei, pendingWei: previousPendingWei },
    ]);

    await expect(
      check([
        {
          id: 1n,
          validatorsBalanceWei: previousValidatorsWei + requiredValidatorsIncreaseWei,
          pendingWei: currentPendingWei,
        },
      ]),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalCLBalanceIncrease")
      .withArgs(toGwei(maxAllowedValidatorsGrowthWei), toGwei(reportedValidatorsGrowthWei));
  });

  it("allows an exact module increase at the appeared+consolidation limit", async () => {
    const previousValidatorsWei = ether("36500");
    const exactIncrease = (limits.appearedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");

    // 100 ETH of consumed pending plus a 10 ETH safetyCap funds the exact 110 ETH validators increase.
    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: previousValidatorsWei, pendingWei: ether("100") }]);

    await expect(check([{ id: 1n, validatorsBalanceWei: previousValidatorsWei + exactIncrease, pendingWei: 0n }])).not
      .to.be.reverted;
  });

  it("allows validator growth funded by existing pending when total CL is unchanged", async () => {
    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: ether("5"), pendingWei: ether("100") }]);

    await expect(check([{ id: 1n, validatorsBalanceWei: ether("105"), pendingWei: 0n }])).not.to.be.reverted;
  });

  it("uses timeElapsed in per-day normalization (timeElapsed = 0 path)", async () => {
    const baseIncrease = ether("1");
    const normalizedIncreasePerDay = baseIncrease * 86_400n;
    const expectedLimitPerDay =
      (limits.appearedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");

    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: 0n, pendingWei: baseIncrease }]);

    await expect(check([{ id: 1n, validatorsBalanceWei: baseIncrease, pendingWei: 0n }], 0n))
      .to.be.revertedWithCustomError(checker, "AppearedEthAmountPerDayLimitExceeded")
      .withArgs(expectedLimitPerDay, normalizedIncreasePerDay);
  });

  it("normalizes module increases by a non-zero elapsed time", async () => {
    const previousValidatorsWei = ether("43800");
    const halfDay = ONE_DAY / 2n;
    const expectedLimitPerDay =
      (limits.appearedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");

    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: previousValidatorsWei, pendingWei: ether("50") }]);

    await expect(
      check([{ id: 1n, validatorsBalanceWei: previousValidatorsWei + ether("55"), pendingWei: 0n }], halfDay),
    ).not.to.be.reverted;

    const normalizedIncreasePerDay = ether("56") * 2n;
    await expect(
      check([{ id: 1n, validatorsBalanceWei: previousValidatorsWei + ether("56"), pendingWei: 0n }], halfDay),
    )
      .to.be.revertedWithCustomError(checker, "AppearedEthAmountPerDayLimitExceeded")
      .withArgs(expectedLimitPerDay, normalizedIncreasePerDay);
  });

  it("allows redistribution between modules even when maxCLBalanceDecreaseBP is zero", async () => {
    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: ether("100") },
      { id: 2n, validatorsBalanceWei: ether("100") },
    ]);

    await checker.connect(admin).grantRole(await checker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE(), manager.address);
    await checker.connect(manager).setMaxCLBalanceDecreaseBP(0n);

    await expect(
      check([
        { id: 1n, validatorsBalanceWei: 0n },
        { id: 2n, validatorsBalanceWei: ether("200") },
      ]),
    ).not.to.be.reverted;
  });
});
