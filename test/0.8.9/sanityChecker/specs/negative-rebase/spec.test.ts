import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForSanityChecker,
  OracleReportSanityChecker,
} from "typechain-types";

import { ether, impersonate } from "lib";

import { negativeRebaseFormulaFixtureSets } from "./fixtures/index";
import { buildStoredReportsModel, calcExpectedWindowDiff, OracleReportFixture,OracleReportLimits } from "./lib";

describe("OracleReportSanityChecker.sol: negative rebase formula specs", () => {
  const deployChecker = async (
    limitsList: OracleReportLimits,
  ): Promise<{
    checker: OracleReportSanityChecker;
    accountingSigner: HardhatEthersSigner;
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
    const stakingRouter = await ethers.deployContract("StakingRouter__MockForSanityChecker");

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
    };
  };

  const callCheck = (
    checker: OracleReportSanityChecker,
    accountingSigner: HardhatEthersSigner,
    report: OracleReportFixture,
  ) => {
    const { cl, movements, timeElapsed } = report;

    return checker
      .connect(accountingSigner)
      .checkAccountingOracleReport(
        timeElapsed,
        cl.preValidatorsBalance,
        cl.prePendingBalance,
        cl.postValidatorsBalance,
        cl.postPendingBalance,
        movements.clWithdrawals,
        0n,
        0n,
        movements.deposits,
        movements.clWithdrawals,
      );
  };

  for (const fixtureSet of negativeRebaseFormulaFixtureSets) {
    describe(fixtureSet.title, () => {
      for (const testCase of fixtureSet.cases) {
        it(testCase.title, async () => {
          const limits = { ...fixtureSet.limits, ...testCase.limits };
          const { checker, accountingSigner } = await deployChecker(limits);
          const checkedReport = testCase.reports[testCase.reports.length - 1];
          const setupReports = testCase.reports.slice(0, -1);
          const expected = calcExpectedWindowDiff(buildStoredReportsModel(testCase.reports), limits);

          if (testCase.expected.window !== undefined) {
            expect(expected.actualCLBalanceDiff, `${testCase.title}: actualCLBalanceDiff`).to.equal(
              testCase.expected.window.actualCLBalanceDiff,
            );
            expect(expected.maxAllowedCLBalanceDiff, `${testCase.title}: maxAllowedCLBalanceDiff`).to.equal(
              testCase.expected.window.maxAllowedCLBalanceDiff,
            );
          }

          for (const report of setupReports) {
            await expect(
              callCheck(checker, accountingSigner, report),
              `${testCase.title}: setup report '${report.label}'`,
            ).not.to.be.reverted;
          }

          if (testCase.expected.outcome === "revert") {
            await expect(callCheck(checker, accountingSigner, checkedReport))
              .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
              .withArgs(expected.actualCLBalanceDiff, expected.maxAllowedCLBalanceDiff);
          } else if (testCase.expected.window !== undefined && testCase.expected.window.actualCLBalanceDiff > 0n) {
            await expect(callCheck(checker, accountingSigner, checkedReport))
              .to.emit(checker, "NegativeCLRebaseAccepted")
              .withArgs(0n, expected.postCLBalance, expected.actualCLBalanceDiff, expected.maxAllowedCLBalanceDiff);
          } else {
            await expect(callCheck(checker, accountingSigner, checkedReport)).not.to.be.reverted;
          }
        });
      }
    });
  }
});
