import { ether } from "lib";

import { NegativeRebaseFormulaFixtureSet, repeatReports, report } from "../lib";

export const commonNegativeRebaseFormulaFixtureSet: NegativeRebaseFormulaFixtureSet = {
  title: "common",
  cases: [
    {
      title: "reverts when deposits hide a negative rebase in raw CL balance snapshots",
      rationale:
        "Raw post-CL balance stays flat at 10,000 ETH, but a 500 ETH deposit means the recreated CL balance is 10,500 ETH.",
      reports: [
        report({
          label: "baseline report",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("10000"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "report with deposits and negative rebase",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("9500"),
          postPendingBalance: ether("500"),
          deposits: ether("500"),
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: ether("500"),
          maxAllowedCLBalanceDiff: ether("378"),
        },
      },
    },
    {
      title: "accepts a deposited period when the recreated balance decrease stays within the limit",
      rationale:
        "The report has a positive raw CL balance delta, but the formula still checks the recreated balance after deposits.",
      reports: [
        report({
          label: "baseline report",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("10000"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "report with deposits and tolerated negative rebase",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("9630"),
          postPendingBalance: ether("500"),
          deposits: ether("500"),
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: ether("370"),
          maxAllowedCLBalanceDiff: ether("378"),
        },
      },
    },
    {
      title: "does not count window withdrawals as a negative rebase",
      rationale: "CL withdrawals are subtracted from the recreated balance before the negative rebase diff is checked.",
      reports: [
        report({
          label: "baseline report",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("10000"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "withdrawal report",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("9500"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: ether("500"),
        }),
        report({
          label: "small negative rebase report",
          preValidatorsBalance: ether("9500"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("9499"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: ether("1"),
          maxAllowedCLBalanceDiff: ether("342"),
        },
      },
    },
    {
      title: "accepts a negative rebase exactly equal to the 36-day window limit",
      rationale: "The formula is strict only above the limit; equality is accepted.",
      reports: [
        ...repeatReports(36, (index) =>
          report({
            label: `stable report ${index + 1}`,
            preValidatorsBalance: ether("10000"),
            prePendingBalance: 0n,
            postValidatorsBalance: ether("10000"),
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 0n,
          }),
        ),
        report({
          label: "negative rebase at the limit",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("9640"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: ether("360"),
          maxAllowedCLBalanceDiff: ether("360"),
        },
      },
    },
    {
      title: "reverts when the negative rebase is one wei above the 36-day window limit",
      rationale: "This pins the strict greater-than boundary and catches accidental >= changes.",
      reports: [
        ...repeatReports(36, (index) =>
          report({
            label: `stable report ${index + 1}`,
            preValidatorsBalance: ether("10000"),
            prePendingBalance: 0n,
            postValidatorsBalance: ether("10000"),
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 0n,
          }),
        ),
        report({
          label: "negative rebase one wei above the limit",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("9640") - 1n,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: ether("360") + 1n,
          maxAllowedCLBalanceDiff: ether("360"),
        },
      },
    },
    {
      title: "reverts when small daily negative rebases accumulate above the window limit",
      rationale:
        "The check is window-based; repeated tolerated reports can still fail once their sum crosses the limit.",
      reports: [
        report({
          label: "baseline report",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("10000"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "day 1 decrease",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("9900"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "day 2 decrease",
          preValidatorsBalance: ether("9900"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("9800"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "day 3 decrease",
          preValidatorsBalance: ether("9800"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("9700"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "day 4 decrease",
          preValidatorsBalance: ether("9700"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("9600"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: ether("400"),
          maxAllowedCLBalanceDiff: ether("360"),
        },
      },
    },
    {
      title: "reverts before the old baseline leaves the 36-day window",
      rationale:
        "At exactly 36 days from the old baseline timestamp, the baseline is still inside the inclusive window.",
      reports: [
        report({
          label: "old baseline report",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("10000"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "first accepted decrease",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("9640"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        ...repeatReports(34, (index) =>
          report({
            label: `stable low-balance report ${index + 1}`,
            preValidatorsBalance: ether("9640"),
            prePendingBalance: 0n,
            postValidatorsBalance: ether("9640"),
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 0n,
          }),
        ),
        report({
          label: "decrease before old baseline eviction",
          preValidatorsBalance: ether("9640"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("9630"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: ether("370"),
          maxAllowedCLBalanceDiff: ether("360"),
        },
      },
    },
    {
      title: "accepts after the old baseline leaves the 36-day window",
      rationale: "Once the old baseline is evicted, the recreated balance starts from the newer in-window baseline.",
      reports: [
        report({
          label: "old baseline report",
          preValidatorsBalance: ether("12500"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("12500"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "new in-window baseline after accepted decrease",
          preValidatorsBalance: ether("12500"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("12250"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        ...repeatReports(35, (index) =>
          report({
            label: `stable low-balance report ${index + 1}`,
            preValidatorsBalance: ether("12250"),
            prePendingBalance: 0n,
            postValidatorsBalance: ether("12250"),
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 0n,
          }),
        ),
        report({
          label: "small decrease after old baseline eviction",
          preValidatorsBalance: ether("12250"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("12240"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: ether("10"),
          maxAllowedCLBalanceDiff: ether("441"),
        },
      },
    },
  ],
};
