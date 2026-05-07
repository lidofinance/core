import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForSanityChecker,
  Lido__MockForSanityChecker,
  OracleReportSanityChecker,
} from "typechain-types";

import { ether, impersonate } from "lib";

import { clIncreaseFixtureSets } from "./fixtures/index";
import { calcClIncreaseFormula, ClIncreaseCase, ClIncreaseReport, ClIncreaseStep, OracleReportLimits } from "./lib";

describe("OracleReportSanityChecker.sol: CL increase formula specs", () => {
  const deployChecker = async (
    limitsList: OracleReportLimits,
  ): Promise<{
    checker: OracleReportSanityChecker;
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
    const stakingRouter = await ethers.deployContract("StakingRouter__MockForAccountingOracle");

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

    const checker = (await ethers.deployContract("OracleReportSanityChecker", [
      await locator.getAddress(),
      await accounting.getAddress(),
      deployer.address,
      limitsList,
    ])) as OracleReportSanityChecker;

    return {
      checker,
      accountingSigner: await impersonate(await accounting.getAddress(), ether("1")),
      lido,
      withdrawalVaultAddress: withdrawalVault.address,
    };
  };

  type ScenarioState = {
    lastVaultBalanceAfterTransfer: bigint;
  };

  const runMigrationStep = async (
    checker: OracleReportSanityChecker,
    lido: Lido__MockForSanityChecker,
    withdrawalVaultAddress: string,
    state: ScenarioState,
    step: Exclude<ClIncreaseStep, ClIncreaseReport>,
  ) => {
    await setBalance(withdrawalVaultAddress, step.withdrawalVaultBalance);
    await lido.mock__setContractVersion(4n);
    await lido.mock__setBalanceStats(step.clValidatorsBalance, step.clPendingBalance, step.deposits, step.deposits);

    await expect(checker.migrateBaselineSnapshot(), `migration '${step.label}'`).not.to.be.reverted;
    state.lastVaultBalanceAfterTransfer = step.withdrawalVaultBalance;
  };

  const callAccountingReport = (
    checker: OracleReportSanityChecker,
    accountingSigner: HardhatEthersSigner,
    state: ScenarioState,
    report: ClIncreaseReport,
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

  const runAcceptedReportStep = async (
    checker: OracleReportSanityChecker,
    accountingSigner: HardhatEthersSigner,
    withdrawalVaultAddress: string,
    state: ScenarioState,
    report: ClIncreaseReport,
    title: string,
  ) => {
    const withdrawalVaultBalance = state.lastVaultBalanceAfterTransfer + report.movements.clWithdrawals;
    await setBalance(withdrawalVaultAddress, withdrawalVaultBalance);

    await expect(
      callAccountingReport(checker, accountingSigner, state, report),
      `${title}: setup report '${report.label}'`,
    ).not.to.be.reverted;
    state.lastVaultBalanceAfterTransfer = withdrawalVaultBalance - report.movements.clWithdrawals;
  };

  const expectFormulaFields = (testCase: ClIncreaseCase, formula: ReturnType<typeof calcClIncreaseFormula>) => {
    const expectedFormula = testCase.expected.formula;
    if (expectedFormula === undefined) return;

    for (const [field, value] of Object.entries(expectedFormula)) {
      expect(formula[field as keyof typeof formula], `${testCase.title}: ${field}`).to.equal(value);
    }
  };

  for (const fixtureSet of clIncreaseFixtureSets) {
    describe(fixtureSet.title, () => {
      for (const testCase of fixtureSet.cases) {
        it(testCase.title, async () => {
          const limits = { ...fixtureSet.limits, ...testCase.limits };
          const { checker, accountingSigner, lido, withdrawalVaultAddress } = await deployChecker(limits);
          const checkedStep = testCase.steps[testCase.steps.length - 1];
          expect(checkedStep.kind, `${testCase.title}: checked step`).to.equal("report");
          const checkedReport = checkedStep as ClIncreaseReport;
          const state: ScenarioState = { lastVaultBalanceAfterTransfer: 0n };

          for (const step of testCase.steps.slice(0, -1)) {
            if (step.kind === "migration") {
              await runMigrationStep(checker, lido, withdrawalVaultAddress, state, step);
            } else {
              await runAcceptedReportStep(
                checker,
                accountingSigner,
                withdrawalVaultAddress,
                state,
                step,
                testCase.title,
              );
            }
          }

          const formula = calcClIncreaseFormula(checkedReport, limits);
          const withdrawalVaultBalance = state.lastVaultBalanceAfterTransfer + checkedReport.movements.clWithdrawals;
          const call = checker.checkCLPendingBalanceIncrease(
            checkedReport.timeElapsed,
            checkedReport.cl.preValidatorsBalance,
            checkedReport.cl.prePendingBalance,
            checkedReport.cl.postValidatorsBalance,
            checkedReport.cl.postPendingBalance,
            withdrawalVaultBalance,
            checkedReport.movements.deposits,
          );

          expectFormulaFields(testCase, formula);

          if (testCase.expected.outcome === "accepted") {
            await expect(call).not.to.be.reverted;
          } else if (testCase.expected.outcome === "IncorrectTotalPendingBalance") {
            await expect(call)
              .to.be.revertedWithCustomError(checker, "IncorrectTotalPendingBalance")
              .withArgs(formula.pendingBalanceCap, checkedReport.cl.postPendingBalance);
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
  }
});
