import { z } from "zod";

// Common schemas
const EthereumAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address");
const HexStringSchema = z.string().regex(/^0x[a-fA-F0-9]+$/, "Invalid hex string");
const BigIntStringSchema = z.string().regex(/^\d+$/, "Invalid BigInt string");

// Chain specification schema
const ChainSpecSchema = z.object({
  slotsPerEpoch: z.number().int().positive(),
  secondsPerSlot: z.number().int().positive(),
  genesisTime: z.number().int().optional(),
  depositContract: EthereumAddressSchema.optional(),
});

// Validator exit delay verifier schema
const ValidatorExitDelayVerifierSchema = z.object({
  gIFirstValidatorPrev: HexStringSchema,
  gIFirstValidatorCurr: HexStringSchema,
  gIFirstHistoricalSummaryPrev: HexStringSchema,
  gIFirstHistoricalSummaryCurr: HexStringSchema,
  gIFirstBlockRootInSummaryPrev: HexStringSchema,
  gIFirstBlockRootInSummaryCurr: HexStringSchema,
  firstSupportedSlot: z.number().int().nonnegative(),
  pivotSlot: z.number().int().nonnegative(),
  capellaSlot: z.number().int().nonnegative(),
  slotsPerHistoricalRoot: z.number().int().positive(),
  shardCommitteePeriodInSeconds: z.number().int().positive(),
});

// Vault hub schema
const VaultHubSchema = z.object({
  relativeShareLimitBP: z.number().int().min(0).max(10000).optional(),
  maxRelativeShareLimitBP: z.number().int().min(0).max(10000).optional(),
});

// Lazy oracle schema
const LazyOracleSchema = z.object({
  quarantinePeriod: z.number().int().positive(),
  maxRewardRatioBP: z.number().int().min(0).max(10000),
});

// Predeposit guarantee schema
const PredepositGuaranteeSchema = z.object({
  genesisForkVersion: HexStringSchema.optional(),
  gIndex: HexStringSchema,
  gIndexAfterChange: HexStringSchema,
  changeSlot: z.number().int().nonnegative(),
});

// Operator grid schema
const OperatorGridSchema = z.object({
  defaultTierParams: z.object({
    shareLimitInEther: BigIntStringSchema,
    reserveRatioBP: z.number().int().min(0).max(10000),
    forcedRebalanceThresholdBP: z.number().int().min(0).max(10000),
    infraFeeBP: z.number().int().min(0).max(10000),
    liquidityFeeBP: z.number().int().min(0).max(10000),
    reservationFeeBP: z.number().int().min(0).max(10000),
  }),
});

// Burner schema
const BurnerSchema = z.object({
  isMigrationAllowed: z.boolean(),
  totalCoverSharesBurnt: BigIntStringSchema.optional(),
  totalNonCoverSharesBurnt: BigIntStringSchema.optional(),
});

// Triggerable withdrawals gateway schema
const TriggerableWithdrawalsGatewaySchema = z.object({
  maxExitRequestsLimit: z.number().int().positive(),
  exitsPerFrame: z.number().int().positive(),
  frameDurationInSec: z.number().int().positive(),
});

// Oracle versions schema
const OracleVersionsSchema = z.object({
  vebo_consensus_version: z.number().int().positive(),
  ao_consensus_version: z.number().int().positive(),
});

// Aragon app versions schema
const AragonAppVersionsSchema = z.object({
  nor_version: z.array(z.number()).length(3),
  sdvt_version: z.array(z.number()).length(3),
});

// Upgrade parameters schema
export const UpgradeParametersSchema = z.object({
  chainSpec: ChainSpecSchema.extend({
    genesisTime: z.number().int(),
    depositContract: EthereumAddressSchema,
  }),
  gateSealForVaults: z.object({
    address: EthereumAddressSchema,
  }),
  easyTrack: z.object({
    evmScriptExecutor: EthereumAddressSchema,
    vaultHubAdapter: EthereumAddressSchema,
  }),
  validatorExitDelayVerifier: ValidatorExitDelayVerifierSchema,
  vaultHub: VaultHubSchema,
  lazyOracle: LazyOracleSchema,
  predepositGuarantee: PredepositGuaranteeSchema.extend({
    genesisForkVersion: HexStringSchema,
  }),
  delegation: z.object({
    wethContract: EthereumAddressSchema,
  }),
  operatorGrid: OperatorGridSchema,
  burner: BurnerSchema,
  oracleVersions: OracleVersionsSchema.optional(),
  aragonAppVersions: AragonAppVersionsSchema.optional(),
  triggerableWithdrawalsGateway: TriggerableWithdrawalsGatewaySchema,
  triggerableWithdrawals: z.object({
    exit_events_lookback_window_in_slots: z.number().int().positive(),
    nor_exit_deadline_in_sec: z.number().int().positive(),
  }),
});

// Gate seal schema (for scratch deployment)
const GateSealSchema = z.object({
  sealDuration: z.number().int().positive(),
  expiryTimestamp: z.number().int().positive(),
  sealingCommittee: z.array(EthereumAddressSchema),
});

// DAO schema
const DaoSchema = z.object({
  aragonId: z.string().min(1),
  aragonEnsLabelName: z.string().min(1),
  initialSettings: z.object({
    voting: z.object({
      minSupportRequired: BigIntStringSchema,
      minAcceptanceQuorum: BigIntStringSchema,
      voteDuration: z.number().int().positive(),
      objectionPhaseDuration: z.number().int().positive(),
    }),
    fee: z.object({
      totalPercent: z.number().int().min(0).max(100),
      treasuryPercent: z.number().int().min(0).max(100),
      nodeOperatorsPercent: z.number().int().min(0).max(100),
    }),
    token: z.object({
      name: z.string().min(1),
      symbol: z.string().min(1),
    }),
  }),
});

// Vesting schema
const VestingSchema = z.object({
  unvestedTokensAmount: BigIntStringSchema,
  start: z.number().int().nonnegative(),
  cliff: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  revokable: z.boolean(),
  holders: z.any(),
});

// Oracle configuration schemas
const HashConsensusSchema = z.object({
  fastLaneLengthSlots: z.number().int().positive(),
  epochsPerFrame: z.number().int().positive(),
});

const OracleSchema = z.object({
  consensusVersion: z.number().int().positive(),
});

const ValidatorsExitBusOracleSchema = OracleSchema.extend({
  maxValidatorsPerRequest: z.number().int().positive(),
  maxExitRequestsLimit: z.number().int().positive(),
  exitsPerFrame: z.number().int().positive(),
  frameDurationInSec: z.number().int().positive(),
});

// Deposit security module schema
const DepositSecurityModuleSchema = z.object({
  maxOperatorsPerUnvetting: z.number().int().positive(),
  pauseIntentValidityPeriodBlocks: z.number().int().positive(),
  usePredefinedAddressInstead: z.string().optional(),
});

// Oracle report sanity checker schema
const OracleReportSanityCheckerSchema = z.object({
  exitedValidatorsPerDayLimit: z.number().int().positive(),
  appearedValidatorsPerDayLimit: z.number().int().positive(),
  deprecatedOneOffCLBalanceDecreaseBPLimit: z.number().int().min(0).max(10000),
  annualBalanceIncreaseBPLimit: z.number().int().min(0).max(10000),
  simulatedShareRateDeviationBPLimit: z.number().int().min(0).max(10000),
  maxValidatorExitRequestsPerReport: z.number().int().positive(),
  maxItemsPerExtraDataTransaction: z.number().int().positive(),
  maxNodeOperatorsPerExtraDataItem: z.number().int().positive(),
  requestTimestampMargin: z.number().int().positive(),
  maxPositiveTokenRebase: z.number().int().positive(),
  initialSlashingAmountPWei: z.number().int().positive(),
  inactivityPenaltiesAmountPWei: z.number().int().positive(),
  clBalanceOraclesErrorUpperBPLimit: z.number().int().min(0).max(10000),
});

// Oracle daemon config schema
const OracleDaemonConfigSchema = z.object({
  NORMALIZED_CL_REWARD_PER_EPOCH: z.number().int().positive(),
  NORMALIZED_CL_REWARD_MISTAKE_RATE_BP: z.number().int().min(0).max(10000),
  REBASE_CHECK_NEAREST_EPOCH_DISTANCE: z.number().int().positive(),
  REBASE_CHECK_DISTANT_EPOCH_DISTANCE: z.number().int().positive(),
  VALIDATOR_DELAYED_TIMEOUT_IN_SLOTS: z.number().int().positive(),
  VALIDATOR_DELINQUENT_TIMEOUT_IN_SLOTS: z.number().int().positive(),
  NODE_OPERATOR_NETWORK_PENETRATION_THRESHOLD_BP: z.number().int().min(0).max(10000),
  PREDICTION_DURATION_IN_SLOTS: z.number().int().positive(),
  FINALIZATION_MAX_NEGATIVE_REBASE_EPOCH_SHIFT: z.number().int().positive(),
  EXIT_EVENTS_LOOKBACK_WINDOW_IN_SLOTS: z.number().int().positive(),
});

// Staking module schema
const StakingModuleSchema = z.object({
  stakingModuleName: z.string().min(1),
  stakingModuleTypeId: z.string().min(1),
  stuckPenaltyDelay: z.number().int().positive(),
});

// Withdrawal queue ERC721 schema
const WithdrawalQueueERC721Schema = z.object({
  name: z.string().min(1),
  symbol: z.string().min(1),
});

// Lido APM schema
const LidoApmSchema = z.object({
  ensName: z.string().min(1),
  ensRegDurationSec: z.number().int().positive(),
});

// Scratch parameters schema
export const ScratchParametersSchema = z.object({
  chainSpec: ChainSpecSchema.omit({ genesisTime: true, depositContract: true }),
  gateSeal: GateSealSchema,
  lidoApm: LidoApmSchema,
  dao: DaoSchema,
  vesting: VestingSchema,
  burner: BurnerSchema.extend({
    totalCoverSharesBurnt: BigIntStringSchema,
    totalNonCoverSharesBurnt: BigIntStringSchema,
  }),
  hashConsensusForAccountingOracle: HashConsensusSchema,
  vaultHub: z.object({
    maxRelativeShareLimitBP: z.number().int().min(0).max(10000),
  }),
  lazyOracle: LazyOracleSchema,
  accountingOracle: OracleSchema,
  hashConsensusForValidatorsExitBusOracle: HashConsensusSchema,
  validatorsExitBusOracle: ValidatorsExitBusOracleSchema,
  depositSecurityModule: DepositSecurityModuleSchema,
  oracleReportSanityChecker: OracleReportSanityCheckerSchema,
  oracleDaemonConfig: OracleDaemonConfigSchema,
  nodeOperatorsRegistry: StakingModuleSchema,
  simpleDvt: StakingModuleSchema,
  withdrawalQueueERC721: WithdrawalQueueERC721Schema,
  validatorExitDelayVerifier: ValidatorExitDelayVerifierSchema,
  triggerableWithdrawalsGateway: TriggerableWithdrawalsGatewaySchema,
  predepositGuarantee: PredepositGuaranteeSchema.omit({ genesisForkVersion: true }),
  operatorGrid: OperatorGridSchema,
});

// Inferred types from zod schemas
export type UpgradeParameters = z.infer<typeof UpgradeParametersSchema>;
export type ScratchParameters = z.infer<typeof ScratchParametersSchema>;

// Configuration validation functions
export function validateUpgradeParameters(data: unknown): UpgradeParameters {
  return UpgradeParametersSchema.parse(data);
}

export function validateScratchParameters(data: unknown): ScratchParameters {
  return ScratchParametersSchema.parse(data);
}

// Safe parsing functions that return either success or error
export function safeValidateUpgradeParameters(data: unknown) {
  return UpgradeParametersSchema.safeParse(data);
}

export function safeValidateScratchParameters(data: unknown) {
  return ScratchParametersSchema.safeParse(data);
}
