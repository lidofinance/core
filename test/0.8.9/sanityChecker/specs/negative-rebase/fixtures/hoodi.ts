import { ether } from "lib";

import { NegativeRebaseFormulaFixtureSet, repeatReports, report } from "../lib";

export const hoodiNegativeRebaseFormulaFixtureSet: NegativeRebaseFormulaFixtureSet = {
  title: "hoodi",
  limits: {
    exitedEthAmountPerDayLimit: 57_600n,
    appearedEthAmountPerDayLimit: 57_600n,
    annualBalanceIncreaseBPLimit: 1_000n,
    simulatedShareRateDeviationBPLimit: 50n,
    maxBalanceExitRequestedPerReportInEth: 19_200n,
    maxEffectiveBalanceWeightWCType01: 32n,
    maxEffectiveBalanceWeightWCType02: 2_048n,
    maxItemsPerExtraDataTransaction: 8n,
    maxNodeOperatorsPerExtraDataItem: 24n,
    requestTimestampMargin: 128n,
    maxPositiveTokenRebase: 750_000n,
    maxCLBalanceDecreaseBP: 360n,
    clBalanceOraclesErrorUpperBPLimit: 50n,
    consolidationEthAmountPerDayLimit: 93_375n,
    exitedValidatorEthAmountLimit: 32n,
    externalPendingBalanceCapEth: 300n,
  },
  cases: [
    {
      title: "[Hoodi] accepts a max negative rebase inside the window limit",
      rationale: "A 1 ETH CL balance decrease is well inside the 36-day Hoodi negative rebase limit.",
      steps: [
        report({
          label: "Hoodi previous accepted report",
          preValidatorsBalance: ether("2000000"),
          postValidatorsBalance: ether("2000000"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "Hoodi happy path report",
          postValidatorsBalance: ether("2000000") - (ether("2000") * 36n - ether("1")),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: ether("71999"),
          maxAllowedCLBalanceDiff: ether("72000"),
        },
      },
    },
    {
      title: "accepts Hoodi activation at the deployed appeared ETH limit",
      rationale: "The deployed Hoodi appeared limit is 57,600 ETH per day.",
      steps: [
        report({
          label: "Hoodi baseline report",
          preValidatorsBalance: ether("10000"),
          postValidatorsBalance: ether("10000"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "Hoodi activation report",
          postValidatorsBalance: ether("67600"),
          postPendingBalance: ether("10000"),
          deposits: ether("67600"),
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
      },
    },
    {
      title: "[Hoodi] revert a max negative rebase inside the window limit",
      rationale: "A 1 ETH CL balance decrease is well inside the 36-day Hoodi negative rebase limit.",
      steps: [
        report({
          label: "Hoodi previous accepted report",
          preValidatorsBalance: ether("2000000"),
          postValidatorsBalance: ether("2000000"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "Hoodi negative rebase",
          postValidatorsBalance: ether("2000000") - (ether("2000") * 36n + ether("1")),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: ether("72001"),
          maxAllowedCLBalanceDiff: ether("72000"),
        },
      },
    },
    {
      title: "[Hoodi] accepted a max negative rebase inside the full window limit",
      rationale: "A 1 ETH CL balance decrease is well inside the 36-day Hoodi negative rebase limit.",
      steps: [
        report({
          label: `Report before slashing`,
          preValidatorsBalance: ether("2000000"),
          postValidatorsBalance: ether("2000000"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        ...repeatReports(16, (index) =>
          report({
            label: `Initial slashing + val penalty report ${index + 1}`,
            postValidatorsBalance: ether("2000000") - ether("100") - ether("10") * BigInt(index + 1),
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 100n,
          }),
        ),
        report({
          label: `Mid-term penalty report ${18}`,
          postValidatorsBalance: ether("1999720") - (ether("2000") * 36n - ether("280") - ether("170")),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 100n,
        }),
        ...repeatReports(16, (index) =>
          report({
            label: `Val penalty report ${index + 19}`,
            postValidatorsBalance: ether("1928170") - ether("9") * BigInt(index + 1),
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 100n,
          }),
        ),
        report({
          label: `Not triggered negative rebase report 36`,
          postValidatorsBalance: ether("1928026") - ether("0.00000001"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: ether("71974.000000009999996700"),
          maxAllowedCLBalanceDiff: ether("71999.999999999999999881"),
        },
      },
    },
    {
      title: "[Hoodi] revert a max negative rebase inside the full window limit",
      rationale: "A 1 ETH CL balance decrease is well inside the 36-day Hoodi negative rebase limit.",
      steps: [
        report({
          label: `Report before slashing`,
          preValidatorsBalance: ether("2000000"),
          postValidatorsBalance: ether("2000000"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        ...repeatReports(16, (index) =>
          report({
            label: `Initial slashing + val penalty report ${index + 1}`,
            postValidatorsBalance: ether("2000000") - ether("100") - ether("10") * BigInt(index + 1),
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 100n,
          }),
        ),
        report({
          label: `Mid-term penalty report ${18}`,
          postValidatorsBalance: ether("1999720") - (ether("2000") * 36n - ether("280") - ether("170")),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 100n,
        }),
        ...repeatReports(16, (index) =>
          report({
            label: `Val penalty report ${index + 19}`,
            postValidatorsBalance: ether("1928170") - ether("9") * BigInt(index + 1),
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 100n,
          }),
        ),
        report({
          label: `Not triggered negative rebase report 36`,
          postValidatorsBalance: ether("1928026") - ether("27"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: ether("72000.999999999999996700"),
          maxAllowedCLBalanceDiff: ether("71999.999999999999999881"),
        },
      },
    },
    {
      title: "[Hoodi] revert a max negative rebase inside the full window limit with deposits equals slashing",
      rationale: "A 1 ETH CL balance decrease is well inside the 36-day Hoodi negative rebase limit.",
      steps: [
        report({
          label: `Report before slashing`,
          preValidatorsBalance: ether("2000000"),
          postValidatorsBalance: ether("2000000"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        ...repeatReports(16, (index) =>
          report({
            label: `Initial slashing + val penalty report ${index + 1}`,
            postValidatorsBalance: ether("2000000") - ether("100") - ether("10") * BigInt(index + 1),
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 100n,
          }),
        ),
        report({
          label: `Mid-term penalty report ${18}`,
          postValidatorsBalance: ether("1999720") - (ether("2000") * 36n - ether("280") - ether("135")),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 100n,
        }),
        ...repeatReports(15, (index) =>
          report({
            label: `Val penalty report ${index + 19}`,
            postValidatorsBalance: ether("1928170") - ether("9") * BigInt(index + 1),
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 100n,
          }),
        ),
        report({
          label: `34 report with deposit`,
          postValidatorsBalance: ether("1985635"),
          postPendingBalance: 0n,
          deposits: ether("57600"),
          clWithdrawals: 0n,
        }),
        report({
          label: `Triggered negative rebase report 35`,
          postValidatorsBalance: ether("1985635") - ether("2109"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: ether("74073.999999999999996800"),
          maxAllowedCLBalanceDiff: ether("74073.599999999999999884"),
        },
      },
    },
  ],
};
