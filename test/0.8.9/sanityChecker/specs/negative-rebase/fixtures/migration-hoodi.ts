import { ether } from "lib";

import { migrate, NegativeRebaseFormulaFixtureSet, repeatReports, report } from "../lib";

const hoodiCLValidators = 62_500n;
const hoodiCLBalance = ether("2000000");
const hoodiMigrationWithdrawals = ether("100000");
const hoodiCLBalanceAfterMigrationWithdrawals = ether("1900000");
const hoodiNegativeRebaseLimit = ether("68400");
const hoodiFirstReportDecrease = ether("10000");
const hoodiShiftedWindowDecrease = ether("58400") + 1n;
const hoodiShiftedWindowLimit = ether("68040");

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
      title: "accepts Hoodi first report when the unexplained decrease is exactly 3.6%",
      rationale:
        "The 100,000 ETH already in the withdrawal vault is accounted as withdrawals, not as negative rebase. After that, the remaining unexplained decrease is exactly 68,400 ETH, which is 3.6% of 1,900,000 ETH.",
      steps: [
        migrate({
          label: "Hoodi finalized v4 migration",
          clValidators: hoodiCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: hoodiMigrationWithdrawals,
        }),
        report({
          label: "Hoodi first report at 3.6% unexplained decrease",
          postValidatorsBalance: hoodiCLBalanceAfterMigrationWithdrawals - hoodiNegativeRebaseLimit,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: hoodiNegativeRebaseLimit,
          maxAllowedCLBalanceDiff: hoodiNegativeRebaseLimit,
        },
      },
    },
    {
      title: "reverts Hoodi first report when the unexplained decrease is 3.6% plus 1 wei",
      rationale:
        "The migration withdrawal amount is still fully explained. The revert is only because the remaining unexplained decrease is 1 wei above the 68,400 ETH Hoodi limit.",
      steps: [
        migrate({
          label: "Hoodi finalized v4 migration",
          clValidators: hoodiCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: hoodiMigrationWithdrawals,
        }),
        report({
          label: "Hoodi first report above 3.6% unexplained decrease",
          postValidatorsBalance: hoodiCLBalanceAfterMigrationWithdrawals - hoodiNegativeRebaseLimit - 1n,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: hoodiNegativeRebaseLimit + 1n,
          maxAllowedCLBalanceDiff: hoodiNegativeRebaseLimit,
        },
      },
    },
    {
      title: "reverts Hoodi at the 36-day boundary when the migration-anchored window is over 3.6%",
      rationale:
        "At exactly 36 days, migration snapshots are still inside the window. The first report spends 10,000 ETH, and the final report goes 1 wei above the full 68,400 ETH migration-anchored limit.",
      steps: [
        migrate({
          label: "Hoodi finalized v4 migration",
          clValidators: hoodiCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: hoodiMigrationWithdrawals,
        }),
        report({
          label: "Hoodi first report inside the 36-day window",
          postValidatorsBalance: hoodiCLBalanceAfterMigrationWithdrawals - hoodiFirstReportDecrease,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        ...repeatReports(34, (index) =>
          report({
            label: `Hoodi neutral report before day 36 ${index + 2}`,
            postValidatorsBalance: hoodiCLBalanceAfterMigrationWithdrawals - hoodiFirstReportDecrease,
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 0n,
          }),
        ),
        report({
          label: "Hoodi day 36 report above the migration-anchored limit",
          postValidatorsBalance: hoodiCLBalanceAfterMigrationWithdrawals - hoodiNegativeRebaseLimit - 1n,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: hoodiNegativeRebaseLimit + 1n,
          maxAllowedCLBalanceDiff: hoodiNegativeRebaseLimit,
        },
      },
    },
    {
      title: "accepts Hoodi at day 37 after the migration snapshots leave the window",
      rationale:
        "This uses the same final CL state as the day-36 revert. At day 37, the window starts from the first real report, so only 58,400 ETH plus 1 wei remains in the checked window, under the shifted 68,040 ETH limit.",
      steps: [
        migrate({
          label: "Hoodi finalized v4 migration",
          clValidators: hoodiCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: hoodiMigrationWithdrawals,
        }),
        report({
          label: "Hoodi first report that becomes the shifted window baseline",
          postValidatorsBalance: hoodiCLBalanceAfterMigrationWithdrawals - hoodiFirstReportDecrease,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        ...repeatReports(35, (index) =>
          report({
            label: `Hoodi neutral report before day 37 ${index + 2}`,
            postValidatorsBalance: hoodiCLBalanceAfterMigrationWithdrawals - hoodiFirstReportDecrease,
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 0n,
          }),
        ),
        report({
          label: "Hoodi day 37 report with migration snapshots outside the window",
          postValidatorsBalance: hoodiCLBalanceAfterMigrationWithdrawals - hoodiNegativeRebaseLimit - 1n,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: hoodiShiftedWindowDecrease,
          maxAllowedCLBalanceDiff: hoodiShiftedWindowLimit,
        },
      },
    },
    {
      title: "keeps Hoodi migrated transient deposits in the first report, not in migration",
      rationale:
        "The 57,600 ETH migrated transient deposits are first-report deposits. They are not written into the migration bootstrap data, so the migration snapshot itself does not inflate the negative rebase window.",
      steps: [
        migrate({
          label: "Hoodi finalized v4 migration with transient deposits",
          clValidators: hoodiCLValidators,
          transientDeposits: ether("57600"),
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "Hoodi first report includes migrated transient deposits once",
          postValidatorsBalance: hoodiCLBalance - ether("74000"),
          postPendingBalance: ether("57600"),
          deposits: ether("57600"),
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: ether("74000"),
          maxAllowedCLBalanceDiff: ether("74073.6"),
        },
      },
    },
  ],
};
