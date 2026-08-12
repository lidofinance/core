import { ProtocolContext } from "../types";

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
    annualCLRebaseIncreaseSoftBPLimit:
      patch.annualCLRebaseIncreaseSoftBPLimit ?? currentLimits.annualCLRebaseIncreaseSoftBPLimit,
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
    annualCLRebaseIncreaseHardBPLimit:
      patch.annualCLRebaseIncreaseHardBPLimit ?? currentLimits.annualCLRebaseIncreaseHardBPLimit,
    clRebaseDecreaseSoftBPLimit: patch.clRebaseDecreaseSoftBPLimit ?? currentLimits.clRebaseDecreaseSoftBPLimit,
    clRebaseDecreaseHardBPLimit: patch.clRebaseDecreaseHardBPLimit ?? currentLimits.clRebaseDecreaseHardBPLimit,
    consolidationEthAmountPerDayLimit:
      patch.consolidationEthAmountPerDayLimit ?? currentLimits.consolidationEthAmountPerDayLimit,
    exitedValidatorEthAmountLimit: patch.exitedValidatorEthAmountLimit ?? currentLimits.exitedValidatorEthAmountLimit,
    externalPendingBalanceCapEth: patch.externalPendingBalanceCapEth ?? currentLimits.externalPendingBalanceCapEth,
  };

  await sanityChecker.connect(agent).grantRole(role, agent.address);
  await sanityChecker.connect(agent).setOracleReportLimits(nextLimits, secondOpinionOracle);
  await sanityChecker.connect(agent).revokeRole(role, agent.address);
};
