import { ether } from "lib";

import { NegativeRebaseFormulaFixtureSet, report } from "../lib";

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
      title: "accepts a small Hoodi negative rebase inside the window limit",
      rationale: "A 1 ETH CL balance decrease is well inside the 36-day Hoodi negative rebase limit.",
      reports: [
        report({
          label: "Hoodi previous accepted report",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("10000"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "Hoodi happy path report",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("9999"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: ether("1"),
          maxAllowedCLBalanceDiff: ether("360"),
        },
      },
    },
    {
      title: "accepts Hoodi activation at the deployed appeared ETH limit",
      rationale: "The deployed Hoodi appeared limit is 57,600 ETH per day.",
      reports: [
        report({
          label: "Hoodi baseline report",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
          postValidatorsBalance: ether("10000"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "Hoodi activation report",
          preValidatorsBalance: ether("10000"),
          prePendingBalance: 0n,
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
  ],
};
