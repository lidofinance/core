import { ether } from "lib";

import { migrate, MIGRATION_CL_WITHDRAWALS, NegativeRebaseFormulaFixtureSet, report } from "../lib";

const hoodiCLValidators = 62_500n;
const hoodiCLValidatorsBalance = hoodiCLValidators * ether("32");
const hoodiFirstReportWindowLimit = ether("69926.4");
const hoodiCLDecreaseAtWindowLimit = MIGRATION_CL_WITHDRAWALS + hoodiFirstReportWindowLimit;

export const migrationHoodiNegativeRebaseFormulaFixtureSet: NegativeRebaseFormulaFixtureSet = {
  title: "migration-hoodi",
  limits: {
    exitedEthAmountPerDayLimit: 57_600n,
    appearedEthAmountPerDayLimit: 57_600n,
    annualBalanceIncreaseBPLimit: 1_000n,
    simulatedShareRateDeviationBPLimit: 250n,
    maxBalanceExitRequestedPerReportInEth: 19_200n,
    maxEffectiveBalanceWeightWCType01: 32n,
    maxEffectiveBalanceWeightWCType02: 2_048n,
    maxItemsPerExtraDataTransaction: 8n,
    maxNodeOperatorsPerExtraDataItem: 24n,
    requestTimestampMargin: 128n,
    maxPositiveTokenRebase: 5_000_000n,
    maxCLBalanceDecreaseBP: 360n,
    clBalanceOraclesErrorUpperBPLimit: 50n,
    consolidationEthAmountPerDayLimit: 93_375n,
    exitedValidatorEthAmountLimit: 32n,
    externalPendingBalanceCapEth: 300n,
  },
  cases: [
    {
      title: "accepts Hoodi first post-migration decrease at the adjusted window limit",
      rationale: "The migration bootstrap withdrawal reduces the first report window limit to 69,926.4 ETH.",
      steps: [
        migrate({
          label: "Hoodi finalized v4 migration",
          clValidators: hoodiCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: hoodiCLDecreaseAtWindowLimit,
        }),
        report({
          label: "Hoodi first report at adjusted decrease limit",
          postValidatorsBalance: hoodiCLValidatorsBalance - hoodiCLDecreaseAtWindowLimit,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: hoodiFirstReportWindowLimit,
          maxAllowedCLBalanceDiff: hoodiFirstReportWindowLimit,
        },
      },
    },
    {
      title: "reverts Hoodi first post-migration decrease one wei above the adjusted window limit",
      rationale: "With the migrated withdrawal vault baseline seeded, vault ETH cannot mask the CL decrease.",
      steps: [
        migrate({
          label: "Hoodi finalized v4 migration",
          clValidators: hoodiCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: hoodiCLDecreaseAtWindowLimit + 1n,
        }),
        report({
          label: "Hoodi first report above adjusted decrease limit",
          postValidatorsBalance: hoodiCLValidatorsBalance - hoodiCLDecreaseAtWindowLimit - 1n,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: hoodiFirstReportWindowLimit + 1n,
          maxAllowedCLBalanceDiff: hoodiFirstReportWindowLimit,
        },
      },
    },
    {
      title: "accepts Hoodi counterfactual decrease when vault balance is counted as fresh withdrawals",
      rationale: "With a zero vault baseline, the same vault delta masks the CL decrease as withdrawals.",
      steps: [
        migrate({
          label: "Hoodi counterfactual zero vault baseline",
          clValidators: hoodiCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "Hoodi first report with vault delta masking decrease",
          postValidatorsBalance: hoodiCLValidatorsBalance - hoodiCLDecreaseAtWindowLimit - 1n,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: hoodiCLDecreaseAtWindowLimit + 1n,
        }),
      ],
      expected: {
        outcome: "accepted",
        lastReportCLWithdrawals: hoodiCLDecreaseAtWindowLimit + 1n,
      },
    },
  ],
};
