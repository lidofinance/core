import { expect } from "chai";
import { getBigInt } from "ethers";

import { ether, ONE_GWEI } from "lib";
import {
  depositValidatorsWithoutReport,
  getCurrentModuleAccountingReportParams,
  getNextReportContext,
  getProtocolContext,
  getStakingModuleBalances,
  ProtocolContext,
  report,
  submitReportDataWithConsensus,
  submitReportDataWithConsensusAndEmptyExtraData,
  updateOracleReportLimits,
} from "lib/protocol";
import { NOR_MODULE_ID, SDVT_MODULE_ID } from "lib/protocol/helpers/staking-module";

import { Snapshot } from "test/suite";

const ONE_DAY = 24n * 60n * 60n;
const ONE_VALIDATOR_BALANCE_ETH = 32n;
const ONE_VALIDATOR_BALANCE = ether("32");
const ONE_ETH = ether("1");
const MAX_BASIS_POINTS = 10_000n;
const SECONDS_PER_YEAR = 365n * ONE_DAY;
const sumBigints = (values: bigint[]) => values.reduce((sum, value) => sum + value, 0n);

describe("Integration: AccountingOracle module balances sanity", () => {
  let ctx: ProtocolContext;

  let snapshot: string;
  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    await submitModuleBalancesSanityBaseline();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot));

  const getCurrentModuleReportState = async () => {
    const { stakingModuleIdsWithUpdatedBalance, validatorBalancesGweiByStakingModule } =
      await getCurrentModuleAccountingReportParams(ctx);
    const moduleIndexById = new Map(
      stakingModuleIdsWithUpdatedBalance.map((moduleId, index) => [moduleId, index] as const),
    );

    return { stakingModuleIdsWithUpdatedBalance, validatorBalancesGweiByStakingModule, moduleIndexById };
  };

  const withUpdatedModuleBalances = (
    currentValidatorBalancesGweiByStakingModule: bigint[],
    moduleIndexById: Map<bigint, number>,
    overrides: Array<[bigint, bigint]>,
  ) => {
    const updatedValidatorBalancesGweiByStakingModule = [...currentValidatorBalancesGweiByStakingModule];

    for (const [moduleId, updatedValidatorsBalanceGwei] of overrides) {
      const index = moduleIndexById.get(moduleId);
      if (index === undefined) {
        throw new Error(`Missing staking module ${moduleId} in router order`);
      }

      updatedValidatorBalancesGweiByStakingModule[index] = updatedValidatorsBalanceGwei;
    }

    return updatedValidatorBalancesGweiByStakingModule;
  };

  const buildReportData = async ({
    clDiff,
    stakingModuleIdsWithUpdatedBalance,
    validatorBalancesGweiByStakingModule,
    clPendingBalanceGwei,
  }: {
    clDiff: bigint;
    stakingModuleIdsWithUpdatedBalance: bigint[];
    validatorBalancesGweiByStakingModule: bigint[];
    clPendingBalanceGwei: bigint;
  }) => {
    const { data } = await report(ctx, {
      clDiff,
      clPendingBalanceGwei,
      dryRun: true,
      excludeVaultsBalances: true,
      skipWithdrawals: true,
      stakingModuleIdsWithUpdatedBalance,
      validatorBalancesGweiByStakingModule,
      waitNextReportTime: true,
    });

    const totalClBalanceGwei = getBigInt(data.clValidatorsBalanceGwei) + getBigInt(data.clPendingBalanceGwei);
    return {
      ...data,
      clValidatorsBalanceGwei: totalClBalanceGwei - clPendingBalanceGwei,
      clPendingBalanceGwei,
    };
  };

  const submitModuleBalancesSanityBaseline = async () => {
    const { data } = await report(ctx, {
      dryRun: true,
      excludeVaultsBalances: true,
      skipWithdrawals: true,
    });

    await submitReportDataWithConsensusAndEmptyExtraData(ctx, data);
  };

  it("should accept a report that moves one module's pending balance into validators", async () => {
    const { lido } = ctx.contracts;

    await depositValidatorsWithoutReport(ctx, NOR_MODULE_ID, 1n);

    const balanceStatsBeforeReport = await lido.getBalanceStats();
    const moduleReportState = await getCurrentModuleReportState();
    const norBefore = await getStakingModuleBalances(ctx, NOR_MODULE_ID);
    const norPendingBalanceBeforeGwei = balanceStatsBeforeReport.depositedSinceLastReport / ONE_GWEI;
    const totalPendingBalanceBeforeGwei = norPendingBalanceBeforeGwei;
    const totalValidatorsBalanceBeforeGwei = sumBigints(moduleReportState.validatorBalancesGweiByStakingModule);

    expect(balanceStatsBeforeReport.depositedSinceLastReport).to.equal(ONE_VALIDATOR_BALANCE);

    const pendingConsumedGwei = norPendingBalanceBeforeGwei;
    expect(pendingConsumedGwei).to.be.gt(0n);

    const reportedValidatorsBalancesGwei = withUpdatedModuleBalances(
      moduleReportState.validatorBalancesGweiByStakingModule,
      moduleReportState.moduleIndexById,
      [[NOR_MODULE_ID, norBefore.validatorsBalanceGwei + pendingConsumedGwei]],
    );
    const validatorsBalanceAfterGwei = sumBigints(reportedValidatorsBalancesGwei);
    const pendingBalanceAfterGwei = 0n;

    expect(validatorsBalanceAfterGwei).to.equal(totalValidatorsBalanceBeforeGwei + pendingConsumedGwei);
    expect(pendingBalanceAfterGwei).to.equal(totalPendingBalanceBeforeGwei - pendingConsumedGwei);

    const data = await buildReportData({
      clDiff: balanceStatsBeforeReport.depositedSinceLastReport,
      stakingModuleIdsWithUpdatedBalance: moduleReportState.stakingModuleIdsWithUpdatedBalance,
      validatorBalancesGweiByStakingModule: reportedValidatorsBalancesGwei,
      clPendingBalanceGwei: 0n,
    });

    await expect(submitReportDataWithConsensus(ctx, data)).to.not.be.reverted;
  });

  it("should reject a report whose module validators balances do not add up to the reported CL validators total", async () => {
    const { lido, oracleReportSanityChecker } = ctx.contracts;

    await depositValidatorsWithoutReport(ctx, NOR_MODULE_ID, 1n);

    const balanceStatsBeforeReport = await lido.getBalanceStats();
    const moduleReportState = await getCurrentModuleReportState();
    const norPendingBalanceBeforeGwei = balanceStatsBeforeReport.depositedSinceLastReport / ONE_GWEI;

    expect(balanceStatsBeforeReport.depositedSinceLastReport).to.equal(ONE_VALIDATOR_BALANCE);

    const data = await buildReportData({
      clDiff: balanceStatsBeforeReport.depositedSinceLastReport,
      stakingModuleIdsWithUpdatedBalance: moduleReportState.stakingModuleIdsWithUpdatedBalance,
      validatorBalancesGweiByStakingModule: moduleReportState.validatorBalancesGweiByStakingModule,
      clPendingBalanceGwei: norPendingBalanceBeforeGwei,
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

  it("should reject a report that consumes more pending across modules than the global appeared limit allows", async () => {
    const { oracleReportSanityChecker } = ctx.contracts;
    const { reportTimeElapsed } = await getNextReportContext(ctx);
    const perModuleAppearedLimitEthPerDay =
      (ONE_VALIDATOR_BALANCE_ETH * ONE_DAY + reportTimeElapsed - 1n) / reportTimeElapsed;

    await updateOracleReportLimits(ctx, {
      appearedEthAmountPerDayLimit: perModuleAppearedLimitEthPerDay,
      consolidationEthAmountPerDayLimit: 0n,
    });

    // On Hoodi after SRv3 allocation, SDVT does not accept a direct deposit (`ZeroDeposits()`).
    // This check depends on the global pending budget in Lido, so create two pending validators
    // through NOR, then craft module growth in both NOR and SDVT below.
    await depositValidatorsWithoutReport(ctx, NOR_MODULE_ID, 2n);

    const balanceStatsBeforeReport = await ctx.contracts.lido.getBalanceStats();
    const moduleReportState = await getCurrentModuleReportState();
    const norBefore = await getStakingModuleBalances(ctx, NOR_MODULE_ID);
    const sdvtBefore = await getStakingModuleBalances(ctx, SDVT_MODULE_ID);
    const pendingConsumedPerModuleGwei = ONE_VALIDATOR_BALANCE / ONE_GWEI;

    const data = await buildReportData({
      clDiff: balanceStatsBeforeReport.depositedSinceLastReport,
      stakingModuleIdsWithUpdatedBalance: moduleReportState.stakingModuleIdsWithUpdatedBalance,
      validatorBalancesGweiByStakingModule: withUpdatedModuleBalances(
        moduleReportState.validatorBalancesGweiByStakingModule,
        moduleReportState.moduleIndexById,
        [
          [NOR_MODULE_ID, norBefore.validatorsBalanceGwei + pendingConsumedPerModuleGwei],
          [SDVT_MODULE_ID, sdvtBefore.validatorsBalanceGwei + pendingConsumedPerModuleGwei],
        ],
      ),
      clPendingBalanceGwei: 0n,
    });

    await expect(submitReportDataWithConsensus(ctx, data)).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "IncorrectTotalActivatedBalance",
    );
  });

  it("should reject a report when positive module validators growth exceeds the module increase limit", async () => {
    const { lido, oracleReportSanityChecker } = ctx.contracts;
    const moduleGrowthExcessGwei = ONE_ETH / ONE_GWEI;

    // On Hoodi after SRv3 allocation, SDVT does not accept a direct deposit (`ZeroDeposits()`).
    // This sanity check compares the global pending budget with total per-module growth, so
    // pending can be created through NOR while the excess is crafted in module balances.
    await depositValidatorsWithoutReport(ctx, NOR_MODULE_ID, 2n);

    const balanceStatsBeforeReport = await lido.getBalanceStats();
    const { reportTimeElapsed } = await getNextReportContext(ctx);
    const totalPendingBalanceBeforeWei = balanceStatsBeforeReport.depositedSinceLastReport;
    const totalPendingBalanceBeforeGwei = totalPendingBalanceBeforeWei / ONE_GWEI;
    const appearedLimitEthPerDay =
      ((totalPendingBalanceBeforeWei / ONE_ETH) * ONE_DAY + reportTimeElapsed - 1n) / reportTimeElapsed;

    await updateOracleReportLimits(ctx, {
      annualBalanceIncreaseBPLimit: 0n,
      appearedEthAmountPerDayLimit: appearedLimitEthPerDay,
      consolidationEthAmountPerDayLimit: 0n,
    });

    const moduleReportState = await getCurrentModuleReportState();
    const norBefore = await getStakingModuleBalances(ctx, NOR_MODULE_ID);
    const sdvtBefore = await getStakingModuleBalances(ctx, SDVT_MODULE_ID);
    const totalValidatorsBalanceBeforeGwei = sumBigints(moduleReportState.validatorBalancesGweiByStakingModule);

    expect(totalPendingBalanceBeforeWei).to.equal(2n * ONE_VALIDATOR_BALANCE);
    expect(sdvtBefore.validatorsBalanceGwei).to.be.gt(
      moduleGrowthExcessGwei,
      "test precondition failed: SDVT must have enough previous balance to offset the crafted excess",
    );

    const reportedValidatorsBalancesGwei = withUpdatedModuleBalances(
      moduleReportState.validatorBalancesGweiByStakingModule,
      moduleReportState.moduleIndexById,
      [
        [NOR_MODULE_ID, norBefore.validatorsBalanceGwei + totalPendingBalanceBeforeGwei + moduleGrowthExcessGwei],
        [SDVT_MODULE_ID, sdvtBefore.validatorsBalanceGwei - moduleGrowthExcessGwei],
      ],
    );
    const validatorsBalanceAfterGwei = sumBigints(reportedValidatorsBalancesGwei);

    expect(validatorsBalanceAfterGwei).to.equal(totalValidatorsBalanceBeforeGwei + totalPendingBalanceBeforeGwei);

    const data = await buildReportData({
      clDiff: totalPendingBalanceBeforeWei,
      stakingModuleIdsWithUpdatedBalance: moduleReportState.stakingModuleIdsWithUpdatedBalance,
      validatorBalancesGweiByStakingModule: reportedValidatorsBalancesGwei,
      clPendingBalanceGwei: 0n,
    });

    await expect(submitReportDataWithConsensus(ctx, data))
      .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectTotalModuleValidatorsBalanceIncrease")
      .withArgs(totalPendingBalanceBeforeWei, totalPendingBalanceBeforeWei + ONE_ETH);
  });

  it("should reject a report that grows module validators without consuming matching pending balance", async () => {
    const { lido, oracleReportSanityChecker } = ctx.contracts;

    await updateOracleReportLimits(ctx, { annualBalanceIncreaseBPLimit: 1n });

    await depositValidatorsWithoutReport(ctx, NOR_MODULE_ID, 1n);

    const balanceStatsBeforeReport = await lido.getBalanceStats();
    const moduleReportState = await getCurrentModuleReportState();
    const norBefore = await getStakingModuleBalances(ctx, NOR_MODULE_ID);
    const totalPendingBalanceBeforeGwei = balanceStatsBeforeReport.depositedSinceLastReport / ONE_GWEI;
    const totalValidatorsBalanceBeforeGwei = sumBigints(moduleReportState.validatorBalancesGweiByStakingModule);

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

    const reportedValidatorsBalancesGwei = withUpdatedModuleBalances(
      moduleReportState.validatorBalancesGweiByStakingModule,
      moduleReportState.moduleIndexById,
      [[NOR_MODULE_ID, norBefore.validatorsBalanceGwei + excessiveValidatorsGrowthGwei]],
    );
    const validatorsBalanceAfterGwei = sumBigints(reportedValidatorsBalancesGwei);
    const pendingBalanceAfterGwei = totalPendingBalanceBeforeGwei;

    expect(pendingBalanceAfterGwei).to.equal(totalPendingBalanceBeforeGwei);
    expect(validatorsBalanceAfterGwei).to.equal(totalValidatorsBalanceBeforeGwei + excessiveValidatorsGrowthGwei);

    const data = await buildReportData({
      clDiff: balanceStatsBeforeReport.depositedSinceLastReport + excessiveValidatorsGrowthWei,
      stakingModuleIdsWithUpdatedBalance: moduleReportState.stakingModuleIdsWithUpdatedBalance,
      validatorBalancesGweiByStakingModule: reportedValidatorsBalancesGwei,
      clPendingBalanceGwei: totalPendingBalanceBeforeGwei,
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
});
