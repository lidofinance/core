export const DAY = 86_400n;
export const MAX_BASIS_POINTS = 10_000n;
export const MAX_CL_BALANCE_DECREASE_BP = 360n;
export const CL_BALANCE_WINDOW = 36n * DAY;

export type OracleReportFixture = {
  label: string;
  timeElapsed: bigint;
  cl: {
    preValidatorsBalance: bigint;
    prePendingBalance: bigint;
    postValidatorsBalance: bigint;
    postPendingBalance: bigint;
  };
  movements: {
    deposits: bigint;
    clWithdrawals: bigint;
  };
};

export type ExpectedWindowDiff = {
  actualCLBalanceDiff: bigint;
  maxAllowedCLBalanceDiff: bigint;
};

export type NegativeRebaseFormulaCase = {
  title: string;
  rationale: string;
  reports: OracleReportFixture[];
  expected: {
    outcome: "revert" | "accepted";
    window?: ExpectedWindowDiff;
  };
};

export type NegativeRebaseFormulaFixtureSet = {
  title: string;
  cases: NegativeRebaseFormulaCase[];
};

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
}: {
  label: string;
  timeElapsed?: bigint;
  preValidatorsBalance: bigint;
  prePendingBalance: bigint;
  postValidatorsBalance: bigint;
  postPendingBalance: bigint;
  deposits: bigint;
  clWithdrawals: bigint;
}): OracleReportFixture => ({
  label,
  timeElapsed,
  cl: {
    preValidatorsBalance,
    prePendingBalance,
    postValidatorsBalance,
    postPendingBalance,
  },
  movements: {
    deposits,
    clWithdrawals,
  },
});

export const repeatReports = (
  count: number,
  makeReport: (index: number) => OracleReportFixture,
): OracleReportFixture[] => Array.from({ length: count }, (_, index) => makeReport(index));

export const maxDiffFor = (recreatedPostCLBalance: bigint) =>
  (recreatedPostCLBalance * MAX_CL_BALANCE_DECREASE_BP) / MAX_BASIS_POINTS;

export const buildStoredReportsModel = (reports: OracleReportFixture[]) => {
  let timestamp = 0n;

  return reports.map((oracleReport) => {
    timestamp += oracleReport.timeElapsed;

    return {
      timestamp,
      postCLBalance: oracleReport.cl.postValidatorsBalance + oracleReport.cl.postPendingBalance,
      deposits: oracleReport.movements.deposits,
      clWithdrawals: oracleReport.movements.clWithdrawals,
    };
  });
};

export const calcExpectedWindowDiff = (storedReports: StoredReportModel[]) => {
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
