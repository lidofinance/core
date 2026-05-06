import { expect } from "chai";
import { ethers } from "hardhat";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForSanityChecker,
  OracleReportSanityCheckerWrapper,
  StakingRouter__MockForAccountingOracle,
} from "typechain-types";

import { moduleBalanceFixtureSets } from "./fixtures/index";
import {
  calcModuleBalanceFormula,
  defaultOracleReportLimits,
  getPostCLValidatorsBalance,
  getPreCLValidatorsBalance,
  ModuleBalanceCase,
  toGwei,
} from "./lib";

describe("OracleReportSanityChecker.sol: module balance formula specs", () => {
  const deployChecker = async (
    testCase: ModuleBalanceCase,
  ): Promise<{
    checker: OracleReportSanityCheckerWrapper;
    stakingRouter: StakingRouter__MockForAccountingOracle;
  }> => {
    const [deployer] = await ethers.getSigners();
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
    const stakingRouter = (await ethers.deployContract(
      "StakingRouter__MockForAccountingOracle",
    )) as StakingRouter__MockForAccountingOracle;

    const locator = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
      {
        lido: deployer.address,
        depositSecurityModule: deployer.address,
        elRewardsVault: deployer.address,
        accountingOracle: await accountingOracle.getAddress(),
        oracleReportSanityChecker: deployer.address,
        burner: await burner.getAddress(),
        validatorsExitBusOracle: deployer.address,
        stakingRouter: await stakingRouter.getAddress(),
        treasury: deployer.address,
        withdrawalQueue: deployer.address,
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

    const checker = (await ethers.deployContract("OracleReportSanityCheckerWrapper", [
      await locator.getAddress(),
      await accounting.getAddress(),
      deployer.address,
      { ...defaultOracleReportLimits, ...testCase.limits },
      true,
    ])) as OracleReportSanityCheckerWrapper;

    return { checker, stakingRouter };
  };

  const seedPreviousBalances = async (
    stakingRouter: StakingRouter__MockForAccountingOracle,
    testCase: ModuleBalanceCase,
  ) => {
    const seededModules = testCase.report.modules.filter((module) => module.hasPreviousAccounting !== false);
    if (seededModules.length === 0) return;

    const moduleIds = seededModules.map((module) => module.moduleId);
    const validatorBalancesGwei = seededModules.map((module) => toGwei(module.previousValidatorsBalance));

    for (const moduleId of moduleIds) {
      await stakingRouter.mock__registerStakingModule(moduleId);
    }
    await stakingRouter.reportValidatorBalancesByStakingModule(moduleIds, validatorBalancesGwei);
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
          const { checker, stakingRouter } = await deployChecker(testCase);
          await seedPreviousBalances(stakingRouter, testCase);

          const limits = { ...defaultOracleReportLimits, ...testCase.limits };
          const formula = calcModuleBalanceFormula(testCase.report, limits);
          const call = checker.checkModuleAndCLBalancesChangeRates(
            testCase.report.modules.map((module) => module.moduleId),
            testCase.report.modules.map((module) => module.postValidatorsBalance),
            getPreCLValidatorsBalance(testCase.report),
            testCase.report.preCLPendingBalance,
            getPostCLValidatorsBalance(testCase.report),
            testCase.report.postCLPendingBalance,
            testCase.report.deposits,
            testCase.report.timeElapsed,
          );

          expectFormulaFields(testCase, formula);

          if (testCase.expected.outcome === "accepted") {
            await expect(call).not.to.be.reverted;
          } else if (testCase.expected.outcome === "IncorrectTotalPendingBalance") {
            await expect(call)
              .to.be.revertedWithCustomError(checker, "IncorrectTotalPendingBalance")
              .withArgs(formula.pendingBalanceCap, testCase.report.postCLPendingBalance);
          } else if (testCase.expected.outcome === "IncorrectTotalActivatedBalance") {
            await expect(call)
              .to.be.revertedWithCustomError(checker, "IncorrectTotalActivatedBalance")
              .withArgs(formula.appearedBalanceLimit, formula.activatedBalance);
          } else if (testCase.expected.outcome === "IncorrectTotalCLBalanceIncrease") {
            await expect(call)
              .to.be.revertedWithCustomError(checker, "IncorrectTotalCLBalanceIncrease")
              .withArgs(formula.validatorsGrowthLimit, formula.validatorsBalanceIncrease);
          } else {
            await expect(call)
              .to.be.revertedWithCustomError(checker, "IncorrectTotalModuleValidatorsBalanceIncrease")
              .withArgs(formula.moduleValidatorsGrowthLimit, formula.totalPositiveModuleDelta);
          }
        });
      }
    });
  }
});
