import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForSanityChecker,
  Lido__MockForSanityChecker,
  OracleReportSanityCheckerWrapper,
  StakingRouter__MockForAccountingOracle,
} from "typechain-types";

import { ether, impersonate } from "lib";

import { moduleBalanceFixtureSets } from "./fixtures/index";
import {
  calcModuleBalanceFormula,
  getPostCLValidatorsBalance,
  getPreCLValidatorsBalance,
  ModuleBalanceCase,
  ModuleBalanceReport,
  ModuleBalanceStepFixture,
  OracleReportLimits,
  toGwei,
} from "./lib";

describe("OracleReportSanityChecker.sol: module balance formula specs", () => {
  const deployChecker = async (
    limitsList: OracleReportLimits,
    postMigrationFirstReportDone: boolean,
  ): Promise<{
    checker: OracleReportSanityCheckerWrapper;
    stakingRouter: StakingRouter__MockForAccountingOracle;
    accountingSigner: HardhatEthersSigner;
    lido: Lido__MockForSanityChecker;
    withdrawalVaultAddress: string;
  }> => {
    const [deployer, withdrawalVault] = await ethers.getSigners();
    const burner = await ethers.deployContract("Burner__MockForSanityChecker", []);
    const accounting = (await ethers.deployContract(
      "Accounting__MockForSanityChecker",
      [],
    )) as Accounting__MockForSanityChecker;
    const accountingOracle = (await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
      deployer.address,
      12,
      1_606_824_023,
    ])) as AccountingOracle__MockForSanityChecker;
    const lido = (await ethers.deployContract("Lido__MockForSanityChecker")) as Lido__MockForSanityChecker;
    const stakingRouter = (await ethers.deployContract(
      "StakingRouter__MockForAccountingOracle",
    )) as StakingRouter__MockForAccountingOracle;

    const locator = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
      {
        lido: await lido.getAddress(),
        depositSecurityModule: deployer.address,
        elRewardsVault: deployer.address,
        accountingOracle: await accountingOracle.getAddress(),
        oracleReportSanityChecker: deployer.address,
        burner: await burner.getAddress(),
        validatorsExitBusOracle: deployer.address,
        stakingRouter: await stakingRouter.getAddress(),
        treasury: deployer.address,
        withdrawalQueue: deployer.address,
        withdrawalVault: withdrawalVault.address,
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

    const checker = (await ethers.deployContract("OracleReportSanityCheckerWrapper", [
      await locator.getAddress(),
      await accounting.getAddress(),
      deployer.address,
      limitsList,
      postMigrationFirstReportDone,
    ])) as OracleReportSanityCheckerWrapper;

    return {
      checker,
      stakingRouter,
      accountingSigner: await impersonate(await accounting.getAddress(), ether("1")),
      lido,
      withdrawalVaultAddress: withdrawalVault.address,
    };
  };

  const seedPreviousBalances = async (
    stakingRouter: StakingRouter__MockForAccountingOracle,
    report: ModuleBalanceReport,
  ) => {
    const seededModules = report.modules.filter((module) => module.hasPreviousAccounting !== false);
    if (seededModules.length === 0) return;

    const moduleIds = seededModules.map((module) => module.moduleId);
    const validatorBalancesGwei = seededModules.map((module) => toGwei(module.previousValidatorsBalance));

    for (const moduleId of moduleIds) {
      await stakingRouter.mock__registerStakingModule(moduleId);
    }
    await stakingRouter.reportValidatorBalancesByStakingModule(moduleIds, validatorBalancesGwei);
  };

  type ScenarioState = {
    lastVaultBalanceAfterTransfer: bigint;
  };

  const runMigrationStep = async (
    checker: OracleReportSanityCheckerWrapper,
    lido: Lido__MockForSanityChecker,
    withdrawalVaultAddress: string,
    state: ScenarioState,
    step: Exclude<ModuleBalanceStepFixture, ModuleBalanceReport>,
  ) => {
    await setBalance(withdrawalVaultAddress, step.withdrawalVaultBalance);
    await lido.mock__setContractVersion(4n);
    await lido.mock__setBalanceStats(step.clValidatorsBalance, step.clPendingBalance, step.deposits, step.deposits);

    await expect(checker.migrateBaselineSnapshot(), `migration '${step.label}'`).not.to.be.reverted;
    state.lastVaultBalanceAfterTransfer = step.withdrawalVaultBalance;
  };

  const callAccountingReport = (
    checker: OracleReportSanityCheckerWrapper,
    accountingSigner: HardhatEthersSigner,
    state: ScenarioState,
    report: ModuleBalanceReport,
  ) => {
    const withdrawalVaultBalance = state.lastVaultBalanceAfterTransfer + report.movements.clWithdrawals;

    return checker
      .connect(accountingSigner)
      .checkAccountingOracleReport(
        report.timeElapsed,
        report.cl.preValidatorsBalance,
        report.cl.prePendingBalance,
        report.cl.postValidatorsBalance,
        report.cl.postPendingBalance,
        withdrawalVaultBalance,
        0n,
        0n,
        report.movements.deposits,
        report.movements.clWithdrawals,
      );
  };

  const callModuleReport = (checker: OracleReportSanityCheckerWrapper, report: ModuleBalanceReport) =>
    checker.checkModuleAndCLBalancesChangeRates(
      report.modules.map((module) => module.moduleId),
      report.modules.map((module) => module.postValidatorsBalance),
      getPreCLValidatorsBalance(report),
      report.cl.prePendingBalance,
      getPostCLValidatorsBalance(report),
      report.cl.postPendingBalance,
      report.movements.deposits,
      report.timeElapsed,
    );

  const recordAcceptedModuleBalances = async (
    stakingRouter: StakingRouter__MockForAccountingOracle,
    report: ModuleBalanceReport,
  ) => {
    const moduleIds = report.modules.map((module) => module.moduleId);

    for (const moduleId of moduleIds) {
      await stakingRouter.mock__registerStakingModule(moduleId);
    }
    await stakingRouter.reportValidatorBalancesByStakingModule(
      moduleIds,
      report.modules.map((module) => toGwei(module.postValidatorsBalance)),
    );
  };

  const runAcceptedReportStep = async (
    checker: OracleReportSanityCheckerWrapper,
    stakingRouter: StakingRouter__MockForAccountingOracle,
    accountingSigner: HardhatEthersSigner,
    withdrawalVaultAddress: string,
    state: ScenarioState,
    report: ModuleBalanceReport,
    title: string,
  ) => {
    await expect(callModuleReport(checker, report), `${title}: module report '${report.label}'`).not.to.be.reverted;

    const withdrawalVaultBalance = state.lastVaultBalanceAfterTransfer + report.movements.clWithdrawals;
    await setBalance(withdrawalVaultAddress, withdrawalVaultBalance);
    await expect(
      callAccountingReport(checker, accountingSigner, state, report),
      `${title}: accounting report '${report.label}'`,
    ).not.to.be.reverted;

    state.lastVaultBalanceAfterTransfer = withdrawalVaultBalance - report.movements.clWithdrawals;
    await recordAcceptedModuleBalances(stakingRouter, report);
  };

  const expectFormulaFields = (testCase: ModuleBalanceCase, formula: ReturnType<typeof calcModuleBalanceFormula>) => {
    const expectedFormula = testCase.expected.formula;
    if (expectedFormula === undefined) return;

    for (const [field, value] of Object.entries(expectedFormula)) {
      expect(formula[field as keyof typeof formula], `${testCase.title}: ${field}`).to.equal(value);
    }
  };

  for (const fixtureSet of moduleBalanceFixtureSets) {
    describe(fixtureSet.title, () => {
      for (const testCase of fixtureSet.cases) {
        it(testCase.title, async () => {
          const limits = { ...fixtureSet.limits, ...testCase.limits };
          const reportSteps = testCase.steps.filter((step): step is ModuleBalanceReport => step.kind === "report");
          const startsAfterFirstReport = reportSteps.length === 1;
          const { checker, stakingRouter, accountingSigner, lido, withdrawalVaultAddress } = await deployChecker(
            limits,
            startsAfterFirstReport,
          );
          const checkedStep = testCase.steps[testCase.steps.length - 1];
          expect(checkedStep.kind, `${testCase.title}: checked step`).to.equal("report");
          const checkedReport = checkedStep as ModuleBalanceReport;
          const state: ScenarioState = { lastVaultBalanceAfterTransfer: 0n };

          if (reportSteps.length > 0) {
            await seedPreviousBalances(stakingRouter, reportSteps[0]);
          }

          for (const step of testCase.steps.slice(0, -1)) {
            if (step.kind === "migration") {
              await runMigrationStep(checker, lido, withdrawalVaultAddress, state, step);
            } else {
              await runAcceptedReportStep(
                checker,
                stakingRouter,
                accountingSigner,
                withdrawalVaultAddress,
                state,
                step,
                testCase.title,
              );
            }
          }

          const formula = calcModuleBalanceFormula(checkedReport, limits);
          const call = () => callModuleReport(checker, checkedReport);

          expectFormulaFields(testCase, formula);

          if (testCase.expected.outcome === "accepted") {
            await runAcceptedReportStep(
              checker,
              stakingRouter,
              accountingSigner,
              withdrawalVaultAddress,
              state,
              checkedReport,
              testCase.title,
            );
          } else if (testCase.expected.outcome === "IncorrectTotalPendingBalance") {
            await expect(call())
              .to.be.revertedWithCustomError(checker, "IncorrectTotalPendingBalance")
              .withArgs(formula.pendingBalanceCap, checkedReport.cl.postPendingBalance);
          } else if (testCase.expected.outcome === "IncorrectTotalActivatedBalance") {
            await expect(call())
              .to.be.revertedWithCustomError(checker, "IncorrectTotalActivatedBalance")
              .withArgs(formula.appearedBalanceLimit, formula.activatedBalance);
          } else if (testCase.expected.outcome === "IncorrectTotalCLBalanceIncrease") {
            await expect(call())
              .to.be.revertedWithCustomError(checker, "IncorrectTotalCLBalanceIncrease")
              .withArgs(formula.validatorsGrowthLimit, formula.validatorsBalanceIncrease);
          } else {
            await expect(call())
              .to.be.revertedWithCustomError(checker, "IncorrectTotalModuleValidatorsBalanceIncrease")
              .withArgs(formula.moduleValidatorsGrowthLimit, formula.totalPositiveModuleDelta);
          }
        });
      }
    });
  }
});
