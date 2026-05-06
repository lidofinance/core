import { ether } from "lib";

import { ClIncreaseFixtureSet, report } from "../lib";

export const commonClIncreaseFixtureSet: ClIncreaseFixtureSet = {
  title: "common",
  cases: [
    {
      title: "accepts first-report deposits when they remain pending",
      rationale:
        "Deposits fund pending balance directly; they are not capped by the annual validators growth allowance.",
      report: report({
        preValidatorsBalance: 0n,
        prePendingBalance: 0n,
        postValidatorsBalance: 0n,
        postPendingBalance: ether("500"),
        deposits: ether("500"),
        clWithdrawals: 0n,
      }),
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
      report: report({
        preValidatorsBalance: ether("1000"),
        prePendingBalance: ether("10"),
        postValidatorsBalance: ether("1000"),
        postPendingBalance: ether("12"),
        deposits: 0n,
        clWithdrawals: 0n,
      }),
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
      report: report({
        preValidatorsBalance: ether("1000"),
        prePendingBalance: ether("10"),
        postValidatorsBalance: ether("1000"),
        postPendingBalance: ether("12") + 1n,
        deposits: 0n,
        clWithdrawals: 0n,
      }),
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
      report: report({
        preValidatorsBalance: 0n,
        prePendingBalance: ether("101"),
        postValidatorsBalance: 0n,
        postPendingBalance: 0n,
        deposits: 0n,
        clWithdrawals: 0n,
      }),
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
      report: report({
        preValidatorsBalance: ether("3640"),
        prePendingBalance: ether("10"),
        postValidatorsBalance: ether("3651"),
        postPendingBalance: 0n,
        deposits: 0n,
        clWithdrawals: 0n,
      }),
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
      report: report({
        preValidatorsBalance: ether("3640"),
        prePendingBalance: ether("10"),
        postValidatorsBalance: ether("3651") + 1n,
        postPendingBalance: 0n,
        deposits: 0n,
        clWithdrawals: 0n,
      }),
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
      report: report({
        preValidatorsBalance: ether("100"),
        prePendingBalance: ether("10"),
        postValidatorsBalance: ether("90"),
        postPendingBalance: 0n,
        deposits: 0n,
        clWithdrawals: ether("20"),
      }),
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
