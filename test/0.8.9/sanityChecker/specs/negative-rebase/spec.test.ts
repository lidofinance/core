import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForSanityChecker,
  Lido__MockForSanityChecker,
  OracleReportSanityChecker,
  OracleReportSanityCheckerWrapper,
} from "typechain-types";

import { ether, impersonate, randomAddress } from "lib";

import {
  deployFinalizeUpgradeV4Checker,
  FinalizeUpgradeV4CheckerFixture,
  getMigrationCLValidatorsBalance,
  hasFinalizeUpgradeV4State,
  migrateFinalizeUpgradeV4State,
  MigrationStep,
  resolveScenarioSteps,
} from "../lib";

import { negativeRebaseFormulaFixtureSets } from "./fixtures/index";
import {
  buildStoredReportsModel,
  calcExpectedWindowDiff,
  CL_BALANCE_WINDOW,
  OracleReportLimits,
  ResolvedNegativeRebaseStep,
  ResolvedOracleReportFixture,
} from "./lib";

describe("OracleReportSanityChecker.sol: negative rebase formula specs", () => {
  type MockCheckerFixture = {
    checker: OracleReportSanityChecker;
    accountingSigner: HardhatEthersSigner;
    accountingOracle: AccountingOracle__MockForSanityChecker;
    lido: Lido__MockForSanityChecker;
    withdrawalVaultAddress: string;
  };

  type CheckerFixture =
    | (MockCheckerFixture & { kind: "mock" })
    | (FinalizeUpgradeV4CheckerFixture & { kind: "finalizeUpgradeV4" });

  const deployMockChecker = async (limitsList: OracleReportLimits): Promise<MockCheckerFixture> => {
    const [deployer] = await ethers.getSigners();
    const withdrawalVaultAddress = randomAddress();
    await setBalance(withdrawalVaultAddress, ether("10000"));

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
        withdrawalVault: withdrawalVaultAddress,
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

    const checker = (await ethers.deployContract("OracleReportSanityCheckerWrapper", [
      await locator.getAddress(),
      await accounting.getAddress(),
      deployer.address,
      limitsList,
      false,
    ])) as OracleReportSanityCheckerWrapper;
    await checker.harness__setLastReportTimestamp(CL_BALANCE_WINDOW);

    return {
      checker,
      accountingSigner: await impersonate(await accounting.getAddress(), ether("1")),
      accountingOracle,
      lido,
      withdrawalVaultAddress,
    };
  };

  const deployChecker = async (limitsList: OracleReportLimits, useFinalizeUpgradeV4: boolean) => {
    if (useFinalizeUpgradeV4) {
      return { ...(await deployFinalizeUpgradeV4Checker(limitsList)), kind: "finalizeUpgradeV4" } as CheckerFixture;
    }

    return { ...(await deployMockChecker(limitsList)), kind: "mock" } as CheckerFixture;
  };

  type ScenarioState = {
    lastVaultBalanceAfterTransfer: bigint;
  };

  const runMigrationStep = async (fixture: CheckerFixture, state: ScenarioState, step: MigrationStep) => {
    if (fixture.kind === "finalizeUpgradeV4") {
      await migrateFinalizeUpgradeV4State(fixture, step);
    } else {
      await setBalance(fixture.withdrawalVaultAddress, step.withdrawalVaultBalance);
      await fixture.lido.mock__setContractVersion(4n);
      await fixture.lido.mock__setBalanceStats(getMigrationCLValidatorsBalance(step), 0n, 0n, 0n);

      await expect(fixture.checker.migrateBaselineSnapshot(), `migration '${step.label}'`).not.to.be.reverted;
    }

    const migrationCLBalance = getMigrationCLValidatorsBalance(step);
    const expectedMigrationTimestamp =
      (await fixture.accountingOracle.GENESIS_TIME()) +
      (await fixture.accountingOracle.getLastProcessingRefSlot()) * (await fixture.accountingOracle.SECONDS_PER_SLOT());
    expect(await fixture.checker.getReportDataCount(), `${step.label}: migration report data count`).to.equal(2n);

    const baselineData = await fixture.checker.reportData(0n);
    expect(baselineData.timestamp, `${step.label}: migration baseline timestamp`).to.equal(expectedMigrationTimestamp);
    expect(baselineData.clBalance, `${step.label}: migration baseline ignores transient deposits`).to.equal(
      migrationCLBalance,
    );
    expect(baselineData.deposits, `${step.label}: migration baseline stores zero deposits`).to.equal(0n);
    expect(baselineData.clWithdrawals, `${step.label}: migration baseline stores zero withdrawals`).to.equal(0n);

    const bootstrapFlowData = await fixture.checker.reportData(1n);
    expect(bootstrapFlowData.clBalance, `${step.label}: bootstrap snapshot ignores transient deposits`).to.equal(
      migrationCLBalance - step.withdrawalVaultBalance,
    );
    expect(bootstrapFlowData.timestamp, `${step.label}: bootstrap snapshot timestamp`).to.equal(
      expectedMigrationTimestamp,
    );
    expect(bootstrapFlowData.deposits, `${step.label}: bootstrap snapshot stores zero deposits`).to.equal(0n);
    expect(bootstrapFlowData.clWithdrawals, `${step.label}: bootstrap snapshot stores migration withdrawals`).to.equal(
      step.withdrawalVaultBalance,
    );

    state.lastVaultBalanceAfterTransfer = step.withdrawalVaultBalance;
  };

  const callCheck = (
    checker: OracleReportSanityChecker,
    accountingSigner: HardhatEthersSigner,
    state: ScenarioState,
    report: ResolvedOracleReportFixture,
  ) => {
    const { cl, movements, timeElapsed } = report;
    const withdrawalVaultBalance = state.lastVaultBalanceAfterTransfer + movements.clWithdrawals;
    const withdrawalsVaultTransfer = movements.withdrawalsVaultTransfer ?? movements.clWithdrawals;

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
        withdrawalsVaultTransfer,
      );
  };

  const runAcceptedReportStep = async (
    checker: OracleReportSanityChecker,
    accountingSigner: HardhatEthersSigner,
    withdrawalVaultAddress: string,
    state: ScenarioState,
    report: ResolvedOracleReportFixture,
    title: string,
  ) => {
    const withdrawalVaultBalance = state.lastVaultBalanceAfterTransfer + report.movements.clWithdrawals;
    await setBalance(withdrawalVaultAddress, withdrawalVaultBalance);

    await expect(callCheck(checker, accountingSigner, state, report), `${title}: setup report '${report.label}'`).not.to
      .be.reverted;
    state.lastVaultBalanceAfterTransfer =
      withdrawalVaultBalance - (report.movements.withdrawalsVaultTransfer ?? report.movements.clWithdrawals);
  };

  for (const fixtureSet of negativeRebaseFormulaFixtureSets) {
    describe(fixtureSet.title, () => {
      for (const testCase of fixtureSet.cases) {
        it(testCase.title, async () => {
          const limits = { ...fixtureSet.limits, ...testCase.limits };
          const steps = resolveScenarioSteps(testCase.steps) as ResolvedNegativeRebaseStep[];
          const useFinalizeUpgradeV4 = steps.some(
            (step) => step.kind === "migration" && hasFinalizeUpgradeV4State(step),
          );
          const fixture = await deployChecker(limits, useFinalizeUpgradeV4);
          const { checker, accountingSigner, withdrawalVaultAddress } = fixture;
          const checkedStep = steps[steps.length - 1];
          expect(checkedStep.kind, `${testCase.title}: checked step`).to.equal("report");
          const checkedReport = checkedStep as ResolvedOracleReportFixture;
          const setupSteps = steps.slice(0, -1);
          const expected = calcExpectedWindowDiff(buildStoredReportsModel(steps), limits);
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
              await runMigrationStep(fixture, state, step);
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
            const refSlot = await fixture.accountingOracle.getLastProcessingRefSlot();
            await expect(callCheck(checker, accountingSigner, state, checkedReport))
              .to.emit(checker, "NegativeCLRebaseAccepted")
              .withArgs(
                refSlot,
                expected.postCLBalance,
                expected.actualCLBalanceDiff,
                expected.maxAllowedCLBalanceDiff,
              );
          } else {
            await expect(callCheck(checker, accountingSigner, state, checkedReport)).not.to.be.reverted;
          }

          if (testCase.expected.lastReportCLWithdrawals !== undefined) {
            const reportDataCount = await checker.getReportDataCount();
            const lastReportData = await checker.reportData(reportDataCount - 1n);
            expect(lastReportData.clWithdrawals, `${testCase.title}: stored clWithdrawals`).to.equal(
              testCase.expected.lastReportCLWithdrawals,
            );
          }

          if (
            testCase.expected.lastReportCLBalance !== undefined ||
            testCase.expected.lastReportDeposits !== undefined
          ) {
            const reportDataCount = await checker.getReportDataCount();
            const lastReportData = await checker.reportData(reportDataCount - 1n);

            if (testCase.expected.lastReportCLBalance !== undefined) {
              expect(lastReportData.clBalance, `${testCase.title}: stored first-report CL balance`).to.equal(
                testCase.expected.lastReportCLBalance,
              );
            }

            if (testCase.expected.lastReportDeposits !== undefined) {
              expect(lastReportData.deposits, `${testCase.title}: stored first-report deposits`).to.equal(
                testCase.expected.lastReportDeposits,
              );
            }
          }
        });
      }
    });
  }
});
