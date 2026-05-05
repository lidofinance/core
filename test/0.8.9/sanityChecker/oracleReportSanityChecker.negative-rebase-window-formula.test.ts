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

import {
  negativeRebaseWindowFormulaCases,
  OracleReportFixture,
} from "./oracleReportSanityChecker.negative-rebase-window-formula.fixtures";

const MAX_BASIS_POINTS = 10_000n;
const MAX_CL_BALANCE_DECREASE_BP = 360n;
const DAY = 24n * 60n * 60n;
const CL_BALANCE_WINDOW = 36n * DAY;

type StoredReportModel = {
  timestamp: bigint;
  postCLBalance: bigint;
  deposits: bigint;
  clWithdrawals: bigint;
};

describe("OracleReportSanityChecker.sol: negative rebase window formula", () => {
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

  const maxDiffFor = (recreatedPostCLBalance: bigint) =>
    (recreatedPostCLBalance * MAX_CL_BALANCE_DECREASE_BP) / MAX_BASIS_POINTS;

  const buildStoredReportsModel = (reports: OracleReportFixture[]) => {
    let timestamp = 0n;

    return reports.map((report) => {
      timestamp += report.timeElapsed;

      return {
        timestamp,
        postCLBalance: report.cl.postValidatorsBalance + report.cl.postPendingBalance,
        deposits: report.movements.deposits,
        clWithdrawals: report.movements.clWithdrawals,
      };
    });
  };

  const calcExpectedWindowDiff = (storedReports: StoredReportModel[]) => {
    const lastIndex = storedReports.length - 1;
    const lastTimestamp = storedReports[lastIndex].timestamp;
    const windowStart = lastTimestamp > CL_BALANCE_WINDOW ? lastTimestamp - CL_BALANCE_WINDOW : 0n;

    let baselineIndex = lastIndex;
    while (baselineIndex > 0 && storedReports[baselineIndex - 1].timestamp >= windowStart) {
      --baselineIndex;
    }

    const baselineCLBalance = storedReports[baselineIndex].postCLBalance;
    const currentPostCLBalance = storedReports[lastIndex].postCLBalance;
    let totalDeposits = 0n;
    let totalCLWithdrawals = 0n;

    for (let i = baselineIndex + 1; i <= lastIndex; ++i) {
      totalDeposits += storedReports[i].deposits;
      totalCLWithdrawals += storedReports[i].clWithdrawals;
    }

    const recreatedPostCLBalance = baselineCLBalance + totalDeposits - totalCLWithdrawals;
    const actualCLBalanceDiff =
      recreatedPostCLBalance > currentPostCLBalance ? recreatedPostCLBalance - currentPostCLBalance : 0n;

    return {
      postCLBalance: currentPostCLBalance,
      actualCLBalanceDiff,
      maxAllowedCLBalanceDiff: maxDiffFor(recreatedPostCLBalance),
    };
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

  for (const testCase of negativeRebaseWindowFormulaCases) {
    it(testCase.title, async () => {
      const checkedReport = testCase.reports[testCase.reports.length - 1];
      const setupReports = testCase.reports.slice(0, -1);
      const expected = calcExpectedWindowDiff(buildStoredReportsModel(testCase.reports));

      for (const report of setupReports) {
        await expect(callCheck(report)).not.to.be.reverted;
      }

      if (testCase.expectedOutcome === "revert") {
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
