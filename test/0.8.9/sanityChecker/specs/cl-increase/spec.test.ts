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

import { ether, impersonate, randomAddress } from "lib";

import {
  deployFinalizeUpgradeV4Checker,
  FinalizeUpgradeV4CheckerFixture,
  hasFinalizeUpgradeV4State,
  LidoBalanceStats,
  migrateFinalizeUpgradeV4State,
  MigrationStep,
  moveToFirstPostMigrationReportFrame,
  resolveScenarioSteps,
  setLastVaultBalanceAfterTransfer,
} from "../lib";

import { clIncreaseFixtureSets } from "./fixtures/index";
import { calcClIncreaseFormula, ClIncreaseCase, OracleReportLimits, ResolvedClIncreaseReport } from "./lib";

describe("OracleReportSanityChecker.sol: CL increase formula specs", () => {
  type MockCheckerFixture = {
    checker: OracleReportSanityChecker;
    accountingSigner: HardhatEthersSigner;
    lido: Lido__MockForSanityChecker;
    withdrawalVaultAddress: string;
  };

  type CheckerFixture =
    | (MockCheckerFixture & { kind: "mock" })
    | (FinalizeUpgradeV4CheckerFixture & { kind: "finalizeUpgradeV4" });

  const deployMockChecker = async (limitsList: OracleReportLimits): Promise<MockCheckerFixture> => {
    const [deployer] = await ethers.getSigners();
    const withdrawalVaultAddress = randomAddress();
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
        withdrawalVault: withdrawalVaultAddress,
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
    migrationSameFrameStats?: LidoBalanceStats;
  };

  const runMigrationStep = async (fixture: CheckerFixture, state: ScenarioState, step: MigrationStep) => {
    if (fixture.kind === "finalizeUpgradeV4") {
      state.migrationSameFrameStats = await migrateFinalizeUpgradeV4State(fixture, step);
    } else {
      await setBalance(fixture.withdrawalVaultAddress, step.withdrawalVaultBalance);
      await fixture.lido.mock__setContractVersion(4n);
      await fixture.lido.mock__setBalanceStats(
        step.clValidatorsBalance,
        step.clPendingBalance,
        step.deposits,
        step.deposits,
      );

      await expect(fixture.checker.migrateBaselineSnapshot(), `migration '${step.label}'`).not.to.be.reverted;
    }
    state.lastVaultBalanceAfterTransfer = step.withdrawalVaultBalance;
  };

  const callAccountingReport = (
    checker: OracleReportSanityChecker,
    accountingSigner: HardhatEthersSigner,
    state: ScenarioState,
    report: ResolvedClIncreaseReport,
  ) => {
    const withdrawalVaultBalance = state.lastVaultBalanceAfterTransfer + report.movements.clWithdrawals;
    const withdrawalsVaultTransfer = report.movements.withdrawalsVaultTransfer ?? report.movements.clWithdrawals;

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
        withdrawalsVaultTransfer,
      );
  };

  const runAcceptedReportStep = async (
    checker: OracleReportSanityChecker,
    accountingSigner: HardhatEthersSigner,
    withdrawalVaultAddress: string,
    state: ScenarioState,
    report: ResolvedClIncreaseReport,
    title: string,
  ) => {
    const withdrawalVaultBalance = state.lastVaultBalanceAfterTransfer + report.movements.clWithdrawals;
    await setBalance(withdrawalVaultAddress, withdrawalVaultBalance);

    await expect(
      callAccountingReport(checker, accountingSigner, state, report),
      `${title}: setup report '${report.label}'`,
    ).not.to.be.reverted;
    state.lastVaultBalanceAfterTransfer =
      withdrawalVaultBalance - (report.movements.withdrawalsVaultTransfer ?? report.movements.clWithdrawals);
  };

  const expectFormulaFields = (testCase: ClIncreaseCase, formula: ReturnType<typeof calcClIncreaseFormula>) => {
    const expectedFormula = testCase.expected.formula;
    if (expectedFormula === undefined) return;

    for (const [field, value] of Object.entries(expectedFormula)) {
      expect(formula[field as keyof typeof formula], `${testCase.title}: ${field}`).to.equal(value);
    }
  };

  const callPendingBalanceCheck = (
    checker: OracleReportSanityChecker,
    state: ScenarioState,
    report: ResolvedClIncreaseReport,
  ) => {
    const withdrawalVaultBalance = state.lastVaultBalanceAfterTransfer + report.movements.clWithdrawals;

    return checker.checkCLPendingBalanceIncrease(
      report.timeElapsed,
      report.cl.preValidatorsBalance,
      report.cl.prePendingBalance,
      report.cl.postValidatorsBalance,
      report.cl.postPendingBalance,
      withdrawalVaultBalance,
      report.movements.deposits,
    );
  };

  const withPostValidatorsBalance = (
    report: ResolvedClIncreaseReport,
    postValidatorsBalance: bigint,
  ): ResolvedClIncreaseReport => ({
    ...report,
    cl: {
      ...report.cl,
      postValidatorsBalance,
    },
  });

  const getPreValidatorsAfterWithdrawals = (report: ResolvedClIncreaseReport) =>
    report.movements.clWithdrawals >= report.cl.preValidatorsBalance
      ? 0n
      : report.cl.preValidatorsBalance - report.movements.clWithdrawals;

  for (const fixtureSet of clIncreaseFixtureSets) {
    describe(fixtureSet.title, () => {
      for (const testCase of fixtureSet.cases) {
        it(testCase.title, async () => {
          const limits = { ...fixtureSet.limits, ...testCase.limits };
          const steps = resolveScenarioSteps(testCase.steps);
          const useFinalizeUpgradeV4 = steps.some(
            (step) => step.kind === "migration" && hasFinalizeUpgradeV4State(step),
          );
          const fixture = await deployChecker(limits, useFinalizeUpgradeV4);
          const { checker, accountingSigner, withdrawalVaultAddress } = fixture;
          const checkedStep = steps[steps.length - 1];
          expect(checkedStep.kind, `${testCase.title}: checked step`).to.equal("report");
          const checkedReport = checkedStep as ResolvedClIncreaseReport;
          const state: ScenarioState = { lastVaultBalanceAfterTransfer: 0n };

          for (const step of steps.slice(0, -1)) {
            if (step.kind === "migration") {
              await runMigrationStep(fixture, state, step);

              const expectedFrame = testCase.expected.migrationFrame;
              if (expectedFrame !== undefined) {
                expect(
                  state.migrationSameFrameStats?.depositedForCurrentReport,
                  `${testCase.title}: same-frame deposits`,
                ).to.equal(expectedFrame.sameFrameDepositsForReport);
                expect(
                  (state.migrationSameFrameStats?.clPendingBalanceAtLastReport ?? 0n) +
                    (state.migrationSameFrameStats?.depositedForCurrentReport ?? 0n),
                  `${testCase.title}: same-frame funded pending`,
                ).to.equal(expectedFrame.sameFrameFundedPendingBalance);

                expect(fixture.kind, `${testCase.title}: first post-migration frame`).to.equal("finalizeUpgradeV4");
                const firstPostMigrationFrameStats = await moveToFirstPostMigrationReportFrame(
                  fixture as FinalizeUpgradeV4CheckerFixture,
                );
                expect(
                  firstPostMigrationFrameStats.depositedForCurrentReport,
                  `${testCase.title}: first-frame deposits`,
                ).to.equal(expectedFrame.firstPostMigrationFrameDepositsForReport);
                expect(
                  firstPostMigrationFrameStats.clPendingBalanceAtLastReport +
                    firstPostMigrationFrameStats.depositedForCurrentReport,
                  `${testCase.title}: first-frame funded pending`,
                ).to.equal(expectedFrame.firstPostMigrationFrameFundedPendingBalance);
              }
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
          const call = callPendingBalanceCheck(checker, state, checkedReport);

          expectFormulaFields(testCase, formula);

          if (testCase.expected.outcome === "accepted") {
            await expect(call).not.to.be.reverted;

            if (testCase.expected.counterfactualZeroVaultBaseline) {
              const withdrawalVaultBalance =
                state.lastVaultBalanceAfterTransfer + checkedReport.movements.clWithdrawals;
              const counterfactualFormula = calcClIncreaseFormula(
                {
                  ...checkedReport,
                  movements: {
                    ...checkedReport.movements,
                    clWithdrawals: withdrawalVaultBalance,
                  },
                },
                limits,
              );

              await setBalance(withdrawalVaultAddress, withdrawalVaultBalance);
              await setLastVaultBalanceAfterTransfer(checker, 0n);
              await expect(
                callAccountingReport(
                  checker,
                  accountingSigner,
                  { lastVaultBalanceAfterTransfer: withdrawalVaultBalance },
                  checkedReport,
                ),
              )
                .to.be.revertedWithCustomError(checker, "IncorrectTotalCLBalanceIncrease")
                .withArgs(counterfactualFormula.validatorsGrowthLimit, counterfactualFormula.validatorsBalanceIncrease);
            }
          } else if (testCase.expected.outcome === "IncorrectTotalPendingBalance") {
            await expect(call)
              .to.be.revertedWithCustomError(checker, "IncorrectTotalPendingBalance")
              .withArgs(formula.pendingBalanceCap, checkedReport.cl.postPendingBalance);
          } else if (testCase.expected.outcome === "IncorrectTotalActivatedBalance") {
            await expect(call)
              .to.be.revertedWithCustomError(checker, "IncorrectTotalActivatedBalance")
              .withArgs(formula.appearedBalanceLimit, formula.activatedBalance);
          } else if (testCase.expected.outcome === "validatorsGrowthBoundary") {
            const atLimitReport = withPostValidatorsBalance(
              checkedReport,
              getPreValidatorsAfterWithdrawals(checkedReport) + formula.validatorsGrowthLimit,
            );
            const excessiveReport = withPostValidatorsBalance(
              checkedReport,
              getPreValidatorsAfterWithdrawals(checkedReport) + formula.validatorsGrowthLimit + 1n,
            );

            await expect(callPendingBalanceCheck(checker, state, atLimitReport)).not.to.be.reverted;
            await expect(callPendingBalanceCheck(checker, state, excessiveReport))
              .to.be.revertedWithCustomError(checker, "IncorrectTotalCLBalanceIncrease")
              .withArgs(formula.validatorsGrowthLimit, formula.validatorsGrowthLimit + 1n);
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
