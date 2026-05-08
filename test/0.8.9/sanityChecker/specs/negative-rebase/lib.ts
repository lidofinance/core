import {
  DAY,
  FormulaFixtureSet,
  getMigrationCLValidatorsBalance,
  migrate,
  MigrationStep,
  OracleReportLimits,
  ReportStep,
  ReportStepInput,
} from "../lib";

export const MAX_BASIS_POINTS = 10_000n;
export const MAX_CL_BALANCE_DECREASE_BP = 360n;
export const CL_BALANCE_WINDOW = 36n * DAY;

export { migrate };
export type { OracleReportLimits };

export type OracleReportFixture = ReportStepInput;
export type ResolvedOracleReportFixture = ReportStep;
export type NegativeRebaseStep = MigrationStep | OracleReportFixture;
export type ResolvedNegativeRebaseStep = MigrationStep | ResolvedOracleReportFixture;

export type ExpectedWindowDiff = {
  actualCLBalanceDiff: bigint;
  maxAllowedCLBalanceDiff: bigint;
};

export type NegativeRebaseFormulaCase = {
  title: string;
  rationale: string;
  limits?: Partial<OracleReportLimits>;
  steps: NegativeRebaseStep[];
  expected: {
    outcome: "revert" | "accepted";
    window?: ExpectedWindowDiff;
    lastReportCLWithdrawals?: bigint;
  };
};

export type NegativeRebaseFormulaFixtureSet = FormulaFixtureSet<NegativeRebaseFormulaCase>;

export type StoredReportModel = {
  timestamp: bigint;
  postCLBalance: bigint;
  deposits: bigint;
  clWithdrawals: bigint;
};

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
}): OracleReportFixture => ({
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

export const repeatReports = (
  count: number,
  makeReport: (index: number) => OracleReportFixture,
): OracleReportFixture[] => Array.from({ length: count }, (_, index) => makeReport(index));

export const maxDiffFor = (recreatedPostCLBalance: bigint, limits: OracleReportLimits) =>
  (recreatedPostCLBalance * limits.maxCLBalanceDecreaseBP) / MAX_BASIS_POINTS;

export const buildStoredReportsModel = (steps: ResolvedNegativeRebaseStep[]) => {
  let timestamp = 0n;
  const storedReports: StoredReportModel[] = [];

  for (const step of steps) {
    if (step.kind === "migration") {
      const migrationCLBalance = getMigrationCLValidatorsBalance(step);
      const migrationCLWithdrawals = step.withdrawalVaultBalance;
      storedReports.push({
        timestamp,
        postCLBalance: migrationCLBalance,
        deposits: 0n,
        clWithdrawals: 0n,
      });
      storedReports.push({
        timestamp,
        postCLBalance: migrationCLBalance - migrationCLWithdrawals,
        deposits: 0n,
        clWithdrawals: migrationCLWithdrawals,
      });
      continue;
    }

    const oracleReport = step;
    timestamp += oracleReport.timeElapsed;

    storedReports.push({
      timestamp,
      postCLBalance: oracleReport.cl.postValidatorsBalance + oracleReport.cl.postPendingBalance,
      deposits: oracleReport.movements.deposits,
      clWithdrawals: oracleReport.movements.clWithdrawals,
    });
  }

  return storedReports;
};

export const calcExpectedWindowDiff = (storedReports: StoredReportModel[], limits: OracleReportLimits) => {
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
    maxAllowedCLBalanceDiff: maxDiffFor(recreatedPostCLBalance, limits),
  };
};
