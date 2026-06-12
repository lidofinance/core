import { ether } from "lib";

import {
  DAY,
  FormulaFixtureSet,
  migrate,
  MigrationStep,
  OracleReportLimits,
  ReportStep,
  ReportStepInput,
} from "../lib";

export { migrate };
export type { OracleReportLimits };

export const HOUR = 3_600n;
export const MAX_BASIS_POINTS = 10_000n;
export const ANNUAL_BALANCE_INCREASE_DENOMINATOR = 365n * DAY * MAX_BASIS_POINTS;

export type ClIncreaseLimits = Pick<
  OracleReportLimits,
  "appearedEthAmountPerDayLimit" | "annualBalanceIncreaseBPLimit" | "externalPendingBalanceCapEth"
>;

export type ClIncreaseReport = ReportStepInput;
export type ResolvedClIncreaseReport = ReportStep;
export type ClIncreaseStep = MigrationStep | ClIncreaseReport;

export type ClIncreaseFormula = {
  pendingBalanceCap: bigint;
  activatedBalance: bigint;
  appearedBalanceLimit: bigint;
  validatorsBalanceIncrease: bigint;
  validatorsGrowthLimit: bigint;
};

export type MigrationFrameExpectation = {
  sameFrameDepositsForReport: bigint;
  sameFrameFundedPendingBalance: bigint;
  firstPostMigrationFrameDepositsForReport: bigint;
  firstPostMigrationFrameFundedPendingBalance: bigint;
};

export type ClIncreaseCase = {
  title: string;
  rationale: string;
  limits?: Partial<OracleReportLimits>;
  steps: ClIncreaseStep[];
  expected: {
    outcome:
      | "accepted"
      | "IncorrectTotalPendingBalance"
      | "IncorrectTotalActivatedBalance"
      | "IncorrectTotalCLBalanceIncrease"
      | "validatorsGrowthBoundary";
    formula?: Partial<ClIncreaseFormula>;
    migrationFrame?: MigrationFrameExpectation;
    counterfactualZeroVaultBaseline?: boolean;
  };
};

export type ClIncreaseFixtureSet = FormulaFixtureSet<ClIncreaseCase>;

export const report = ({
  label,
  timeElapsed = DAY,
  preValidatorsBalance,
  prePendingBalance,
  postValidatorsBalance,
  postPendingBalance,
  deposits,
  clWithdrawals,
  withdrawalsVaultTransfer,
}: {
  label: string;
  timeElapsed?: bigint;
  preValidatorsBalance?: bigint;
  prePendingBalance?: bigint;
  postValidatorsBalance: bigint;
  postPendingBalance: bigint;
  deposits: bigint;
  clWithdrawals: bigint;
  withdrawalsVaultTransfer?: bigint;
}): ClIncreaseReport => ({
  kind: "report",
  label,
  timeElapsed,
  cl: {
    ...(preValidatorsBalance === undefined ? {} : { preValidatorsBalance }),
    ...(prePendingBalance === undefined ? {} : { prePendingBalance }),
    postValidatorsBalance,
    postPendingBalance,
  },
  movements: {
    deposits,
    clWithdrawals,
    withdrawalsVaultTransfer,
  },
});

export const calcClIncreaseFormula = (
  fixture: ResolvedClIncreaseReport,
  limits: ClIncreaseLimits,
): ClIncreaseFormula => {
  const effectiveTimeElapsed = fixture.timeElapsed === 0n ? HOUR : fixture.timeElapsed;
  const fundedPendingBalance = fixture.cl.prePendingBalance + fixture.movements.deposits;
  const pendingBalanceCap = fundedPendingBalance + ether(limits.externalPendingBalanceCapEth.toString());
  const activatedBalance =
    fundedPendingBalance > fixture.cl.postPendingBalance ? fundedPendingBalance - fixture.cl.postPendingBalance : 0n;
  const appearedBalanceLimit = (ether(limits.appearedEthAmountPerDayLimit.toString()) * effectiveTimeElapsed) / DAY;
  const validatorsGrowthLimit =
    activatedBalance +
    ((fixture.cl.preValidatorsBalance + activatedBalance) *
      limits.annualBalanceIncreaseBPLimit *
      effectiveTimeElapsed) /
      ANNUAL_BALANCE_INCREASE_DENOMINATOR;
  const preValidatorsAfterWithdrawals =
    fixture.movements.clWithdrawals >= fixture.cl.preValidatorsBalance
      ? 0n
      : fixture.cl.preValidatorsBalance - fixture.movements.clWithdrawals;
  const validatorsBalanceIncrease =
    fixture.cl.postValidatorsBalance > preValidatorsAfterWithdrawals
      ? fixture.cl.postValidatorsBalance - preValidatorsAfterWithdrawals
      : 0n;

  return {
    pendingBalanceCap,
    activatedBalance,
    appearedBalanceLimit,
    validatorsBalanceIncrease,
    validatorsGrowthLimit,
  };
};
