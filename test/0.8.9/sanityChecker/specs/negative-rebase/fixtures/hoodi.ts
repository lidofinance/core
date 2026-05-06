import { ether } from "lib";

import { NegativeRebaseFormulaFixtureSet, report } from "../lib";

export const hoodiNegativeRebaseFormulaFixtureSet: NegativeRebaseFormulaFixtureSet = {
  title: "hoodi",
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
  ],
};
