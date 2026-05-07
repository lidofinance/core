import { ether } from "lib";

import { NegativeRebaseFormulaFixtureSet, repeatReports, report } from "../lib";

export const commonNegativeRebaseFormulaFixtureSet: NegativeRebaseFormulaFixtureSet = {
  title: "common",
  limits: {
    exitedEthAmountPerDayLimit: 50n,
    appearedEthAmountPerDayLimit: 75n,
    annualBalanceIncreaseBPLimit: 10_00n,
    simulatedShareRateDeviationBPLimit: 2_00n,
    maxBalanceExitRequestedPerReportInEth: 64_000n,
    maxEffectiveBalanceWeightWCType01: 32n,
    maxEffectiveBalanceWeightWCType02: 2_048n,
    maxItemsPerExtraDataTransaction: 15n,
    maxNodeOperatorsPerExtraDataItem: 16n,
    requestTimestampMargin: 128n,
    maxPositiveTokenRebase: 5_000_000n,
    maxCLBalanceDecreaseBP: 360n,
    clBalanceOraclesErrorUpperBPLimit: 50n,
    consolidationEthAmountPerDayLimit: 0n,
    exitedValidatorEthAmountLimit: 1n,
    externalPendingBalanceCapEth: 0n,
  },
  cases: [
    {
      title: "reverts when deposits hide a negative rebase in raw CL balance snapshots",
      rationale:
        "Raw post-CL balance stays flat at 10,000 ETH, but a 500 ETH deposit means the recreated CL balance is 10,500 ETH.",
      steps: [
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
      steps: [
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
      steps: [
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
          postValidatorsBalance: ether("9500"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: ether("500"),
        }),
        report({
          label: "small negative rebase report",
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
      steps: [
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
      steps: [
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
      steps: [
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
          postValidatorsBalance: ether("9900"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "day 2 decrease",
          postValidatorsBalance: ether("9800"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "day 3 decrease",
          postValidatorsBalance: ether("9700"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "day 4 decrease",
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
      steps: [
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
          postValidatorsBalance: ether("9640"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        ...repeatReports(34, (index) =>
          report({
            label: `stable low-balance report ${index + 1}`,
            postValidatorsBalance: ether("9640"),
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 0n,
          }),
        ),
        report({
          label: "decrease before old baseline eviction",
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
      steps: [
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
          postValidatorsBalance: ether("12250"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        ...repeatReports(35, (index) =>
          report({
            label: `stable low-balance report ${index + 1}`,
            postValidatorsBalance: ether("12250"),
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 0n,
          }),
        ),
        report({
          label: "small decrease after old baseline eviction",
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
