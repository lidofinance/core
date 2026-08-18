import { expect } from "chai";
import { ethers } from "hardhat";

import { moduleBalanceFixtureSets } from "./fixtures";
import {
  calcModuleBalanceFormula,
  getPostCLValidatorsBalance,
  ModuleBalanceCase,
  ModuleBalanceReport,
  OracleReportLimits,
} from "./lib";

const ONE_GWEI = 10n ** 9n;

describe("OracleReportSanityChecker.sol: module balance formula specs", () => {
  const deployChecker = async (limits: OracleReportLimits) => {
    const [deployer, admin, elRewardsVault, withdrawalVault] = await ethers.getSigners();
    const burner = await ethers.deployContract("Burner__MockForSanityChecker");
    const withdrawalQueue = await ethers.deployContract("WithdrawalQueue__MockForSanityChecker");
    const stakingRouter = await ethers.deployContract("StakingRouter__MockForAccountingOracle");
    const accountingOracle = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
      deployer.address,
      12n,
      1_606_824_023n,
    ]);
    const locator = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
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
        withdrawalVault: withdrawalVault.address,
        postTokenRebaseReceiver: deployer.address,
        oracleDaemonConfig: deployer.address,
        validatorExitDelayVerifier: deployer.address,
        triggerableWithdrawalsGateway: deployer.address,
        consolidationGateway: deployer.address,
        accounting: deployer.address,
        predepositGuarantee: deployer.address,
        wstETH: deployer.address,
        vaultHub: deployer.address,
        vaultFactory: deployer.address,
        lazyOracle: deployer.address,
        operatorGrid: deployer.address,
        topUpGateway: deployer.address,
      },
    ]);
    const checker = await ethers.deployContract("OracleReportSanityChecker", [
      await locator.getAddress(),
      deployer.address,
      admin.address,
      limits,
      ethers.ZeroAddress,
    ]);

    return { checker, stakingRouter };
  };

  const seedPreviousModuleBalances = async (
    stakingRouter: Awaited<ReturnType<typeof deployChecker>>["stakingRouter"],
    report: ModuleBalanceReport,
    title: string,
  ) => {
    const moduleIds = report.modules.map((module) => module.moduleId);
    const previousBalancesGwei = report.modules.map((module) => {
      expect(module.previousValidatorsBalance % ONE_GWEI, `${title}: module balance must be gwei-aligned`).to.equal(0n);

      if (module.hasPreviousAccounting === false) {
        expect(module.previousValidatorsBalance, `${title}: a module without accounting must be empty`).to.equal(0n);
      } else {
        expect(module.previousValidatorsBalance, `${title}: an existing baseline must be non-zero`).not.to.equal(0n);
      }

      return module.previousValidatorsBalance / ONE_GWEI;
    });

    for (const moduleId of moduleIds) {
      await stakingRouter.mock__registerStakingModule(moduleId);
    }
    await stakingRouter.reportValidatorBalancesByStakingModule(moduleIds, previousBalancesGwei);
  };

  const callModuleCheck = (
    checker: Awaited<ReturnType<typeof deployChecker>>["checker"],
    report: ModuleBalanceReport,
  ) =>
    checker.checkModuleAndCLBalancesChangeRates(
      report.modules.map((module) => module.moduleId),
      report.modules.map((module) => module.postValidatorsBalance),
      report.preCLValidatorsBalance,
      report.preCLPendingBalance,
      getPostCLValidatorsBalance(report),
      report.postCLPendingBalance,
      report.deposits,
      report.timeElapsed,
    );

  const expectFormulaFields = (testCase: ModuleBalanceCase, formula: ReturnType<typeof calcModuleBalanceFormula>) => {
    for (const [field, expectedValue] of Object.entries(testCase.expected.formula ?? {})) {
      expect(formula[field as keyof typeof formula], `${testCase.title}: ${field}`).to.equal(expectedValue);
    }
  };

  for (const fixtureSet of moduleBalanceFixtureSets) {
    describe(fixtureSet.title, () => {
      for (const testCase of fixtureSet.cases) {
        it(testCase.title, async () => {
          const limits = { ...fixtureSet.limits, ...testCase.limits };
          const formula = calcModuleBalanceFormula(testCase.report, limits);
          const { checker, stakingRouter } = await deployChecker(limits);
          await seedPreviousModuleBalances(stakingRouter, testCase.report, testCase.title);
          expectFormulaFields(testCase, formula);

          const call = () => callModuleCheck(checker, testCase.report);
          if (testCase.expected.outcome === "accepted") {
            await expect(call()).not.to.be.reverted;
          } else if (testCase.expected.outcome === "IncorrectTotalPendingBalance") {
            await expect(call())
              .to.be.revertedWithCustomError(checker, "IncorrectTotalPendingBalance")
              .withArgs(formula.pendingBalanceCap, testCase.report.postCLPendingBalance);
          } else if (testCase.expected.outcome === "IncorrectTotalActivatedBalance") {
            await expect(call())
              .to.be.revertedWithCustomError(checker, "IncorrectTotalActivatedBalance")
              .withArgs(formula.activatedBalanceLimit, formula.activatedBalance);
          } else {
            await expect(call())
              .to.be.revertedWithCustomError(checker, "IncorrectTotalModuleValidatorsBalanceIncrease")
              .withArgs(formula.moduleGrowthLimit, formula.grossPositiveModuleDeltas);
          }
        });
      }
    });
  }
});
