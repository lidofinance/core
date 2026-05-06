import { expect } from "chai";
import { ethers } from "hardhat";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForSanityChecker,
  OracleReportSanityChecker,
} from "typechain-types";

import { clIncreaseCases } from "./fixtures";
import { calcClIncreaseFormula, ClIncreaseCase, defaultOracleReportLimits } from "./lib";

describe("OracleReportSanityChecker.sol: CL increase formula specs", () => {
  const deployChecker = async (testCase: ClIncreaseCase): Promise<OracleReportSanityChecker> => {
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
    const stakingRouter = await ethers.deployContract("StakingRouter__MockForAccountingOracle");

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

    return ethers.deployContract("OracleReportSanityChecker", [
      await locator.getAddress(),
      await accounting.getAddress(),
      deployer.address,
      { ...defaultOracleReportLimits, ...testCase.limits },
    ]);
  };

  const expectFormulaFields = (testCase: ClIncreaseCase, formula: ReturnType<typeof calcClIncreaseFormula>) => {
    const expectedFormula = testCase.expected.formula;
    if (expectedFormula === undefined) return;

    for (const [field, value] of Object.entries(expectedFormula)) {
      expect(formula[field as keyof typeof formula], `${testCase.title}: ${field}`).to.equal(value);
    }
  };

  for (const testCase of clIncreaseCases) {
    it(testCase.title, async () => {
      const checker = await deployChecker(testCase);
      const limits = { ...defaultOracleReportLimits, ...testCase.limits };
      const formula = calcClIncreaseFormula(testCase.report, limits);
      const call = checker.checkCLPendingBalanceIncrease(
        testCase.report.timeElapsed,
        testCase.report.preValidatorsBalance,
        testCase.report.prePendingBalance,
        testCase.report.postValidatorsBalance,
        testCase.report.postPendingBalance,
        testCase.report.clWithdrawals,
        testCase.report.deposits,
      );

      expectFormulaFields(testCase, formula);

      if (testCase.expected.outcome === "accepted") {
        await expect(call).not.to.be.reverted;
      } else if (testCase.expected.outcome === "IncorrectTotalPendingBalance") {
        await expect(call)
          .to.be.revertedWithCustomError(checker, "IncorrectTotalPendingBalance")
          .withArgs(formula.pendingBalanceCap, testCase.report.postPendingBalance);
      } else if (testCase.expected.outcome === "IncorrectTotalActivatedBalance") {
        await expect(call)
          .to.be.revertedWithCustomError(checker, "IncorrectTotalActivatedBalance")
          .withArgs(formula.appearedBalanceLimit, formula.activatedBalance);
      } else {
        await expect(call)
          .to.be.revertedWithCustomError(checker, "IncorrectTotalCLBalanceIncrease")
          .withArgs(formula.validatorsGrowthLimit, formula.validatorsBalanceIncrease);
      }
    });
  }
});
