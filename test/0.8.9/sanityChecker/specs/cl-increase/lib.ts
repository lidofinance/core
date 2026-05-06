import { ether } from "lib";

export const DAY = 86_400n;
export const HOUR = 3_600n;
export const MAX_BASIS_POINTS = 10_000n;
export const ANNUAL_BALANCE_INCREASE_DENOMINATOR = 365n * DAY * MAX_BASIS_POINTS;

export type ClIncreaseLimits = {
  appearedEthAmountPerDayLimit: bigint;
  annualBalanceIncreaseBPLimit: bigint;
  externalPendingBalanceCapEth: bigint;
};

export const defaultOracleReportLimits = {
  exitedEthAmountPerDayLimit: 55n,
  appearedEthAmountPerDayLimit: 100n,
  annualBalanceIncreaseBPLimit: 1_000n,
  simulatedShareRateDeviationBPLimit: 250n,
  maxBalanceExitRequestedPerReportInEth: 65_000n,
  maxEffectiveBalanceWeightWCType01: 32n,
  maxEffectiveBalanceWeightWCType02: 2_048n,
  maxItemsPerExtraDataTransaction: 15n,
  maxNodeOperatorsPerExtraDataItem: 16n,
  requestTimestampMargin: 128n,
  maxPositiveTokenRebase: 5_000_000n,
  maxCLBalanceDecreaseBP: 360n,
  clBalanceOraclesErrorUpperBPLimit: 50n,
  consolidationEthAmountPerDayLimit: 10n,
  exitedValidatorEthAmountLimit: 1n,
  externalPendingBalanceCapEth: 0n,
};

export type ClIncreaseReport = {
  timeElapsed: bigint;
  preValidatorsBalance: bigint;
  prePendingBalance: bigint;
  postValidatorsBalance: bigint;
  postPendingBalance: bigint;
  deposits: bigint;
  clWithdrawals: bigint;
};

export type ClIncreaseFormula = {
  pendingBalanceCap: bigint;
  activatedBalance: bigint;
  appearedBalanceLimit: bigint;
  validatorsBalanceIncrease: bigint;
  validatorsGrowthLimit: bigint;
};

export type ClIncreaseCase = {
  title: string;
  rationale: string;
  limits?: Partial<ClIncreaseLimits>;
  report: ClIncreaseReport;
  expected: {
    outcome:
      | "accepted"
      | "IncorrectTotalPendingBalance"
      | "IncorrectTotalActivatedBalance"
      | "IncorrectTotalCLBalanceIncrease";
    formula?: Partial<ClIncreaseFormula>;
  };
};

export const report = ({
  timeElapsed = DAY,
  preValidatorsBalance,
  prePendingBalance,
  postValidatorsBalance,
  postPendingBalance,
  deposits,
  clWithdrawals,
}: {
  timeElapsed?: bigint;
  preValidatorsBalance: bigint;
  prePendingBalance: bigint;
  postValidatorsBalance: bigint;
  postPendingBalance: bigint;
  deposits: bigint;
  clWithdrawals: bigint;
}): ClIncreaseReport => ({
  timeElapsed,
  preValidatorsBalance,
  prePendingBalance,
  postValidatorsBalance,
  postPendingBalance,
  deposits,
  clWithdrawals,
});

export const calcClIncreaseFormula = (fixture: ClIncreaseReport, limits: ClIncreaseLimits): ClIncreaseFormula => {
  const effectiveTimeElapsed = fixture.timeElapsed === 0n ? HOUR : fixture.timeElapsed;
  const fundedPendingBalance = fixture.prePendingBalance + fixture.deposits;
  const pendingBalanceCap = fundedPendingBalance + ether(limits.externalPendingBalanceCapEth.toString());
  const activatedBalance =
    fundedPendingBalance > fixture.postPendingBalance ? fundedPendingBalance - fixture.postPendingBalance : 0n;
  const appearedBalanceLimit = (ether(limits.appearedEthAmountPerDayLimit.toString()) * effectiveTimeElapsed) / DAY;
  const validatorsGrowthLimit =
    activatedBalance +
    ((fixture.preValidatorsBalance + activatedBalance) * limits.annualBalanceIncreaseBPLimit * effectiveTimeElapsed) /
      ANNUAL_BALANCE_INCREASE_DENOMINATOR;
  const preValidatorsAfterWithdrawals =
    fixture.clWithdrawals >= fixture.preValidatorsBalance ? 0n : fixture.preValidatorsBalance - fixture.clWithdrawals;
  const validatorsBalanceIncrease =
    fixture.postValidatorsBalance > preValidatorsAfterWithdrawals
      ? fixture.postValidatorsBalance - preValidatorsAfterWithdrawals
      : 0n;

  return {
    pendingBalanceCap,
    activatedBalance,
    appearedBalanceLimit,
    validatorsBalanceIncrease,
    validatorsGrowthLimit,
  };
};
