const DAY = 86_400n;

const eth = (value: bigint) => value * 10n ** 18n;

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

export type WindowFormulaCase = {
  title: string;
  reports: OracleReportFixture[];
  expectedOutcome: "revert" | "accepted";
};

export const negativeRebaseWindowFormulaCases: WindowFormulaCase[] = [
  {
    title: "reverts when deposits hide a negative rebase in raw CL balance snapshots",
    reports: [
      // Seeds the window with a clean baseline balance and no CL movements.
      {
        label: "baseline report",
        timeElapsed: DAY,
        cl: {
          preValidatorsBalance: eth(10_000n),
          prePendingBalance: 0n,
          postValidatorsBalance: eth(10_000n),
          postPendingBalance: 0n,
        },
        movements: {
          deposits: 0n,
          clWithdrawals: 0n,
        },
      },
      // Keeps total reported CL balance flat, but deposits mean the recreated balance should be higher.
      {
        label: "report with deposits and negative rebase",
        timeElapsed: DAY,
        cl: {
          preValidatorsBalance: eth(10_000n),
          prePendingBalance: 0n,
          postValidatorsBalance: eth(9_500n),
          postPendingBalance: eth(500n),
        },
        movements: {
          deposits: eth(500n),
          clWithdrawals: 0n,
        },
      },
    ],
    expectedOutcome: "revert",
  },
  {
    title: "does not count window withdrawals as a negative rebase",
    reports: [
      // Seeds the withdrawal scenario with a stable baseline balance.
      {
        label: "baseline report",
        timeElapsed: DAY,
        cl: {
          preValidatorsBalance: eth(10_000n),
          prePendingBalance: 0n,
          postValidatorsBalance: eth(10_000n),
          postPendingBalance: 0n,
        },
        movements: {
          deposits: 0n,
          clWithdrawals: 0n,
        },
      },
      // Moves ETH out through CL withdrawals; this validator balance drop is not a negative rebase.
      {
        label: "withdrawal report",
        timeElapsed: DAY,
        cl: {
          preValidatorsBalance: eth(10_000n),
          prePendingBalance: 0n,
          postValidatorsBalance: eth(9_500n),
          postPendingBalance: 0n,
        },
        movements: {
          deposits: 0n,
          clWithdrawals: eth(500n),
        },
      },
      // Adds a small post-withdrawal negative rebase that stays within the allowed window diff.
      {
        label: "small negative rebase report",
        timeElapsed: DAY,
        cl: {
          preValidatorsBalance: eth(9_500n),
          prePendingBalance: 0n,
          postValidatorsBalance: eth(9_499n),
          postPendingBalance: 0n,
        },
        movements: {
          deposits: 0n,
          clWithdrawals: 0n,
        },
      },
    ],
    expectedOutcome: "accepted",
  },
  {
    title: "accepts a negative rebase exactly equal to the 36-day window limit",
    reports: [
      // Fills the whole 36-day window with stable CL balance snapshots.
      ...Array(36).fill({
        label: "stable report",
        timeElapsed: DAY,
        cl: {
          preValidatorsBalance: eth(10_000n),
          prePendingBalance: 0n,
          postValidatorsBalance: eth(10_000n),
          postPendingBalance: 0n,
        },
        movements: {
          deposits: 0n,
          clWithdrawals: 0n,
        },
      }),
      // Drops by exactly 3.6% of the recreated post CL balance, so it is accepted.
      {
        label: "negative rebase at the limit",
        timeElapsed: DAY,
        cl: {
          preValidatorsBalance: eth(10_000n),
          prePendingBalance: 0n,
          postValidatorsBalance: eth(9_640n),
          postPendingBalance: 0n,
        },
        movements: {
          deposits: 0n,
          clWithdrawals: 0n,
        },
      },
    ],
    expectedOutcome: "accepted",
  },
];
