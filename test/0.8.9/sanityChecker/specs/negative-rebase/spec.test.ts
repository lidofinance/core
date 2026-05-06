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

import { negativeRebaseFormulaCases } from "./fixtures";
import {
  buildStoredReportsModel,
  calcExpectedWindowDiff,
  MAX_CL_BALANCE_DECREASE_BP,
  OracleReportFixture,
} from "./lib";

describe("OracleReportSanityChecker.sol: negative rebase formula specs", () => {
  let checker: OracleReportSanityChecker;
  let accounting: Accounting__MockForSanityChecker;
  let accountingOracle: AccountingOracle__MockForSanityChecker;
  let deployer: HardhatEthersSigner;
  let withdrawalVault: HardhatEthersSigner;
  let accountingSigner: HardhatEthersSigner;

  const defaultLimitsList = {
    exitedEthAmountPerDayLimit: 50n,
    appearedEthAmountPerDayLimit: 75n,
    annualBalanceIncreaseBPLimit: 10_00n,
    simulatedShareRateDeviationBPLimit: 2_00n,
    maxBalanceExitRequestedPerReportInEth: 64_000n,
    maxEffectiveBalanceWeightWCType01: 32n,
    maxEffectiveBalanceWeightWCType02: 2_048n,
    maxItemsPerExtraDataTransaction: 15n,
    maxNodeOperatorsPerExtraDataItem: 16n,
    requestTimestampMargin: 128n,
    maxPositiveTokenRebase: 5_000_000n,
    maxCLBalanceDecreaseBP: MAX_CL_BALANCE_DECREASE_BP,
    clBalanceOraclesErrorUpperBPLimit: 50n,
    consolidationEthAmountPerDayLimit: 0n,
    exitedValidatorEthAmountLimit: 1n,
    externalPendingBalanceCapEth: 0n,
  };

  beforeEach(async () => {
    [deployer, withdrawalVault] = await ethers.getSigners();
    await setBalance(withdrawalVault.address, ether("10000"));

    const burner = await ethers.deployContract("Burner__MockForSanityChecker", []);
    accounting = await ethers.deployContract("Accounting__MockForSanityChecker", []);
    accountingOracle = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
      deployer.address,
      12,
      1_606_824_023,
    ]);
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

    checker = await ethers.deployContract("OracleReportSanityChecker", [
      await locator.getAddress(),
      await accounting.getAddress(),
      deployer.address,
      defaultLimitsList,
    ]);

    accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
  });

  const callCheck = (report: OracleReportFixture) => {
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

  for (const testCase of negativeRebaseFormulaCases) {
    it(testCase.title, async () => {
      const checkedReport = testCase.reports[testCase.reports.length - 1];
      const setupReports = testCase.reports.slice(0, -1);
      const expected = calcExpectedWindowDiff(buildStoredReportsModel(testCase.reports));

      if (testCase.expected.window !== undefined) {
        expect(expected.actualCLBalanceDiff, `${testCase.title}: actualCLBalanceDiff`).to.equal(
          testCase.expected.window.actualCLBalanceDiff,
        );
        expect(expected.maxAllowedCLBalanceDiff, `${testCase.title}: maxAllowedCLBalanceDiff`).to.equal(
          testCase.expected.window.maxAllowedCLBalanceDiff,
        );
      }

      for (const report of setupReports) {
        await expect(callCheck(report), `${testCase.title}: setup report '${report.label}'`).not.to.be.reverted;
      }

      if (testCase.expected.outcome === "revert") {
        await expect(callCheck(checkedReport))
          .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
          .withArgs(expected.actualCLBalanceDiff, expected.maxAllowedCLBalanceDiff);
      } else {
        await expect(callCheck(checkedReport))
          .to.emit(checker, "NegativeCLRebaseAccepted")
          .withArgs(0n, expected.postCLBalance, expected.actualCLBalanceDiff, expected.maxAllowedCLBalanceDiff);
      }
    });
  }
});
