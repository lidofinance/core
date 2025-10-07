import { z } from "zod";

// Common schemas
const EthereumAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address");
const HexStringSchema = z.string().regex(/^0x[a-fA-F0-9]+$/, "Invalid hex string");
const BigIntStringSchema = z.string().regex(/^\d+$/, "Invalid BigInt string");
const BasisPointsSchema = z.number().int().min(0).max(10000);
const PositiveIntSchema = z.number().int().positive();
const NonNegativeIntSchema = z.number().int().nonnegative();
const PercentSchema = z.number().int().min(0).max(100);

// Chain specification schema
const ChainSpecSchema = z.object({
  slotsPerEpoch: PositiveIntSchema,
  secondsPerSlot: PositiveIntSchema,
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
  firstSupportedSlot: NonNegativeIntSchema,
  pivotSlot: NonNegativeIntSchema,
  capellaSlot: NonNegativeIntSchema,
  slotsPerHistoricalRoot: PositiveIntSchema,
  shardCommitteePeriodInSeconds: PositiveIntSchema,
});

// Vault hub schema
const VaultHubSchema = z.object({
  relativeShareLimitBP: BasisPointsSchema.optional(),
  maxRelativeShareLimitBP: BasisPointsSchema.optional(),
});

// Lazy oracle schema
const LazyOracleSchema = z.object({
  quarantinePeriod: PositiveIntSchema,
  maxRewardRatioBP: BasisPointsSchema,
  maxLidoFeeRatePerSecond: BigIntStringSchema,
});

// Predeposit guarantee schema
const PredepositGuaranteeSchema = z.object({
  genesisForkVersion: HexStringSchema.optional(),
  gIndex: HexStringSchema,
  gIndexAfterChange: HexStringSchema,
  changeSlot: NonNegativeIntSchema,
});

// Operator grid schema
const OperatorGridSchema = z.object({
  defaultTierParams: z.object({
    shareLimitInEther: BigIntStringSchema,
    reserveRatioBP: BasisPointsSchema,
    forcedRebalanceThresholdBP: BasisPointsSchema,
    infraFeeBP: BasisPointsSchema,
    liquidityFeeBP: BasisPointsSchema,
    reservationFeeBP: BasisPointsSchema,
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
  maxExitRequestsLimit: PositiveIntSchema,
  exitsPerFrame: PositiveIntSchema,
  frameDurationInSec: PositiveIntSchema,
});

// Oracle versions schema
const OracleVersionsSchema = z.object({
  vebo_consensus_version: PositiveIntSchema,
  ao_consensus_version: PositiveIntSchema,
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
    isHoodi: z.boolean(),
  }),
  gateSealForVaults: z.object({
    address: EthereumAddressSchema,
  }),
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
});

// Gate seal schema (for scratch deployment)
const GateSealSchema = z.object({
  sealDuration: PositiveIntSchema,
  expiryTimestamp: PositiveIntSchema,
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
      voteDuration: PositiveIntSchema,
      objectionPhaseDuration: PositiveIntSchema,
    }),
    fee: z.object({
      totalPercent: PercentSchema,
      treasuryPercent: PercentSchema,
      nodeOperatorsPercent: PercentSchema,
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
  start: NonNegativeIntSchema,
  cliff: NonNegativeIntSchema,
  end: NonNegativeIntSchema,
  revokable: z.boolean(),
  holders: z.any(),
});

// Oracle configuration schemas
const HashConsensusSchema = z.object({
  fastLaneLengthSlots: PositiveIntSchema,
  epochsPerFrame: PositiveIntSchema,
});

const OracleSchema = z.object({
  consensusVersion: PositiveIntSchema,
});

const ValidatorsExitBusOracleSchema = OracleSchema.extend({
  maxValidatorsPerRequest: PositiveIntSchema,
  maxExitRequestsLimit: PositiveIntSchema,
  exitsPerFrame: PositiveIntSchema,
  frameDurationInSec: PositiveIntSchema,
});

// Deposit security module schema
const DepositSecurityModuleSchema = z.object({
  maxOperatorsPerUnvetting: PositiveIntSchema,
  pauseIntentValidityPeriodBlocks: PositiveIntSchema,
  usePredefinedAddressInstead: z.string().optional(),
});

// Oracle report sanity checker schema
const OracleReportSanityCheckerSchema = z.object({
  exitedValidatorsPerDayLimit: PositiveIntSchema,
  appearedValidatorsPerDayLimit: PositiveIntSchema,
  deprecatedOneOffCLBalanceDecreaseBPLimit: BasisPointsSchema,
  annualBalanceIncreaseBPLimit: BasisPointsSchema,
  simulatedShareRateDeviationBPLimit: BasisPointsSchema,
  maxValidatorExitRequestsPerReport: PositiveIntSchema,
  maxItemsPerExtraDataTransaction: PositiveIntSchema,
  maxNodeOperatorsPerExtraDataItem: PositiveIntSchema,
  requestTimestampMargin: PositiveIntSchema,
  maxPositiveTokenRebase: PositiveIntSchema,
  initialSlashingAmountPWei: PositiveIntSchema,
  inactivityPenaltiesAmountPWei: PositiveIntSchema,
  clBalanceOraclesErrorUpperBPLimit: BasisPointsSchema,
});

// Oracle daemon config schema
const OracleDaemonConfigSchema = z.object({
  NORMALIZED_CL_REWARD_PER_EPOCH: PositiveIntSchema,
  NORMALIZED_CL_REWARD_MISTAKE_RATE_BP: BasisPointsSchema,
  REBASE_CHECK_NEAREST_EPOCH_DISTANCE: PositiveIntSchema,
  REBASE_CHECK_DISTANT_EPOCH_DISTANCE: PositiveIntSchema,
  VALIDATOR_DELAYED_TIMEOUT_IN_SLOTS: PositiveIntSchema,
  VALIDATOR_DELINQUENT_TIMEOUT_IN_SLOTS: PositiveIntSchema,
  NODE_OPERATOR_NETWORK_PENETRATION_THRESHOLD_BP: BasisPointsSchema,
  PREDICTION_DURATION_IN_SLOTS: PositiveIntSchema,
  FINALIZATION_MAX_NEGATIVE_REBASE_EPOCH_SHIFT: PositiveIntSchema,
  EXIT_EVENTS_LOOKBACK_WINDOW_IN_SLOTS: PositiveIntSchema,
});

// Staking module schema
const StakingModuleSchema = z.object({
  stakingModuleName: z.string().min(1),
  stakingModuleTypeId: z.string().min(1),
  stuckPenaltyDelay: PositiveIntSchema,
});

// Withdrawal queue ERC721 schema
const WithdrawalQueueERC721Schema = z.object({
  name: z.string().min(1),
  symbol: z.string().min(1),
});

// Lido APM schema
const LidoApmSchema = z.object({
  ensName: z.string().min(1),
  ensRegDurationSec: PositiveIntSchema,
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
    maxRelativeShareLimitBP: BasisPointsSchema,
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
