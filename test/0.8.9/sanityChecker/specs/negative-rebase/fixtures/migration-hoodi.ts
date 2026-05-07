import { ether } from "lib";

import { migrate, MIGRATION_CL_WITHDRAWALS, NegativeRebaseFormulaFixtureSet, report } from "../lib";

const hoodiCLValidators = 62_500n;
const hoodiCLValidatorsBalance = hoodiCLValidators * ether("32");
const hoodiMigratedTransientDeposits = ether("57600");
const hoodiUnadjustedFirstReportWindowLimit = ether("72000");
const hoodiWindowOverstatementWithoutMigrationWithdrawal = ether("2073.6");
const hoodiFirstReportWindowLimit =
  hoodiUnadjustedFirstReportWindowLimit - hoodiWindowOverstatementWithoutMigrationWithdrawal;
const hoodiCLDecreaseAtWindowLimit = MIGRATION_CL_WITHDRAWALS + hoodiFirstReportWindowLimit;
const hoodiDecreaseMaskedByZeroVaultBaseline = hoodiCLDecreaseAtWindowLimit + 1n;
const hoodiRawDecreaseWithTransientDeposits = hoodiMigratedTransientDeposits + hoodiUnadjustedFirstReportWindowLimit;

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
      rationale:
        "Without the migration bootstrap withdrawal, the Hoodi window would be overstated by 2,073.6 ETH: 72,000 ETH instead of 69,926.4 ETH.",
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
      rationale:
        "With the migrated vault baseline seeded, a 127,526.4 ETH + 1 wei raw CL drop is observed as a 69,926.4 ETH + 1 wei negative rebase.",
      steps: [
        migrate({
          label: "Hoodi finalized v4 migration",
          clValidators: hoodiCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: hoodiDecreaseMaskedByZeroVaultBaseline,
        }),
        report({
          label: "Hoodi first report above adjusted decrease limit",
          postValidatorsBalance: hoodiCLValidatorsBalance - hoodiDecreaseMaskedByZeroVaultBaseline,
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
      rationale:
        "With a zero vault baseline, 127,526.4 ETH + 1 wei is recorded as fresh CL withdrawals, understating the negative rebase to zero.",
      steps: [
        migrate({
          label: "Hoodi counterfactual zero vault baseline",
          clValidators: hoodiCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "Hoodi first report with vault delta masking decrease",
          postValidatorsBalance: hoodiCLValidatorsBalance - hoodiDecreaseMaskedByZeroVaultBaseline,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: hoodiDecreaseMaskedByZeroVaultBaseline,
        }),
      ],
      expected: {
        outcome: "accepted",
        lastReportCLWithdrawals: hoodiDecreaseMaskedByZeroVaultBaseline,
      },
    },
    {
      title: "does not overstate Hoodi negative rebase with migrated transient deposits",
      rationale:
        "Deposits in the migration snapshot overstate negative rebase: adding the 57,600 ETH transient backlog there would make this 72,000 ETH decrease look like 129,600 ETH. The backlog is safe only in the first report, where the same 57,600 ETH also appears as post-pending balance.",
      steps: [
        migrate({
          label: "Hoodi finalized v4 migration with transient deposits",
          clValidators: hoodiCLValidators,
          transientDeposits: hoodiMigratedTransientDeposits,
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "Hoodi first report includes migrated transient deposits once",
          postValidatorsBalance: hoodiCLValidatorsBalance - hoodiRawDecreaseWithTransientDeposits,
          postPendingBalance: hoodiMigratedTransientDeposits,
          deposits: hoodiMigratedTransientDeposits,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: hoodiUnadjustedFirstReportWindowLimit,
          maxAllowedCLBalanceDiff: hoodiUnadjustedFirstReportWindowLimit,
        },
      },
    },
  ],
};
