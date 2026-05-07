import { ether } from "lib";

import { ClIncreaseFixtureSet, report } from "../lib";

export const commonClIncreaseFixtureSet: ClIncreaseFixtureSet = {
  title: "common",
  limits: {
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
  },
  cases: [
    {
      title: "accepts first-report deposits when they remain pending",
      rationale:
        "Deposits fund pending balance directly; they are not capped by the annual validators growth allowance.",
      steps: [
        report({
          label: "first report deposits",
          postValidatorsBalance: 0n,
          postPendingBalance: ether("500"),
          deposits: ether("500"),
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        formula: {
          pendingBalanceCap: ether("500"),
          activatedBalance: 0n,
          validatorsGrowthLimit: 0n,
        },
      },
    },
    {
      title: "accepts protocol pending exactly at the funded balance plus external cap",
      rationale: "External pending cap extends only the pending corridor.",
      limits: {
        externalPendingBalanceCapEth: 2n,
      },
      steps: [
        report({
          label: "pending at external cap",
          preValidatorsBalance: ether("1000"),
          prePendingBalance: ether("10"),
          postValidatorsBalance: ether("1000"),
          postPendingBalance: ether("12"),
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        formula: {
          pendingBalanceCap: ether("12"),
          activatedBalance: 0n,
        },
      },
    },
    {
      title: "reverts when protocol pending exceeds the funded balance plus external cap",
      rationale: "The cap tolerates bounded side deposits but does not make pending unlimited.",
      limits: {
        externalPendingBalanceCapEth: 2n,
      },
      steps: [
        report({
          label: "pending above external cap",
          preValidatorsBalance: ether("1000"),
          prePendingBalance: ether("10"),
          postValidatorsBalance: ether("1000"),
          postPendingBalance: ether("12") + 1n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "IncorrectTotalPendingBalance",
        formula: {
          pendingBalanceCap: ether("12"),
        },
      },
    },
    {
      title: "reverts when consumed pending exceeds the appeared ETH limit",
      rationale: "Pending can only move out of the pending bucket at the configured appeared-per-day rate.",
      steps: [
        report({
          label: "activation above appeared limit",
          prePendingBalance: ether("101"),
          postValidatorsBalance: 0n,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "IncorrectTotalActivatedBalance",
        formula: {
          activatedBalance: ether("101"),
          appearedBalanceLimit: ether("100"),
        },
      },
    },
    {
      title: "accepts validators growth exactly at activated pending plus safety cap",
      rationale: "Validators balance may grow by consumed pending plus the annualized safety gap.",
      steps: [
        report({
          label: "validators growth at limit",
          preValidatorsBalance: ether("3640"),
          prePendingBalance: ether("10"),
          postValidatorsBalance: ether("3651"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        formula: {
          activatedBalance: ether("10"),
          validatorsGrowthLimit: ether("11"),
          validatorsBalanceIncrease: ether("11"),
        },
      },
    },
    {
      title: "reverts when validators growth is one wei above activated pending plus safety cap",
      rationale: "The validators growth predicate is strict above the calculated budget.",
      steps: [
        report({
          label: "validators growth above limit",
          preValidatorsBalance: ether("3640"),
          prePendingBalance: ether("10"),
          postValidatorsBalance: ether("3651") + 1n,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "IncorrectTotalCLBalanceIncrease",
        formula: {
          validatorsGrowthLimit: ether("11"),
          validatorsBalanceIncrease: ether("11") + 1n,
        },
      },
    },
    {
      title: "uses CL withdrawals to reduce the validators baseline before growth is checked",
      rationale:
        "Withdrawn validators are removed from the pre-report validator baseline before the increase is measured.",
      steps: [
        report({
          label: "validators growth after CL withdrawals",
          preValidatorsBalance: ether("100"),
          prePendingBalance: ether("10"),
          postValidatorsBalance: ether("90"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: ether("20"),
        }),
      ],
      expected: {
        outcome: "accepted",
        formula: {
          activatedBalance: ether("10"),
          validatorsBalanceIncrease: ether("10"),
        },
      },
    },
  ],
};
