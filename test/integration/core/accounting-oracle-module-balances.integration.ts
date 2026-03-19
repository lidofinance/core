import { expect } from "chai";
import { getBigInt } from "ethers";

import { ether, ONE_GWEI } from "lib";
import {
  depositValidatorsWithoutReport,
  getNextReportContext,
  getProtocolContext,
  getStakingModuleBalances,
  ProtocolContext,
  report,
  submitReportDataWithConsensus,
  updateOracleReportLimits,
} from "lib/protocol";
import { NOR_MODULE_ID, SDVT_MODULE_ID } from "lib/protocol/helpers/staking-module";

import { Snapshot } from "test/suite";

const ONE_DAY = 24n * 60n * 60n;
const ONE_VALIDATOR_BALANCE_ETH = 32n;
const ONE_VALIDATOR_BALANCE = ether("32");
const MAX_BASIS_POINTS = 10_000n;
const REPORTED_MODULE_IDS = [NOR_MODULE_ID, SDVT_MODULE_ID];
const SECONDS_PER_YEAR = 365n * ONE_DAY;

describe("Integration: AccountingOracle module balances sanity", () => {
  let ctx: ProtocolContext;

  let snapshot: string;
  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    await report(ctx);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot));

  it("should accept a report that moves one module's pending balance into validators", async () => {
    const { lido } = ctx.contracts;

    await depositValidatorsWithoutReport(ctx, NOR_MODULE_ID, 1n);

    const balanceStatsBeforeReport = await lido.getBalanceStats();
    const norBefore = await getStakingModuleBalances(ctx, NOR_MODULE_ID);
    const sdvtBefore = await getStakingModuleBalances(ctx, SDVT_MODULE_ID);
    const totalPendingBalanceBeforeGwei = norBefore.pendingBalanceGwei + sdvtBefore.pendingBalanceGwei;
    const totalValidatorsBalanceBeforeGwei = norBefore.validatorsBalanceGwei + sdvtBefore.validatorsBalanceGwei;

    expect(balanceStatsBeforeReport.depositedSinceLastReport).to.equal(ONE_VALIDATOR_BALANCE);

    const pendingConsumedGwei = norBefore.pendingBalanceGwei;
    expect(pendingConsumedGwei).to.be.gt(0n);

    const reportedValidatorsBalancesGwei = [
      norBefore.validatorsBalanceGwei + pendingConsumedGwei,
      sdvtBefore.validatorsBalanceGwei,
    ];
    const reportedPendingBalancesGwei = [0n, sdvtBefore.pendingBalanceGwei];

    const validatorsBalanceAfterGwei = reportedValidatorsBalancesGwei[0] + reportedValidatorsBalancesGwei[1];
    const pendingBalanceAfterGwei = reportedPendingBalancesGwei[0] + reportedPendingBalancesGwei[1];

    expect(validatorsBalanceAfterGwei).to.equal(totalValidatorsBalanceBeforeGwei + pendingConsumedGwei);
    expect(pendingBalanceAfterGwei).to.equal(totalPendingBalanceBeforeGwei - pendingConsumedGwei);

    const { data } = await report(ctx, {
      clDiff: balanceStatsBeforeReport.depositedSinceLastReport,
      dryRun: true,
      excludeVaultsBalances: true,
      pendingBalancesGweiByStakingModule: reportedPendingBalancesGwei,
      skipWithdrawals: true,
      stakingModuleIdsWithUpdatedBalance: REPORTED_MODULE_IDS,
      validatorBalancesGweiByStakingModule: reportedValidatorsBalancesGwei,
      waitNextReportTime: true,
    });

    await expect(submitReportDataWithConsensus(ctx, data)).to.not.be.reverted;
  });

  it("should reject a report whose module validators balances do not add up to the reported CL validators total", async () => {
    const { lido, oracleReportSanityChecker } = ctx.contracts;

    await depositValidatorsWithoutReport(ctx, NOR_MODULE_ID, 1n);

    const balanceStatsBeforeReport = await lido.getBalanceStats();
    const norBefore = await getStakingModuleBalances(ctx, NOR_MODULE_ID);
    const sdvtBefore = await getStakingModuleBalances(ctx, SDVT_MODULE_ID);

    expect(balanceStatsBeforeReport.depositedSinceLastReport).to.equal(ONE_VALIDATOR_BALANCE);

    const { data } = await report(ctx, {
      clDiff: balanceStatsBeforeReport.depositedSinceLastReport,
      dryRun: true,
      excludeVaultsBalances: true,
      pendingBalancesGweiByStakingModule: [norBefore.pendingBalanceGwei, sdvtBefore.pendingBalanceGwei],
      skipWithdrawals: true,
      stakingModuleIdsWithUpdatedBalance: REPORTED_MODULE_IDS,
      validatorBalancesGweiByStakingModule: [norBefore.validatorsBalanceGwei, sdvtBefore.validatorsBalanceGwei],
      waitNextReportTime: true,
    });
    const inconsistentData = {
      ...data,
      clValidatorsBalanceGwei: getBigInt(data.clValidatorsBalanceGwei) + 1n,
    };

    await expect(submitReportDataWithConsensus(ctx, inconsistentData)).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "InconsistentValidatorsBalanceByModule",
    );
  });

  it("should reject a report whose module pending balances do not add up to the reported CL pending total", async () => {
    const { lido, oracleReportSanityChecker } = ctx.contracts;

    await depositValidatorsWithoutReport(ctx, NOR_MODULE_ID, 1n);

    const balanceStatsBeforeReport = await lido.getBalanceStats();
    const norBefore = await getStakingModuleBalances(ctx, NOR_MODULE_ID);
    const sdvtBefore = await getStakingModuleBalances(ctx, SDVT_MODULE_ID);

    expect(balanceStatsBeforeReport.depositedSinceLastReport).to.equal(ONE_VALIDATOR_BALANCE);

    const { data } = await report(ctx, {
      clDiff: balanceStatsBeforeReport.depositedSinceLastReport,
      dryRun: true,
      excludeVaultsBalances: true,
      pendingBalancesGweiByStakingModule: [norBefore.pendingBalanceGwei, sdvtBefore.pendingBalanceGwei],
      skipWithdrawals: true,
      stakingModuleIdsWithUpdatedBalance: REPORTED_MODULE_IDS,
      validatorBalancesGweiByStakingModule: [norBefore.validatorsBalanceGwei, sdvtBefore.validatorsBalanceGwei],
      waitNextReportTime: true,
    });
    const inconsistentData = {
      ...data,
      clPendingBalanceGwei: getBigInt(data.clPendingBalanceGwei) + 1n,
    };

    await expect(submitReportDataWithConsensus(ctx, inconsistentData)).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "InconsistentPendingBalanceByModule",
    );
  });

  it("should reject a report that increases one module's pending balance beyond its allowed corridor", async () => {
    const { lido, oracleReportSanityChecker } = ctx.contracts;

    await depositValidatorsWithoutReport(ctx, NOR_MODULE_ID, 1n);

    const balanceStatsBeforeReport = await lido.getBalanceStats();
    const norBefore = await getStakingModuleBalances(ctx, NOR_MODULE_ID);
    const sdvtBefore = await getStakingModuleBalances(ctx, SDVT_MODULE_ID);
    const { reportTimeElapsed } = await getNextReportContext(ctx);
    const { annualBalanceIncreaseBPLimit } = await oracleReportSanityChecker.getOracleReportLimits();

    const allowedExtraPendingGwei =
      (norBefore.validatorsBalanceGwei * annualBalanceIncreaseBPLimit * reportTimeElapsed) /
      (SECONDS_PER_YEAR * MAX_BASIS_POINTS);
    const excessiveExtraPendingGwei = allowedExtraPendingGwei + 1n;

    const { data } = await report(ctx, {
      clDiff: balanceStatsBeforeReport.depositedSinceLastReport + excessiveExtraPendingGwei * ONE_GWEI,
      dryRun: true,
      excludeVaultsBalances: true,
      pendingBalancesGweiByStakingModule: [
        norBefore.pendingBalanceGwei + excessiveExtraPendingGwei,
        sdvtBefore.pendingBalanceGwei,
      ],
      skipWithdrawals: true,
      stakingModuleIdsWithUpdatedBalance: REPORTED_MODULE_IDS,
      validatorBalancesGweiByStakingModule: [norBefore.validatorsBalanceGwei, sdvtBefore.validatorsBalanceGwei],
      waitNextReportTime: true,
    });

    await expect(submitReportDataWithConsensus(ctx, data)).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "IncorrectModulePendingBalance",
    );
  });

  it("should reject a report that consumes more pending across modules than the global appeared limit allows", async () => {
    const { oracleReportSanityChecker } = ctx.contracts;
    const { reportTimeElapsed } = await getNextReportContext(ctx);
    const perModuleAppearedLimitEthPerDay =
      (ONE_VALIDATOR_BALANCE_ETH * ONE_DAY + reportTimeElapsed - 1n) / reportTimeElapsed;

    await updateOracleReportLimits(ctx, {
      appearedEthAmountPerDayLimit: perModuleAppearedLimitEthPerDay,
      consolidationEthAmountPerDayLimit: 0n,
    });

    await depositValidatorsWithoutReport(ctx, NOR_MODULE_ID, 1n);
    await depositValidatorsWithoutReport(ctx, SDVT_MODULE_ID, 1n);

    const balanceStatsBeforeReport = await ctx.contracts.lido.getBalanceStats();
    const norBefore = await getStakingModuleBalances(ctx, NOR_MODULE_ID);
    const sdvtBefore = await getStakingModuleBalances(ctx, SDVT_MODULE_ID);

    const { data } = await report(ctx, {
      clDiff: balanceStatsBeforeReport.depositedSinceLastReport,
      dryRun: true,
      excludeVaultsBalances: true,
      pendingBalancesGweiByStakingModule: [0n, 0n],
      skipWithdrawals: true,
      stakingModuleIdsWithUpdatedBalance: REPORTED_MODULE_IDS,
      validatorBalancesGweiByStakingModule: [
        norBefore.validatorsBalanceGwei + norBefore.pendingBalanceGwei,
        sdvtBefore.validatorsBalanceGwei + sdvtBefore.pendingBalanceGwei,
      ],
      waitNextReportTime: true,
    });

    await expect(submitReportDataWithConsensus(ctx, data)).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "IncorrectTotalActiveAppearedEth",
    );
  });

  it("should reject a report that grows module validators without consuming matching pending balance", async () => {
    const { lido, oracleReportSanityChecker } = ctx.contracts;

    await updateOracleReportLimits(ctx, { annualBalanceIncreaseBPLimit: 1n });

    await depositValidatorsWithoutReport(ctx, NOR_MODULE_ID, 1n);

    const balanceStatsBeforeReport = await lido.getBalanceStats();
    const norBefore = await getStakingModuleBalances(ctx, NOR_MODULE_ID);
    const sdvtBefore = await getStakingModuleBalances(ctx, SDVT_MODULE_ID);
    const totalPendingBalanceBeforeGwei = norBefore.pendingBalanceGwei + sdvtBefore.pendingBalanceGwei;
    const totalValidatorsBalanceBeforeGwei = norBefore.validatorsBalanceGwei + sdvtBefore.validatorsBalanceGwei;

    expect(balanceStatsBeforeReport.clValidatorsBalanceAtLastReport).to.be.gt(0n);
    expect(balanceStatsBeforeReport.depositedSinceLastReport).to.equal(ONE_VALIDATOR_BALANCE);
    expect(totalPendingBalanceBeforeGwei).to.be.gt(0n);

    const { reportTimeElapsed } = await getNextReportContext(ctx);
    const { annualBalanceIncreaseBPLimit } = await oracleReportSanityChecker.getOracleReportLimits();
    const allowedValidatorsGrowthGwei =
      (totalValidatorsBalanceBeforeGwei * annualBalanceIncreaseBPLimit * reportTimeElapsed) /
      (SECONDS_PER_YEAR * MAX_BASIS_POINTS);
    const excessiveValidatorsGrowthGwei = allowedValidatorsGrowthGwei + 1n;
    const excessiveValidatorsGrowthWei = excessiveValidatorsGrowthGwei * ONE_GWEI;

    const reportedValidatorsBalancesGwei = [
      norBefore.validatorsBalanceGwei + excessiveValidatorsGrowthGwei,
      sdvtBefore.validatorsBalanceGwei,
    ];
    const reportedPendingBalancesGwei = [norBefore.pendingBalanceGwei, sdvtBefore.pendingBalanceGwei];

    const validatorsBalanceAfterGwei = reportedValidatorsBalancesGwei[0] + reportedValidatorsBalancesGwei[1];
    const pendingBalanceAfterGwei = reportedPendingBalancesGwei[0] + reportedPendingBalancesGwei[1];

    expect(pendingBalanceAfterGwei).to.equal(totalPendingBalanceBeforeGwei);
    expect(validatorsBalanceAfterGwei).to.equal(totalValidatorsBalanceBeforeGwei + excessiveValidatorsGrowthGwei);

    const { data } = await report(ctx, {
      clDiff: balanceStatsBeforeReport.depositedSinceLastReport + excessiveValidatorsGrowthWei,
      dryRun: true,
      excludeVaultsBalances: true,
      pendingBalancesGweiByStakingModule: reportedPendingBalancesGwei,
      skipWithdrawals: true,
      stakingModuleIdsWithUpdatedBalance: REPORTED_MODULE_IDS,
      validatorBalancesGweiByStakingModule: reportedValidatorsBalancesGwei,
      waitNextReportTime: true,
    });

    const totalCLBalanceBeforeWei =
      balanceStatsBeforeReport.clValidatorsBalanceAtLastReport +
      balanceStatsBeforeReport.clPendingBalanceAtLastReport +
      balanceStatsBeforeReport.depositedSinceLastReport;
    const totalCLGrowthCapWei =
      (totalCLBalanceBeforeWei * annualBalanceIncreaseBPLimit * reportTimeElapsed) /
      (SECONDS_PER_YEAR * MAX_BASIS_POINTS);

    expect(totalCLGrowthCapWei).to.be.gte(
      excessiveValidatorsGrowthWei,
      "test precondition failed: total CL annual cap must stay above the crafted validator-only growth",
    );

    await expect(submitReportDataWithConsensus(ctx, data)).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "IncorrectTotalCLBalanceIncrease",
    );
  });

  it("should reject a report whose module validators growth per day exceeds the daily appeared limit", async () => {
    const { oracleReportSanityChecker } = ctx.contracts;
    const { reportTimeElapsed } = await getNextReportContext(ctx);
    const appearedLimitEthPerDay = (ONE_VALIDATOR_BALANCE_ETH * ONE_DAY + reportTimeElapsed - 1n) / reportTimeElapsed;

    await updateOracleReportLimits(ctx, {
      annualBalanceIncreaseBPLimit: 1000n,
      appearedEthAmountPerDayLimit: appearedLimitEthPerDay,
      consolidationEthAmountPerDayLimit: 0n,
    });

    await depositValidatorsWithoutReport(ctx, NOR_MODULE_ID, 1n);

    const balanceStatsBeforeReport = await ctx.contracts.lido.getBalanceStats();
    const norBefore = await getStakingModuleBalances(ctx, NOR_MODULE_ID);
    const sdvtBefore = await getStakingModuleBalances(ctx, SDVT_MODULE_ID);
    const totalValidatorsBalanceBeforeGwei = norBefore.validatorsBalanceGwei + sdvtBefore.validatorsBalanceGwei;
    const { annualBalanceIncreaseBPLimit } = await oracleReportSanityChecker.getOracleReportLimits();
    const appearedLimitWeiPerDay = appearedLimitEthPerDay * ether("1");
    const maxValidatorsIncreaseWeiAtDailyLimit = (appearedLimitWeiPerDay * reportTimeElapsed) / ONE_DAY;
    const maxValidatorsIncreaseGweiAtDailyLimit = maxValidatorsIncreaseWeiAtDailyLimit / ONE_GWEI;
    const extraValidatorsGrowthGwei = maxValidatorsIncreaseGweiAtDailyLimit - ONE_VALIDATOR_BALANCE / ONE_GWEI + 1n;
    const extraValidatorsGrowthWei = extraValidatorsGrowthGwei * ONE_GWEI;
    const totalSafetyCapGwei =
      (totalValidatorsBalanceBeforeGwei * annualBalanceIncreaseBPLimit * reportTimeElapsed) /
      (SECONDS_PER_YEAR * MAX_BASIS_POINTS);

    expect(totalSafetyCapGwei).to.be.gte(
      extraValidatorsGrowthGwei,
      "test precondition failed: total validators safety cap must allow the extra growth above the daily limit",
    );

    const { data } = await report(ctx, {
      clDiff: balanceStatsBeforeReport.depositedSinceLastReport + extraValidatorsGrowthWei,
      dryRun: true,
      excludeVaultsBalances: true,
      pendingBalancesGweiByStakingModule: [0n, sdvtBefore.pendingBalanceGwei],
      skipWithdrawals: true,
      stakingModuleIdsWithUpdatedBalance: REPORTED_MODULE_IDS,
      validatorBalancesGweiByStakingModule: [
        norBefore.validatorsBalanceGwei + norBefore.pendingBalanceGwei + extraValidatorsGrowthGwei,
        sdvtBefore.validatorsBalanceGwei,
      ],
      waitNextReportTime: true,
    });

    await expect(submitReportDataWithConsensus(ctx, data)).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "AppearedEthAmountPerDayLimitExceeded",
    );
  });
});
