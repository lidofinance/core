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

import { negativeRebaseFormulaFixtureSets } from "./fixtures/index";
import {
  buildStoredReportsModel,
  calcExpectedWindowDiff,
  NegativeRebaseStep,
  OracleReportFixture,
  OracleReportLimits,
} from "./lib";

describe("OracleReportSanityChecker.sol: negative rebase formula specs", () => {
  const deployChecker = async (
    limitsList: OracleReportLimits,
  ): Promise<{
    checker: OracleReportSanityChecker;
    accountingSigner: HardhatEthersSigner;
    lido: Lido__MockForSanityChecker;
    withdrawalVaultAddress: string;
  }> => {
    const [deployer, withdrawalVault] = await ethers.getSigners();
    await setBalance(withdrawalVault.address, ether("10000"));

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
    const stakingRouter = await ethers.deployContract("StakingRouter__MockForSanityChecker");

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
        wstETH: deployer.address,
        vaultHub: deployer.address,
        vaultFactory: deployer.address,
        lazyOracle: deployer.address,
        predepositGuarantee: deployer.address,
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
    step: Exclude<NegativeRebaseStep, OracleReportFixture>,
  ) => {
    await setBalance(withdrawalVaultAddress, step.withdrawalVaultBalance);
    await lido.mock__setContractVersion(4n);
    await lido.mock__setBalanceStats(step.clValidatorsBalance, step.clPendingBalance, step.deposits, step.deposits);

    await expect(checker.migrateBaselineSnapshot(), `migration '${step.label}'`).not.to.be.reverted;
    state.lastVaultBalanceAfterTransfer = step.withdrawalVaultBalance;
  };

  const callCheck = (
    checker: OracleReportSanityChecker,
    accountingSigner: HardhatEthersSigner,
    state: ScenarioState,
    report: OracleReportFixture,
  ) => {
    const { cl, movements, timeElapsed } = report;
    const withdrawalVaultBalance = state.lastVaultBalanceAfterTransfer + movements.clWithdrawals;

    return checker
      .connect(accountingSigner)
      .checkAccountingOracleReport(
        timeElapsed,
        cl.preValidatorsBalance,
        cl.prePendingBalance,
        cl.postValidatorsBalance,
        cl.postPendingBalance,
        withdrawalVaultBalance,
        0n,
        0n,
        movements.deposits,
        movements.clWithdrawals,
      );
  };

  const runAcceptedReportStep = async (
    checker: OracleReportSanityChecker,
    accountingSigner: HardhatEthersSigner,
    withdrawalVaultAddress: string,
    state: ScenarioState,
    report: OracleReportFixture,
    title: string,
  ) => {
    const withdrawalVaultBalance = state.lastVaultBalanceAfterTransfer + report.movements.clWithdrawals;
    await setBalance(withdrawalVaultAddress, withdrawalVaultBalance);

    await expect(callCheck(checker, accountingSigner, state, report), `${title}: setup report '${report.label}'`).not.to
      .be.reverted;
    state.lastVaultBalanceAfterTransfer = withdrawalVaultBalance - report.movements.clWithdrawals;
  };

  for (const fixtureSet of negativeRebaseFormulaFixtureSets) {
    describe(fixtureSet.title, () => {
      for (const testCase of fixtureSet.cases) {
        it(testCase.title, async () => {
          const limits = { ...fixtureSet.limits, ...testCase.limits };
          const { checker, accountingSigner, lido, withdrawalVaultAddress } = await deployChecker(limits);
          const checkedStep = testCase.steps[testCase.steps.length - 1];
          expect(checkedStep.kind, `${testCase.title}: checked step`).to.equal("report");
          const checkedReport = checkedStep as OracleReportFixture;
          const setupSteps = testCase.steps.slice(0, -1);
          const expected = calcExpectedWindowDiff(buildStoredReportsModel(testCase.steps), limits);
          const state: ScenarioState = { lastVaultBalanceAfterTransfer: 0n };

          if (testCase.expected.window !== undefined) {
            expect(expected.actualCLBalanceDiff, `${testCase.title}: actualCLBalanceDiff`).to.equal(
              testCase.expected.window.actualCLBalanceDiff,
            );
            expect(expected.maxAllowedCLBalanceDiff, `${testCase.title}: maxAllowedCLBalanceDiff`).to.equal(
              testCase.expected.window.maxAllowedCLBalanceDiff,
            );
          }

          for (const step of setupSteps) {
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

          const withdrawalVaultBalance = state.lastVaultBalanceAfterTransfer + checkedReport.movements.clWithdrawals;
          await setBalance(withdrawalVaultAddress, withdrawalVaultBalance);

          if (testCase.expected.outcome === "revert") {
            await expect(callCheck(checker, accountingSigner, state, checkedReport))
              .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
              .withArgs(expected.actualCLBalanceDiff, expected.maxAllowedCLBalanceDiff);
          } else if (testCase.expected.window !== undefined && testCase.expected.window.actualCLBalanceDiff > 0n) {
            await expect(callCheck(checker, accountingSigner, state, checkedReport))
              .to.emit(checker, "NegativeCLRebaseAccepted")
              .withArgs(0n, expected.postCLBalance, expected.actualCLBalanceDiff, expected.maxAllowedCLBalanceDiff);
          } else {
            await expect(callCheck(checker, accountingSigner, state, checkedReport)).not.to.be.reverted;
          }
        });
      }
    });
  }
});
