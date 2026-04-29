import { expect } from "chai";
import { getBigInt } from "ethers";

import { ether, ONE_GWEI } from "lib";
import {
  depositValidatorsWithoutReport,
  getCurrentModuleAccountingReportParams,
  getNextReportContext,
  getProtocolContext,
  ProtocolContext,
  report,
  submitReportDataWithConsensus,
  submitReportDataWithConsensusAndEmptyExtraData,
  updateOracleReportLimits,
} from "lib/protocol";

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

  const getCurrentModuleReportState = async ({
    validatorsDeltaGweiByModule = new Map<bigint, bigint>(),
  }: {
    validatorsDeltaGweiByModule?: Map<bigint, bigint>;
  } = {}) => {
    const { stakingModuleIdsWithUpdatedBalance, validatorBalancesGweiByStakingModule } =
      await getCurrentModuleAccountingReportParams(ctx, { validatorsDeltaGweiByModule });
    const moduleIndexById = new Map(
      stakingModuleIdsWithUpdatedBalance.map((moduleId, index) => [moduleId, index] as const),
    );

    return { stakingModuleIdsWithUpdatedBalance, validatorBalancesGweiByStakingModule, moduleIndexById };
  };

  const withUpdatedModuleBalances = (
    currentValidatorBalancesGweiByStakingModule: bigint[],
    moduleIndexById: Map<bigint, number>,
    balancesDeltaGweiByModule: Array<[bigint, bigint]>,
  ) => {
    const updatedValidatorBalancesGweiByStakingModule = [...currentValidatorBalancesGweiByStakingModule];

    for (const [moduleId, balanceDeltaGwei] of balancesDeltaGweiByModule) {
      const index = moduleIndexById.get(moduleId);
      if (index === undefined) {
        throw new Error(`Missing staking module ${moduleId} in router order`);
      }

      updatedValidatorBalancesGweiByStakingModule[index] += balanceDeltaGwei;
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
      clDiff: clDiff + clPendingBalanceGwei * ONE_GWEI, //simulate full total increase
      clPendingBalanceGwei: 0n,
      dryRun: true,
      excludeVaultsBalances: true,
      skipWithdrawals: true,
      stakingModuleIdsWithUpdatedBalance,
      validatorBalancesGweiByStakingModule,
      waitNextReportTime: true,
    });
    return {
      ...data,
      // extract pending balance from simulated total clBalance
      clValidatorsBalanceGwei: BigInt(data.clValidatorsBalanceGwei) - clPendingBalanceGwei,
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

    const validatorsDeltaGweiByModule = await depositValidatorsWithoutReport(ctx, 1n);

    const balanceStatsBeforeReport = await lido.getBalanceStats();
    const moduleReportState = await getCurrentModuleReportState();
    const norPendingBalanceBeforeGwei = balanceStatsBeforeReport.depositedSinceLastReport / ONE_GWEI;
    const totalPendingBalanceBeforeGwei = norPendingBalanceBeforeGwei;
    const totalValidatorsBalanceBeforeGwei = sumBigints(moduleReportState.validatorBalancesGweiByStakingModule);

    expect(balanceStatsBeforeReport.depositedSinceLastReport).to.equal(ONE_VALIDATOR_BALANCE);

    const pendingConsumedGwei = norPendingBalanceBeforeGwei;
    expect(pendingConsumedGwei).to.be.gt(0n);

    const reportedValidatorsBalancesGwei = withUpdatedModuleBalances(
      moduleReportState.validatorBalancesGweiByStakingModule,
      moduleReportState.moduleIndexById,
      [...validatorsDeltaGweiByModule].reduce<Array<[bigint, bigint]>>((acc, [moduleId, delta]) => {
        if (delta > 0n) {
          expect(delta).to.equal(pendingConsumedGwei);
          acc.push([moduleId, delta]);
        }
        return acc;
      }, []),
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

    await depositValidatorsWithoutReport(ctx, 1n);

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

    const validatorsDeltaGweiByModule = await depositValidatorsWithoutReport(ctx, 2n);
    const balanceStatsBeforeReport = await ctx.contracts.lido.getBalanceStats();
    const moduleReportState = await getCurrentModuleReportState();

    const data = await buildReportData({
      clDiff: balanceStatsBeforeReport.depositedSinceLastReport,
      stakingModuleIdsWithUpdatedBalance: moduleReportState.stakingModuleIdsWithUpdatedBalance,
      validatorBalancesGweiByStakingModule: withUpdatedModuleBalances(
        moduleReportState.validatorBalancesGweiByStakingModule,
        moduleReportState.moduleIndexById,
        [...validatorsDeltaGweiByModule].reduce<Array<[bigint, bigint]>>((acc, [moduleId, delta]) => {
          if (delta > 0n) {
            acc.push([moduleId, delta]);
          }
          return acc;
        }, []),
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

    const validatorsDeltaGweiByModule = await depositValidatorsWithoutReport(ctx, 2n);

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
    const totalValidatorsBalanceBeforeGwei = sumBigints(moduleReportState.validatorBalancesGweiByStakingModule);
    expect(totalPendingBalanceBeforeWei).to.equal(2n * ONE_VALIDATOR_BALANCE);

    const maxDeltaEntry = [...validatorsDeltaGweiByModule.entries()].reduce<[bigint, bigint] | undefined>(
      (best, entry) => {
        const [, delta] = entry;
        return best === undefined || delta > best[1] ? entry : best;
      },
      undefined,
    );
    expect(maxDeltaEntry, "no module with positive validator delta found").to.not.equal(undefined);
    const [grownModuleId] = maxDeltaEntry!;

    const donorModuleEntry = moduleReportState.stakingModuleIdsWithUpdatedBalance
      .map((moduleId, index) => {
        const balanceGwei = moduleReportState.validatorBalancesGweiByStakingModule[index];
        return [moduleId, balanceGwei] as const;
      })
      .find(([moduleId, balanceGwei]) => {
        return moduleId !== grownModuleId && balanceGwei > moduleGrowthExcessGwei;
      });

    expect(
      donorModuleEntry,
      "no other module has enough validators balance to offset moduleGrowthExcessGwei",
    ).to.not.equal(undefined);
    const [donorModuleId] = donorModuleEntry!;

    const reportedValidatorsBalancesGwei = withUpdatedModuleBalances(
      moduleReportState.validatorBalancesGweiByStakingModule,
      moduleReportState.moduleIndexById,
      [
        [grownModuleId, totalPendingBalanceBeforeGwei + moduleGrowthExcessGwei],
        [donorModuleId, -moduleGrowthExcessGwei],
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

    const validatorsDeltaGweiByModule = await depositValidatorsWithoutReport(ctx, 1n);

    const balanceStatsBeforeReport = await lido.getBalanceStats();
    const moduleReportState = await getCurrentModuleReportState();
    const totalPendingBalanceBeforeGwei = balanceStatsBeforeReport.depositedSinceLastReport / ONE_GWEI;
    const totalValidatorsBalanceBeforeGwei = sumBigints(moduleReportState.validatorBalancesGweiByStakingModule);

    expect(balanceStatsBeforeReport.clValidatorsBalanceAtLastReport / ONE_GWEI).to.equal(
      totalValidatorsBalanceBeforeGwei,
    );
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
      [...validatorsDeltaGweiByModule].reduce<Array<[bigint, bigint]>>((acc, [moduleId, delta]) => {
        if (delta > 0n) {
          acc.push([moduleId, excessiveValidatorsGrowthGwei]);
        }
        return acc;
      }, []),
    );

    const validatorsBalanceAfterGwei = sumBigints(reportedValidatorsBalancesGwei);
    // const pendingBalanceAfterGwei = totalPendingBalanceBeforeGwei;
    // expect(pendingBalanceAfterGwei).to.equal(totalPendingBalanceBeforeGwei); ??
    expect(validatorsBalanceAfterGwei).to.equal(totalValidatorsBalanceBeforeGwei + excessiveValidatorsGrowthGwei);

    const data = await buildReportData({
      clDiff: excessiveValidatorsGrowthWei,
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
