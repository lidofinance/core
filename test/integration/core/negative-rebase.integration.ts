import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { ether, impersonate } from "lib";
import {
  getDepositedSinceLastReport,
  getProtocolContext,
  ProtocolContext,
  reportWithEffectiveClDiff,
  resetCLBalanceDecreaseWindow,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: Negative rebase", () => {
  let ctx: ProtocolContext;
  let ethHolder: HardhatEthersSigner;

  let snapshot: string;
  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();

    snapshot = await Snapshot.take();

    [ethHolder] = await ethers.getSigners();
    await setBalance(ethHolder.address, ether("1000000"));
    const network = await ethers.provider.getNetwork();

    // In case of sepolia network, transfer some BEPOLIA tokens to the adapter contract
    if (network.name == "sepolia" || network.name == "sepolia-fork") {
      const sepoliaDepositContractAddress = "0x7f02C3E3c98b133055B8B348B2Ac625669Ed295D";
      const bepoliaWhaleHolder = "0xf97e180c050e5Ab072211Ad2C213Eb5AEE4DF134";
      const BEPOLIA_TO_TRANSFER = 20;

      const bepoliaToken = await ethers.getContractAt("ISepoliaDepositContract", sepoliaDepositContractAddress);
      const bepoliaSigner = await ethers.getImpersonatedSigner(bepoliaWhaleHolder);

      const adapterAddr = await ctx.contracts.stakingRouter.DEPOSIT_CONTRACT();
      await bepoliaToken.connect(bepoliaSigner).transfer(adapterAddr, BEPOLIA_TO_TRANSFER);
    }
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot)); // Rollback to the initial state pre deployment

  const exitedValidatorsCount = async () => {
    const ids = await ctx.contracts.stakingRouter.getStakingModuleIds();
    const exited = new Map<bigint, bigint>();
    for (const id of ids) {
      const module = await ctx.contracts.stakingRouter.getStakingModule(id);
      exited.set(id, module["exitedValidatorsCount"]);
    }
    return exited;
  };

  const ensureAtLeastOneStoredReport = async () => {
    const reportDataCount = await ctx.contracts.oracleReportSanityChecker.getReportDataCount();
    if (reportDataCount === 0n) {
      await reportWithEffectiveClDiff(ctx, 0n, {
        skipWithdrawals: true,
        excludeVaultsBalances: true,
      });
    }
  };

  it("Should store correctly exited validators count", async () => {
    const { locator, oracleReportSanityChecker } = ctx.contracts;

    expect(await locator.oracleReportSanityChecker()).to.equal(oracleReportSanityChecker.address);

    const currentExited = await exitedValidatorsCount();
    const reportExitedValidators = currentExited.get(1n) ?? 0n;
    await ensureAtLeastOneStoredReport();
    const reportDataCountBefore = await oracleReportSanityChecker.getReportDataCount();

    // On Hoodi after the SRv3 migration, Lido has pending deposits.
    // `report(ctx, { clDiff: 0 })` means raw postCL - preCL = 0, which looks
    // to the sanity checker like a CL decrease by the amount of those deposits.
    // This report must be effective-neutral relative to principal CL balance.
    await reportWithEffectiveClDiff(ctx, 0n, {
      skipWithdrawals: true,
      clAppearedValidators: 0n,
      reportElVault: false,
      stakingModuleIdsWithNewlyExitedValidators: [1n],
      numExitedValidatorsByStakingModule: [reportExitedValidators + 2n],
    });

    const reportDataCountAfter = await oracleReportSanityChecker.getReportDataCount();
    expect(reportDataCountAfter).to.equal(reportDataCountBefore + 1n);

    const updatedExited = await exitedValidatorsCount();
    const updatedExitedForModule = updatedExited.get(1n) ?? 0n;
    const totalExitedBefore = Array.from(currentExited.values()).reduce((acc, val) => acc + val, 0n);
    const totalExitedAfter = Array.from(updatedExited.values()).reduce((acc, val) => acc + val, 0n);

    expect(updatedExitedForModule).to.be.equal(reportExitedValidators + 2n);
    expect(totalExitedAfter).to.be.equal(totalExitedBefore + 2n);
  });

  it("Should store correctly many negative rebases", async () => {
    const { locator, oracleReportSanityChecker } = ctx.contracts;

    expect(await locator.oracleReportSanityChecker()).to.equal(oracleReportSanityChecker.address);

    // After migration, the sanity checker stores the current withdrawal vault balance as baseline.
    // The reset report must not report the withdrawal vault as 0, otherwise `_getCLWithdrawals`
    // fails before the negative rebase check.
    await resetCLBalanceDecreaseWindow(ctx, {
      excludeVaultsBalances: false,
      reportElVault: false,
    });
    await ensureAtLeastOneStoredReport();

    const REPORTS_REPEATED = 10;
    const CL_DIFF_PER_REPORT = -1000000000n; // effective -1 gwei per report relative to principal CL balance
    let reportDataCount = await oracleReportSanityChecker.getReportDataCount();
    expect(reportDataCount).to.be.gt(0n);
    let previousCLBalance = (await oracleReportSanityChecker.reportData(reportDataCount - 1n)).clBalance;

    for (let i = 0; i < REPORTS_REPEATED; i++) {
      const depositedSinceLastReport = await getDepositedSinceLastReport(ctx);

      await reportWithEffectiveClDiff(ctx, CL_DIFF_PER_REPORT, {
        skipWithdrawals: true,
        reportElVault: false,
      });

      reportDataCount += 1n;
      const reportCountAfter = await oracleReportSanityChecker.getReportDataCount();
      expect(reportCountAfter).to.equal(reportDataCount);

      const lastReportData = await oracleReportSanityChecker.reportData(reportDataCount - 1n);
      const expectedCurrentCLBalance = previousCLBalance + depositedSinceLastReport + CL_DIFF_PER_REPORT;

      expect(lastReportData.clBalance).to.equal(expectedCurrentCLBalance);
      expect(lastReportData.clBalance).to.be.lt(previousCLBalance + depositedSinceLastReport);
      previousCLBalance = lastReportData.clBalance;
    }
  });

  // Tests the sliding window CL decrease check by calling checkAccountingOracleReport
  // directly with zero deposits/withdrawals (so adjustedBase == raw baseline balance).
  it("Should revert with IncorrectCLBalanceDecrease on gradual negative rebases", async () => {
    const { oracleReportSanityChecker, accounting, withdrawalVault } = ctx.contracts;

    const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
    const withdrawalVaultBalance = await ethers.provider.getBalance(withdrawalVault);

    const reportDataCount = await oracleReportSanityChecker.getReportDataCount();
    let currentBalance =
      reportDataCount === 0n
        ? ether("1000000")
        : (await oracleReportSanityChecker.reportData(reportDataCount - 1n)).clBalance;

    // This direct call bypasses helper report(), so it must pass the reported withdrawal vault balance itself.
    // On Hoodi after migration, the sanity checker baseline is non-zero; passing 0 here masks
    // the intended IncorrectCLBalanceDecrease check with a withdrawal vault balance error.
    const reportFromAccounting = (preBalance: bigint, postBalance: bigint) =>
      oracleReportSanityChecker
        .connect(accountingSigner)
        .checkAccountingOracleReport(
          24n * 60n * 60n,
          preBalance,
          0n,
          postBalance,
          0n,
          withdrawalVaultBalance,
          0n,
          0n,
          0n,
          0n,
        );

    // REPORTS_WINDOW in contract is 36 (private constant, no getter).
    // Fill window + 1 neutral data points to fully control the baseline.
    const REPORTS_WINDOW = 36;
    for (let i = 0; i < REPORTS_WINDOW + 1; ++i) {
      await reportFromAccounting(currentBalance, currentBalance);
    }

    // Derive the number of 1% decreases that fit under the limit from the actual config.
    const limits = await oracleReportSanityChecker.getOracleReportLimits();
    const maxDecreaseBP = limits.maxCLBalanceDecreaseBP;
    const DECREASE_PER_REPORT_BP = 100n; // 1%

    let passingReports = 0;
    let cumulativeBalanceBP = 10_000n;
    while (true) {
      const next = cumulativeBalanceBP - (cumulativeBalanceBP * DECREASE_PER_REPORT_BP) / 10_000n;
      if (10_000n - next > maxDecreaseBP) break;
      cumulativeBalanceBP = next;
      passingReports++;
    }

    for (let i = 0; i < passingReports; ++i) {
      const decreasedBalance = currentBalance - (currentBalance * DECREASE_PER_REPORT_BP) / 10_000n;
      await reportFromAccounting(currentBalance, decreasedBalance);
      currentBalance = decreasedBalance;
    }

    const nextDecreasedBalance = currentBalance - (currentBalance * DECREASE_PER_REPORT_BP) / 10_000n;
    await expect(reportFromAccounting(currentBalance, nextDecreasedBalance)).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "IncorrectCLBalanceDecrease",
    );
  });
});
