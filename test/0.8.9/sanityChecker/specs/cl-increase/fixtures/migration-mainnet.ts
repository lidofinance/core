import { ether } from "lib";

import { ClIncreaseFixtureSet, migrate, report } from "../lib";

const mainnetCLValidators = 281_250n;
const mainnetCLValidatorsBalance = mainnetCLValidators * ether("32");
const oneValidatorTransientDeposits = ether("32");
const appearedLimitTransientDeposits = ether("57600");
const aboveAppearedLimitTransientDeposits = ether("57632");
const partiallyActivatedDeposits = ether("19200");
const migrationVaultBalanceAboveDailyAprCap = ether("3000");

export const migrationMainnetClIncreaseFixtureSet: ClIncreaseFixtureSet = {
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
      title: "seeds migration-time withdrawal vault balance before checking a neutral report",
      rationale: "With a zero vault baseline the same neutral report would look like excessive CL growth.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration with withdrawal vault balance",
          clValidators: mainnetCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: migrationVaultBalanceAboveDailyAprCap,
        }),
        report({
          label: "neutral first report",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          postValidatorsBalance: mainnetCLValidatorsBalance,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        counterfactualZeroVaultBaseline: true,
      },
    },
    {
      title: "preserves zero migrated transient deposits across migration and first report frames",
      rationale: "The migration frame reports no current deposits, and the next frame preserves the same zero amount.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration without transient deposits",
          clValidators: mainnetCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "first report without transient deposits",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          postValidatorsBalance: mainnetCLValidatorsBalance,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        migrationFrame: {
          sameFrameDepositsForReport: 0n,
          sameFrameFundedPendingBalance: 0n,
          firstPostMigrationFrameDepositsForReport: 0n,
          firstPostMigrationFrameFundedPendingBalance: 0n,
        },
      },
    },
    {
      title: "preserves one migrated transient validator across migration and first report frames",
      rationale: "A single 32 ETH transient deposit appears as report deposits only in the next oracle frame.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration with one transient validator",
          clValidators: mainnetCLValidators,
          transientDeposits: oneValidatorTransientDeposits,
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "first report with one transient validator pending",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          postValidatorsBalance: mainnetCLValidatorsBalance,
          postPendingBalance: oneValidatorTransientDeposits,
          deposits: oneValidatorTransientDeposits,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        migrationFrame: {
          sameFrameDepositsForReport: 0n,
          sameFrameFundedPendingBalance: 0n,
          firstPostMigrationFrameDepositsForReport: oneValidatorTransientDeposits,
          firstPostMigrationFrameFundedPendingBalance: oneValidatorTransientDeposits,
        },
      },
    },
    {
      title: "preserves appeared-limit migrated transient deposits across migration and first report frames",
      rationale: "57,600 ETH of transient deposits becomes first-frame report funding after migration.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration with appeared-limit transient deposits",
          clValidators: mainnetCLValidators,
          transientDeposits: appearedLimitTransientDeposits,
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "first report with appeared-limit transient deposits pending",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          postValidatorsBalance: mainnetCLValidatorsBalance,
          postPendingBalance: appearedLimitTransientDeposits,
          deposits: appearedLimitTransientDeposits,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        migrationFrame: {
          sameFrameDepositsForReport: 0n,
          sameFrameFundedPendingBalance: 0n,
          firstPostMigrationFrameDepositsForReport: appearedLimitTransientDeposits,
          firstPostMigrationFrameFundedPendingBalance: appearedLimitTransientDeposits,
        },
      },
    },
    {
      title: "preserves above-limit migrated transient deposits across migration and first report frames",
      rationale: "57,632 ETH of transient deposits is visible as funding only in the first post-migration frame.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration with above-limit transient deposits",
          clValidators: mainnetCLValidators,
          transientDeposits: aboveAppearedLimitTransientDeposits,
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "first report with above-limit transient deposits pending",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          postValidatorsBalance: mainnetCLValidatorsBalance,
          postPendingBalance: aboveAppearedLimitTransientDeposits,
          deposits: aboveAppearedLimitTransientDeposits,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        migrationFrame: {
          sameFrameDepositsForReport: 0n,
          sameFrameFundedPendingBalance: 0n,
          firstPostMigrationFrameDepositsForReport: aboveAppearedLimitTransientDeposits,
          firstPostMigrationFrameFundedPendingBalance: aboveAppearedLimitTransientDeposits,
        },
      },
    },
    {
      title: "bounds validators growth after migration without transient deposits",
      rationale: "With no activated deposits, the first report may only use the APR safety cap.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration without transient deposits",
          clValidators: mainnetCLValidators,
          transientDeposits: 0n,
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "first report without activated deposits",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          postValidatorsBalance: mainnetCLValidatorsBalance,
          postPendingBalance: 0n,
          deposits: 0n,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "validatorsGrowthBoundary",
        formula: {
          activatedBalance: 0n,
        },
      },
    },
    {
      title: "bounds validators growth when all migrated transient deposits remain pending",
      rationale: "Raw transient deposits do not expand validators balance unless they activate.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration with pending transient deposits",
          clValidators: mainnetCLValidators,
          transientDeposits: appearedLimitTransientDeposits,
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "first report keeps all transient deposits pending",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          postValidatorsBalance: mainnetCLValidatorsBalance,
          postPendingBalance: appearedLimitTransientDeposits,
          deposits: appearedLimitTransientDeposits,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "validatorsGrowthBoundary",
        formula: {
          activatedBalance: 0n,
        },
      },
    },
    {
      title: "bounds validators growth when part of migrated transient deposits activates",
      rationale: "The report may add the activated 19,200 ETH plus the APR safety cap.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration with partially activated transient deposits",
          clValidators: mainnetCLValidators,
          transientDeposits: appearedLimitTransientDeposits,
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "first report activates part of transient deposits",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          postValidatorsBalance: mainnetCLValidatorsBalance + partiallyActivatedDeposits,
          postPendingBalance: appearedLimitTransientDeposits - partiallyActivatedDeposits,
          deposits: appearedLimitTransientDeposits,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "validatorsGrowthBoundary",
        formula: {
          activatedBalance: partiallyActivatedDeposits,
          appearedBalanceLimit: appearedLimitTransientDeposits,
        },
      },
    },
    {
      title: "bounds validators growth when all appeared-limit migrated transient deposits activate",
      rationale: "The report may add 57,600 ETH of activated deposits plus the APR safety cap.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration with fully activated transient deposits",
          clValidators: mainnetCLValidators,
          transientDeposits: appearedLimitTransientDeposits,
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "first report activates all appeared-limit transient deposits",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          postValidatorsBalance: mainnetCLValidatorsBalance + appearedLimitTransientDeposits,
          postPendingBalance: 0n,
          deposits: appearedLimitTransientDeposits,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "validatorsGrowthBoundary",
        formula: {
          activatedBalance: appearedLimitTransientDeposits,
          appearedBalanceLimit: appearedLimitTransientDeposits,
        },
      },
    },
    {
      title: "accepts appeared-limit activation when migrated transient deposits exceed the limit",
      rationale: "Only the activated amount is capped; the remaining 32 ETH can stay pending.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration with above-limit transient deposits",
          clValidators: mainnetCLValidators,
          transientDeposits: aboveAppearedLimitTransientDeposits,
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "first report activates exactly the appeared limit",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          postValidatorsBalance: mainnetCLValidatorsBalance + appearedLimitTransientDeposits,
          postPendingBalance: oneValidatorTransientDeposits,
          deposits: aboveAppearedLimitTransientDeposits,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "accepted",
        formula: {
          activatedBalance: appearedLimitTransientDeposits,
          appearedBalanceLimit: appearedLimitTransientDeposits,
        },
      },
    },
    {
      title: "reverts above appeared-limit activation when migrated transient deposits exceed the limit",
      rationale: "Activating one wei above 57,600 ETH fails before the APR cap matters.",
      steps: [
        migrate({
          label: "Mainnet finalized v4 migration with above-limit transient deposits",
          clValidators: mainnetCLValidators,
          transientDeposits: aboveAppearedLimitTransientDeposits,
          withdrawalVaultBalance: 0n,
        }),
        report({
          label: "first report activates one wei above the appeared limit",
          preValidatorsBalance: mainnetCLValidatorsBalance,
          postValidatorsBalance: mainnetCLValidatorsBalance + appearedLimitTransientDeposits + 1n,
          postPendingBalance: oneValidatorTransientDeposits - 1n,
          deposits: aboveAppearedLimitTransientDeposits,
          clWithdrawals: 0n,
        }),
      ],
      expected: {
        outcome: "IncorrectTotalActivatedBalance",
        formula: {
          activatedBalance: appearedLimitTransientDeposits + 1n,
          appearedBalanceLimit: appearedLimitTransientDeposits,
        },
      },
    },
  ],
};
