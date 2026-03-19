import { ProtocolContext } from "../types";

export const setMaxPositiveTokenRebase = async (ctx: ProtocolContext, maxPositiveTokenRebase: bigint) => {
  const { oracleReportSanityChecker: sanityChecker } = ctx.contracts;
  const agent = await ctx.getSigner("agent");

  const initialMaxPositiveTokenRebase = await sanityChecker.getMaxPositiveTokenRebase();

  const MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE = await sanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE();
  await sanityChecker.connect(agent).grantRole(MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE, agent.address);
  await sanityChecker.connect(agent).setMaxPositiveTokenRebase(maxPositiveTokenRebase);
  await sanityChecker.connect(agent).revokeRole(MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE, agent.address);
  return initialMaxPositiveTokenRebase;
};

export const updateOracleReportLimits = async (
  ctx: ProtocolContext,
  patch: Partial<
    Awaited<ReturnType<ProtocolContext["contracts"]["oracleReportSanityChecker"]["getOracleReportLimits"]>>
  >,
) => {
  const { oracleReportSanityChecker: sanityChecker } = ctx.contracts;
  const agent = await ctx.getSigner("agent");
  const currentLimits = await sanityChecker.getOracleReportLimits();
  const secondOpinionOracle = await sanityChecker.secondOpinionOracle();
  const role = await sanityChecker.ALL_LIMITS_MANAGER_ROLE();
  const nextLimits = {
    exitedEthAmountPerDayLimit: patch.exitedEthAmountPerDayLimit ?? currentLimits.exitedEthAmountPerDayLimit,
    appearedEthAmountPerDayLimit: patch.appearedEthAmountPerDayLimit ?? currentLimits.appearedEthAmountPerDayLimit,
    annualBalanceIncreaseBPLimit: patch.annualBalanceIncreaseBPLimit ?? currentLimits.annualBalanceIncreaseBPLimit,
    simulatedShareRateDeviationBPLimit:
      patch.simulatedShareRateDeviationBPLimit ?? currentLimits.simulatedShareRateDeviationBPLimit,
    maxBalanceExitRequestedPerReportInEth:
      patch.maxBalanceExitRequestedPerReportInEth ?? currentLimits.maxBalanceExitRequestedPerReportInEth,
    maxEffectiveBalanceWeightWCType01:
      patch.maxEffectiveBalanceWeightWCType01 ?? currentLimits.maxEffectiveBalanceWeightWCType01,
    maxEffectiveBalanceWeightWCType02:
      patch.maxEffectiveBalanceWeightWCType02 ?? currentLimits.maxEffectiveBalanceWeightWCType02,
    maxItemsPerExtraDataTransaction:
      patch.maxItemsPerExtraDataTransaction ?? currentLimits.maxItemsPerExtraDataTransaction,
    maxNodeOperatorsPerExtraDataItem:
      patch.maxNodeOperatorsPerExtraDataItem ?? currentLimits.maxNodeOperatorsPerExtraDataItem,
    requestTimestampMargin: patch.requestTimestampMargin ?? currentLimits.requestTimestampMargin,
    maxPositiveTokenRebase: patch.maxPositiveTokenRebase ?? currentLimits.maxPositiveTokenRebase,
    maxCLBalanceDecreaseBP: patch.maxCLBalanceDecreaseBP ?? currentLimits.maxCLBalanceDecreaseBP,
    clBalanceOraclesErrorUpperBPLimit:
      patch.clBalanceOraclesErrorUpperBPLimit ?? currentLimits.clBalanceOraclesErrorUpperBPLimit,
    consolidationEthAmountPerDayLimit:
      patch.consolidationEthAmountPerDayLimit ?? currentLimits.consolidationEthAmountPerDayLimit,
    exitedValidatorEthAmountLimit: patch.exitedValidatorEthAmountLimit ?? currentLimits.exitedValidatorEthAmountLimit,
  };

  await sanityChecker.connect(agent).grantRole(role, agent.address);
  await sanityChecker.connect(agent).setOracleReportLimits(nextLimits, secondOpinionOracle);
  await sanityChecker.connect(agent).revokeRole(role, agent.address);
};
