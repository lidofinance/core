import { ether } from "lib";

import { DAY, HOUR, MAX_VALIDATOR_EFFECTIVE_BALANCE, ModuleBalanceFixtureSet, moduleReport } from "../lib";

const ZERO_ANNUAL_SOFT_LIMIT = { annualCLRebaseIncreaseSoftBPLimit: 0n };

export const commonModuleBalanceFixtureSet: ModuleBalanceFixtureSet = {
  title: "current module-growth formula",
  limits: {
    exitedEthAmountPerDayLimit: 100n,
    appearedEthAmountPerDayLimit: 100n,
    annualCLRebaseIncreaseSoftBPLimit: 1_000n,
    simulatedShareRateDeviationBPLimit: 250n,
    maxBalanceExitRequestedPerReportInEth: 65_000n,
    maxEffectiveBalanceWeightWCType01: 32n,
    maxEffectiveBalanceWeightWCType02: 2_048n,
    maxItemsPerExtraDataTransaction: 15n,
    maxNodeOperatorsPerExtraDataItem: 16n,
    requestTimestampMargin: 128n,
    annualCLRebaseIncreaseHardBPLimit: 2_000n,
    clRebaseDecreaseSoftBPLimit: 100n,
    clRebaseDecreaseHardBPLimit: 500n,
    consolidationEthAmountPerDayLimit: 10n,
    exitedValidatorEthAmountLimit: 32n,
    externalPendingBalanceCapEth: 5n,
  },
  cases: [
    {
      title: "skips the first positive balance of a newly registered empty module",
      rationale: "An empty module has no previous accounting baseline, so its first delta is not aggregated.",
      report: moduleReport({
        preCLValidatorsBalance: 0n,
        modules: [
          {
            moduleId: 1n,
            previousValidatorsBalance: 0n,
            postValidatorsBalance: ether("120"),
            hasPreviousAccounting: false,
          },
        ],
      }),
      expected: {
        outcome: "accepted",
        formula: {
          grossPositiveModuleDeltas: 0n,
        },
      },
    },
    {
      title: "funds activation from deposits and calculates rewards on the activated balance",
      rationale:
        "Deposits join pending before activation, and the annual soft allowance uses validators plus activation.",
      limits: {
        consolidationEthAmountPerDayLimit: 0n,
      },
      report: moduleReport({
        deposits: ether("50"),
        modules: [
          {
            moduleId: 1n,
            previousValidatorsBalance: ether("3600"),
            postValidatorsBalance: ether("3651"),
          },
        ],
      }),
      expected: {
        outcome: "accepted",
        formula: {
          fundedPendingBalance: ether("50"),
          activatedBalance: ether("50"),
          annualSoftAllowance: ether("1"),
          grossPositiveModuleDeltas: ether("51"),
          moduleGrowthLimit: ether("51"),
        },
      },
    },
    {
      title: "accepts pending exactly at funded pending plus the external cap",
      rationale: "The external-pending allowance extends the pending corridor inclusively.",
      report: moduleReport({
        preCLPendingBalance: ether("10"),
        postCLPendingBalance: ether("17"),
        deposits: ether("2"),
        modules: [
          {
            moduleId: 1n,
            previousValidatorsBalance: ether("1000"),
            postValidatorsBalance: ether("1000"),
          },
        ],
      }),
      expected: {
        outcome: "accepted",
        formula: {
          fundedPendingBalance: ether("12"),
          pendingBalanceCap: ether("17"),
        },
      },
    },
    {
      title: "rejects pending above funded pending plus the external cap",
      rationale: "The external-pending allowance is a cap and does not fund module growth.",
      report: moduleReport({
        preCLPendingBalance: ether("10"),
        postCLPendingBalance: ether("17") + 1n,
        deposits: ether("2"),
        modules: [
          {
            moduleId: 1n,
            previousValidatorsBalance: ether("1000"),
            postValidatorsBalance: ether("1000"),
          },
        ],
      }),
      expected: {
        outcome: "IncorrectTotalPendingBalance",
        formula: {
          fundedPendingBalance: ether("12"),
          pendingBalanceCap: ether("17"),
        },
      },
    },
    {
      title: "allows period-limited activation while the remaining deposits stay pending",
      rationale: "Only consumed pending is activation; unactivated deposits remain in the bounded pending balance.",
      limits: {
        ...ZERO_ANNUAL_SOFT_LIMIT,
        consolidationEthAmountPerDayLimit: 0n,
      },
      report: moduleReport({
        deposits: ether("2200"),
        postCLPendingBalance: ether("52"),
        modules: [
          {
            moduleId: 1n,
            previousValidatorsBalance: ether("1000"),
            postValidatorsBalance: ether("3148"),
          },
        ],
      }),
      expected: {
        outcome: "accepted",
        formula: {
          fundedPendingBalance: ether("2200"),
          activatedBalance: ether("2148"),
          activatedBalanceLimit: ether("2148"),
          grossPositiveModuleDeltas: ether("2148"),
          moduleGrowthLimit: ether("2148"),
        },
      },
    },
    {
      title: "rejects activation above the period allowance plus one 2048 ETH validator",
      rationale: "The discrete-activation allowance is inclusive and the next wei must fail.",
      report: moduleReport({
        preCLPendingBalance: ether("100") + MAX_VALIDATOR_EFFECTIVE_BALANCE + 1n,
        modules: [
          {
            moduleId: 1n,
            previousValidatorsBalance: ether("1000"),
            postValidatorsBalance: ether("1000"),
          },
        ],
      }),
      expected: {
        outcome: "IncorrectTotalActivatedBalance",
        formula: {
          activatedBalance: ether("100") + MAX_VALIDATOR_EFFECTIVE_BALANCE + 1n,
          appearedBalanceAllowance: ether("100"),
          activatedBalanceLimit: ether("100") + MAX_VALIDATOR_EFFECTIVE_BALANCE,
        },
      },
    },
    {
      title: "accepts redistribution exactly at the consolidation allowance",
      rationale: "A flat aggregate balance may move between modules up to the consolidation throughput budget.",
      limits: ZERO_ANNUAL_SOFT_LIMIT,
      report: moduleReport({
        modules: [
          {
            moduleId: 1n,
            previousValidatorsBalance: ether("1000"),
            postValidatorsBalance: ether("990"),
          },
          {
            moduleId: 2n,
            previousValidatorsBalance: ether("1000"),
            postValidatorsBalance: ether("1010"),
          },
        ],
      }),
      expected: {
        outcome: "accepted",
        formula: {
          consolidationAllowance: ether("10"),
          grossPositiveModuleDeltas: ether("10"),
          moduleGrowthLimit: ether("10"),
        },
      },
    },
    {
      title: "rejects redistribution one wei above the consolidation allowance",
      rationale: "Only positive module deltas count, even when another module offsets the increase.",
      limits: ZERO_ANNUAL_SOFT_LIMIT,
      report: moduleReport({
        modules: [
          {
            moduleId: 1n,
            previousValidatorsBalance: ether("1000"),
            postValidatorsBalance: ether("990") - 1n,
          },
          {
            moduleId: 2n,
            previousValidatorsBalance: ether("1000"),
            postValidatorsBalance: ether("1010") + 1n,
          },
        ],
      }),
      expected: {
        outcome: "IncorrectTotalModuleValidatorsBalanceIncrease",
        formula: {
          grossPositiveModuleDeltas: ether("10") + 1n,
          moduleGrowthLimit: ether("10"),
        },
      },
    },
    {
      title: "aggregates simultaneous positive deltas across modules",
      rationale: "Splitting growth across modules cannot bypass the shared gross-positive budget.",
      limits: ZERO_ANNUAL_SOFT_LIMIT,
      report: moduleReport({
        modules: [
          {
            moduleId: 1n,
            previousValidatorsBalance: ether("100"),
            postValidatorsBalance: ether("106"),
          },
          {
            moduleId: 2n,
            previousValidatorsBalance: ether("100"),
            postValidatorsBalance: ether("105"),
          },
          {
            moduleId: 3n,
            previousValidatorsBalance: ether("100"),
            postValidatorsBalance: ether("89"),
          },
        ],
      }),
      expected: {
        outcome: "IncorrectTotalModuleValidatorsBalanceIncrease",
        formula: {
          grossPositiveModuleDeltas: ether("11"),
          moduleGrowthLimit: ether("10"),
        },
      },
    },
    {
      title: "uses a one-hour allowance window when elapsed time is zero",
      rationale:
        "Scratch-deploy reports use the same bounded effective interval for appeared and consolidation limits.",
      limits: ZERO_ANNUAL_SOFT_LIMIT,
      report: (() => {
        const appearedAllowance = (ether("100") * HOUR) / DAY;
        const consolidationAllowance = (ether("10") * HOUR) / DAY;
        const activatedBalance = appearedAllowance + MAX_VALIDATOR_EFFECTIVE_BALANCE;

        return moduleReport({
          timeElapsed: 0n,
          preCLPendingBalance: activatedBalance,
          modules: [
            {
              moduleId: 1n,
              previousValidatorsBalance: ether("5000"),
              postValidatorsBalance: ether("5000") + activatedBalance + consolidationAllowance,
            },
            {
              moduleId: 2n,
              previousValidatorsBalance: ether("5000"),
              postValidatorsBalance: ether("5000") - consolidationAllowance,
            },
          ],
        });
      })(),
      expected: {
        outcome: "accepted",
        formula: {
          effectiveTimeElapsed: HOUR,
          appearedBalanceAllowance: (ether("100") * HOUR) / DAY,
          activatedBalanceLimit: (ether("100") * HOUR) / DAY + MAX_VALIDATOR_EFFECTIVE_BALANCE,
          consolidationAllowance: (ether("10") * HOUR) / DAY,
        },
      },
    },
    {
      title: "rejects activation one wei above the one-hour allowance",
      rationale: "The zero-elapsed fallback applies to the appeared limit as well as the consolidation limit.",
      limits: ZERO_ANNUAL_SOFT_LIMIT,
      report: (() => {
        const activatedBalance = (ether("100") * HOUR) / DAY + MAX_VALIDATOR_EFFECTIVE_BALANCE + 1n;

        return moduleReport({
          timeElapsed: 0n,
          preCLPendingBalance: activatedBalance,
          modules: [
            {
              moduleId: 1n,
              previousValidatorsBalance: ether("5000"),
              postValidatorsBalance: ether("5000"),
            },
          ],
        });
      })(),
      expected: {
        outcome: "IncorrectTotalActivatedBalance",
        formula: {
          effectiveTimeElapsed: HOUR,
          appearedBalanceAllowance: (ether("100") * HOUR) / DAY,
          activatedBalanceLimit: (ether("100") * HOUR) / DAY + MAX_VALIDATOR_EFFECTIVE_BALANCE,
        },
      },
    },
  ],
};
