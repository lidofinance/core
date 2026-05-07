import { ether } from "lib";

import { migrate, MIGRATION_CL_WITHDRAWALS, NegativeRebaseFormulaFixtureSet, report } from "../lib";

const hoodiCLValidators = 62_500n;
const hoodiCLValidatorsBalance = ether("2000000");
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
          bufferedEther: 1n,
          depositedValidators: hoodiCLValidators,
          clValidators: hoodiCLValidators,
          clValidatorsBalance: hoodiCLValidatorsBalance,
          clPendingBalance: 0n,
          deposits: 0n,
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
      rationale: "The first post-migration report uses the same strict greater-than boundary as steady state.",
      steps: [
        migrate({
          label: "Hoodi finalized v4 migration",
          bufferedEther: 1n,
          depositedValidators: hoodiCLValidators,
          clValidators: hoodiCLValidators,
          clValidatorsBalance: hoodiCLValidatorsBalance,
          clPendingBalance: 0n,
          deposits: 0n,
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
  ],
};
