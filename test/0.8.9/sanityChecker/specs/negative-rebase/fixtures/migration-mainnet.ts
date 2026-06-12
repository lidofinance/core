import { ether } from "lib";

import { migrate, NegativeRebaseFormulaFixtureSet, repeatReports, report } from "../lib";

const mainnetCLValidators = 281_250n;
// const mainnetCLBalance = ether("9000000");
const mainnetMigrationWithdrawals = ether("400000");
const mainnetCLBalanceAfterMigrationWithdrawals = ether("8600000");
const mainnetNegativeRebaseLimit = ether("309600");
const mainnetFirstReportDecrease = ether("100000");
const mainnetShiftedWindowDecrease = ether("209600") + 1n;
const mainnetShiftedWindowLimit = ether("306000");

export const migrationMainnetNegativeRebaseFormulaFixtureSet: NegativeRebaseFormulaFixtureSet = {
  title: "migration-mainnet",
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
      title: "accepts Mainnet first report when the unexplained decrease is exactly 3.6%",
      rationale:
        "The 400,000 ETH already in the withdrawal vault is accounted as withdrawals, not as negative rebase. After that, the remaining unexplained decrease is exactly 309,600 ETH, which is 3.6% of 8,600,000 ETH.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration",
          clValidators: mainnetCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: mainnetMigrationWithdrawals,
        }),
        report({
          label: "Mainnet first report at 3.6% unexplained decrease",
          postValidatorsBalance: mainnetCLBalanceAfterMigrationWithdrawals - mainnetNegativeRebaseLimit,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: mainnetNegativeRebaseLimit,
          maxAllowedCLBalanceDiff: mainnetNegativeRebaseLimit,
        },
      },
    },
    {
      title: "reverts Mainnet first report when the unexplained decrease is 3.6% plus 1 wei",
      rationale:
        "The migration withdrawal amount is still fully explained. The revert is only because the remaining unexplained decrease is 1 wei above the 309,600 ETH Mainnet limit.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration",
          clValidators: mainnetCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: mainnetMigrationWithdrawals,
        }),
        report({
          label: "Mainnet first report above 3.6% unexplained decrease",
          postValidatorsBalance: mainnetCLBalanceAfterMigrationWithdrawals - mainnetNegativeRebaseLimit - 1n,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: mainnetNegativeRebaseLimit + 1n,
          maxAllowedCLBalanceDiff: mainnetNegativeRebaseLimit,
        },
      },
    },
    {
      title: "reverts Mainnet at the 36-day boundary when the migration-anchored window is over 3.6%",
      rationale:
        "At exactly 36 days, migration snapshots are still inside the window. The first report spends 100,000 ETH, and the final report goes 1 wei above the full 309,600 ETH migration-anchored limit.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration",
          clValidators: mainnetCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: mainnetMigrationWithdrawals,
        }),
        report({
          label: "Mainnet first report inside the 36-day window",
          postValidatorsBalance: mainnetCLBalanceAfterMigrationWithdrawals - mainnetFirstReportDecrease,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        ...repeatReports(34, (index) =>
          report({
            label: `Mainnet neutral report before day 36 ${index + 2}`,
            postValidatorsBalance: mainnetCLBalanceAfterMigrationWithdrawals - mainnetFirstReportDecrease,
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 0n,
          }),
        ),
        report({
          label: "Mainnet day 36 report above the migration-anchored limit",
          postValidatorsBalance: mainnetCLBalanceAfterMigrationWithdrawals - mainnetNegativeRebaseLimit - 1n,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: mainnetNegativeRebaseLimit + 1n,
          maxAllowedCLBalanceDiff: mainnetNegativeRebaseLimit,
        },
      },
    },
    {
      title: "accepts Mainnet at day 37 after the migration snapshots leave the window",
      rationale:
        "This uses the same final CL state as the day-36 revert. At day 37, the window starts from the first real report, so only 209,600 ETH plus 1 wei remains in the checked window, under the shifted 306,000 ETH limit.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration",
          clValidators: mainnetCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: mainnetMigrationWithdrawals,
        }),
        report({
          label: "Mainnet first report that becomes the shifted window baseline",
          postValidatorsBalance: mainnetCLBalanceAfterMigrationWithdrawals - mainnetFirstReportDecrease,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        ...repeatReports(35, (index) =>
          report({
            label: `Mainnet neutral report before day 37 ${index + 2}`,
            postValidatorsBalance: mainnetCLBalanceAfterMigrationWithdrawals - mainnetFirstReportDecrease,
            postPendingBalance: 0n,
            deposits: 0n,
            clWithdrawals: 0n,
          }),
        ),
        report({
          label: "Mainnet day 37 report with migration snapshots outside the window",
          postValidatorsBalance: mainnetCLBalanceAfterMigrationWithdrawals - mainnetNegativeRebaseLimit - 1n,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: mainnetShiftedWindowDecrease,
          maxAllowedCLBalanceDiff: mainnetShiftedWindowLimit,
        },
      },
    },
  ],
};
