import { ether } from "lib";

import { ModuleBalanceFixtureSet, moduleReport } from "../lib";

export const commonModuleBalanceFixtureSet: ModuleBalanceFixtureSet = {
  title: "common",
  limits: {
    exitedEthAmountPerDayLimit: 100n,
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
      title: "accepts a first report for a module without previous accounting",
      rationale: "A module without previous accounting is not included in module-delta aggregation.",
      steps: [
        moduleReport({
          label: "first module report",
          preCLValidatorsBalance: ether("120"),
          postCLPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
          modules: [
            {
              moduleId: 1n,
              previousValidatorsBalance: 0n,
              postValidatorsBalance: ether("120"),
              hasPreviousAccounting: false,
            },
          ],
        }),
      ],
      expected: {
        outcome: "accepted",
        formula: {
          totalPositiveModuleDelta: 0n,
        },
      },
    },
    {
      title: "accepts pending-to-validators activation inside one module",
      rationale: "Consumed protocol pending funds the validators increase before the safety cap is needed.",
      steps: [
        moduleReport({
          label: "pending activation report",
          preCLPendingBalance: ether("50"),
          postCLPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
          modules: [
            {
              moduleId: 1n,
              previousValidatorsBalance: ether("1000"),
              postValidatorsBalance: ether("1050"),
            },
          ],
        }),
      ],
      expected: {
        outcome: "accepted",
        formula: {
          activatedBalance: ether("50"),
          validatorsBalanceIncrease: ether("50"),
          totalPositiveModuleDelta: ether("50"),
        },
      },
    },
    {
      title: "reverts when global validators growth exceeds activated pending plus safety cap",
      rationale: "The global CL validators increase is checked before the per-module aggregation.",
      steps: [
        moduleReport({
          label: "global validators growth above limit",
          preCLPendingBalance: ether("10"),
          postCLPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
          modules: [
            {
              moduleId: 1n,
              previousValidatorsBalance: ether("3640"),
              postValidatorsBalance: ether("3651") + 1n,
            },
          ],
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
      title: "accepts redistribution between modules within the consolidation corridor",
      rationale: "Total validators balance is unchanged; only the positive per-module delta consumes module corridor.",
      steps: [
        moduleReport({
          label: "redistribution inside corridor",
          postCLPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
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
      ],
      expected: {
        outcome: "accepted",
        formula: {
          totalPositiveModuleDelta: ether("10"),
        },
      },
    },
    {
      title: "reverts when module-positive deltas exceed activation plus consolidation corridor",
      rationale: "A matching decrease in another module keeps total CL flat, so only the module corridor can fail.",
      steps: [
        moduleReport({
          label: "first post-migration module report",
          postCLPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
          modules: [
            {
              moduleId: 1n,
              previousValidatorsBalance: ether("1825"),
              postValidatorsBalance: ether("1813"),
            },
            {
              moduleId: 2n,
              previousValidatorsBalance: ether("1825"),
              postValidatorsBalance: ether("1837"),
            },
          ],
        }),
        moduleReport({
          label: "module-positive delta above corridor",
          postCLPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
          modules: [
            {
              moduleId: 1n,
              previousValidatorsBalance: ether("1813"),
              postValidatorsBalance: ether("1802") - 1n,
            },
            {
              moduleId: 2n,
              previousValidatorsBalance: ether("1837"),
              postValidatorsBalance: ether("1848") + 1n,
            },
          ],
        }),
      ],
      expected: {
        outcome: "IncorrectTotalModuleValidatorsBalanceIncrease",
        formula: {
          moduleValidatorsGrowthLimit: ether("11"),
          totalPositiveModuleDelta: ether("11") + 1n,
        },
      },
    },
    {
      title: "reverts when consumed pending exceeds the appeared ETH limit",
      rationale: "Module checks share the same activation limit as the protocol-level CL pending check.",
      steps: [
        moduleReport({
          label: "activation above appeared limit",
          preCLPendingBalance: ether("101"),
          postCLPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
          modules: [
            {
              moduleId: 1n,
              previousValidatorsBalance: ether("1000"),
              postValidatorsBalance: ether("1000"),
            },
          ],
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
  ],
};
