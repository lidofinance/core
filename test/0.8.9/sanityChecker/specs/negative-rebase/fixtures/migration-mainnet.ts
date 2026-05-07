import { ether } from "lib";

import { migrate, MIGRATION_CL_WITHDRAWALS, NegativeRebaseFormulaFixtureSet, report } from "../lib";

const mainnetCLValidators = 281_250n;
const mainnetCLValidatorsBalance = ether("9000000");
const mainnetFirstReportWindowLimit = ether("321926.4");
const mainnetCLDecreaseAtWindowLimit = MIGRATION_CL_WITHDRAWALS + mainnetFirstReportWindowLimit;
const firstReportWindowSpend = ether("100000");
const firstReportCLDecrease = MIGRATION_CL_WITHDRAWALS + firstReportWindowSpend;
const remainingWindowHeadroom = mainnetFirstReportWindowLimit - firstReportWindowSpend;

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
      title: "accepts Mainnet first post-migration decrease at the adjusted window limit",
      rationale: "The migration bootstrap withdrawal reduces the first report window limit to 321,926.4 ETH.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration",
          bufferedEther: 1n,
          depositedValidators: mainnetCLValidators,
          clValidators: mainnetCLValidators,
          clValidatorsBalance: mainnetCLValidatorsBalance,
          clPendingBalance: 0n,
          deposits: 0n,
          withdrawalVaultBalance: mainnetCLDecreaseAtWindowLimit,
        }),
        report({
          label: "Mainnet first report at adjusted decrease limit",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          prePendingBalance: 0n,
          postValidatorsBalance: mainnetCLValidatorsBalance - mainnetCLDecreaseAtWindowLimit,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: mainnetFirstReportWindowLimit,
          maxAllowedCLBalanceDiff: mainnetFirstReportWindowLimit,
        },
      },
    },
    {
      title: "reverts Mainnet first post-migration decrease one wei above the adjusted window limit",
      rationale: "The first post-migration report pins the strict upper boundary for a 9M ETH migration.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration",
          bufferedEther: 1n,
          depositedValidators: mainnetCLValidators,
          clValidators: mainnetCLValidators,
          clValidatorsBalance: mainnetCLValidatorsBalance,
          clPendingBalance: 0n,
          deposits: 0n,
          withdrawalVaultBalance: mainnetCLDecreaseAtWindowLimit + 1n,
        }),
        report({
          label: "Mainnet first report above adjusted decrease limit",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          prePendingBalance: 0n,
          postValidatorsBalance: mainnetCLValidatorsBalance - mainnetCLDecreaseAtWindowLimit - 1n,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: mainnetFirstReportWindowLimit + 1n,
          maxAllowedCLBalanceDiff: mainnetFirstReportWindowLimit,
        },
      },
    },
    {
      title: "uses first-report after-transfer withdrawal vault balance as the next baseline",
      rationale: "A second report with 21 ETH in the vault can only pass if the first report stored 20 ETH baseline.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration with 100 ETH vault baseline",
          bufferedEther: 1n,
          depositedValidators: mainnetCLValidators,
          clValidators: mainnetCLValidators,
          clValidatorsBalance: mainnetCLValidatorsBalance,
          clPendingBalance: 0n,
          deposits: 0n,
          withdrawalVaultBalance: ether("100"),
        }),
        report({
          label: "first report transfers most of the withdrawal vault balance",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          prePendingBalance: 0n,
          postValidatorsBalance: mainnetCLValidatorsBalance - ether("10"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: ether("10"),
          withdrawalsVaultTransfer: ether("90"),
        }),
        report({
          label: "second report counts only the new withdrawal vault delta",
          preValidatorsBalance: mainnetCLValidatorsBalance - ether("10"),
          prePendingBalance: 0n,
          postValidatorsBalance: mainnetCLValidatorsBalance - ether("11"),
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: ether("1"),
          withdrawalsVaultTransfer: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        lastReportCLWithdrawals: ether("1"),
      },
    },
    {
      title: "accepts the remaining Mainnet 36-day headroom after migration-time decrease",
      rationale: "After the first report spends 100,000 ETH of window headroom, 221,926.4 ETH remains.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration with first-report window spend",
          bufferedEther: 1n,
          depositedValidators: mainnetCLValidators,
          clValidators: mainnetCLValidators,
          clValidatorsBalance: mainnetCLValidatorsBalance,
          clPendingBalance: 0n,
          deposits: 0n,
          withdrawalVaultBalance: firstReportCLDecrease,
        }),
        report({
          label: "first report spends 100,000 ETH of adjusted window headroom",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          prePendingBalance: 0n,
          postValidatorsBalance: mainnetCLValidatorsBalance - firstReportCLDecrease,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "second report spends the remaining adjusted window headroom",
          preValidatorsBalance: mainnetCLValidatorsBalance - firstReportCLDecrease,
          prePendingBalance: 0n,
          postValidatorsBalance: mainnetCLValidatorsBalance - firstReportCLDecrease - remainingWindowHeadroom,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        window: {
          actualCLBalanceDiff: mainnetFirstReportWindowLimit,
          maxAllowedCLBalanceDiff: mainnetFirstReportWindowLimit,
        },
      },
    },
    {
      title: "reverts above the remaining Mainnet 36-day headroom after migration-time decrease",
      rationale: "The second report cannot exceed the same 321,926.4 ETH adjusted window limit.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration with first-report window spend",
          bufferedEther: 1n,
          depositedValidators: mainnetCLValidators,
          clValidators: mainnetCLValidators,
          clValidatorsBalance: mainnetCLValidatorsBalance,
          clPendingBalance: 0n,
          deposits: 0n,
          withdrawalVaultBalance: firstReportCLDecrease,
        }),
        report({
          label: "first report spends 100,000 ETH of adjusted window headroom",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          prePendingBalance: 0n,
          postValidatorsBalance: mainnetCLValidatorsBalance - firstReportCLDecrease,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
        report({
          label: "second report exceeds the remaining adjusted window headroom",
          preValidatorsBalance: mainnetCLValidatorsBalance - firstReportCLDecrease,
          prePendingBalance: 0n,
          postValidatorsBalance: mainnetCLValidatorsBalance - firstReportCLDecrease - remainingWindowHeadroom - 1n,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "revert",
        window: {
          actualCLBalanceDiff: mainnetFirstReportWindowLimit + 1n,
          maxAllowedCLBalanceDiff: mainnetFirstReportWindowLimit,
        },
      },
    },
  ],
};
