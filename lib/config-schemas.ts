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

const WithdrawalVaultSchema = z.object({
  withdrawalRequestContract: EthereumAddressSchema,
  consolidationRequestContract: EthereumAddressSchema,
});

// Triggerable withdrawals gateway schema (used in scratch configs)
const TriggerableWithdrawalsGatewaySchema = z.object({
  maxExitRequestsLimit: PositiveIntSchema,
  exitsPerFrame: PositiveIntSchema,
  frameDurationInSec: PositiveIntSchema,
});

// Consolidation gateway schema
const ConsolidationGatewaySchema = z.object({
  maxConsolidationRequestsLimit: PositiveIntSchema,
  consolidationsPerFrame: PositiveIntSchema,
  frameDurationInSec: PositiveIntSchema,
  gIFirstValidatorPrev: HexStringSchema,
  gIFirstValidatorCurr: HexStringSchema,
  pivotSlot: NonNegativeIntSchema,
  pauser: EthereumAddressSchema.optional(),
});

const ConsolidationBusSchema = z.object({
  initialBatchSize: PositiveIntSchema,
  initialMaxGroupsInBatch: PositiveIntSchema,
  initialExecutionDelay: NonNegativeIntSchema,
});

const ConsolidationMigratorSchema = z.object({
  sourceModuleId: PositiveIntSchema,
  targetModuleId: PositiveIntSchema,
  consolidationCommittee: EthereumAddressSchema.optional(),
});

// Top-up gateway schema
const TopUpGatewaySchema = z.object({
  maxValidatorsPerTopUp: PositiveIntSchema,
  minBlockDistance: PositiveIntSchema,
  maxRootAge: PositiveIntSchema,
  targetBalanceGwei: PositiveIntSchema,
  minTopUpGwei: PositiveIntSchema,
  gIFirstValidatorPrev: HexStringSchema,
  gIFirstValidatorCurr: HexStringSchema,
  pivotSlot: NonNegativeIntSchema,
  depositor: EthereumAddressSchema.optional(),
});

const StakingRouterSchema = z.object({
  maxEBType1: BigIntStringSchema,
  maxEBType2: BigIntStringSchema,
  maxTopUpPerBlockGwei: PositiveIntSchema,
});

// Easy track schema
const EasyTrackSchema = z.object({
  trustedCaller: EthereumAddressSchema.optional(),
  newFactories: z.object({
    // v3
    // AlterTiersInOperatorGrid: EthereumAddressSchema,
    // RegisterGroupsInOperatorGrid: EthereumAddressSchema,
    // RegisterTiersInOperatorGrid: EthereumAddressSchema,
    // SetJailStatusInOperatorGrid: EthereumAddressSchema,
    // SocializeBadDebtInVaultHub: EthereumAddressSchema,
    // ForceValidatorExitsInVaultHub: EthereumAddressSchema,
    // UpdateGroupsShareLimitInOperatorGrid: EthereumAddressSchema,
    // UpdateVaultsFeesInOperatorGrid: EthereumAddressSchema,
    // v4
    UpdateStakingModuleShareLimits: EthereumAddressSchema,
    AllowConsolidationPair: EthereumAddressSchema,
    SetMerkleGateTreeForCSM: EthereumAddressSchema,
    ReportWithdrawalsForSlashedValidatorsForCSM: EthereumAddressSchema,
    SettleGeneralDelayedPenaltyForCSM: EthereumAddressSchema,
    SetMerkleGateTreeForCM: EthereumAddressSchema,
    ReportWithdrawalsForSlashedValidatorsForCM: EthereumAddressSchema,
    SettleGeneralDelayedPenaltyForCM: EthereumAddressSchema,
    CreateOrUpdateOperatorGroupForCM: EthereumAddressSchema,
  }),
  oldFactories: z.object({
    CSMSettleElStealingPenalty: EthereumAddressSchema,
    CSMSetVettedGateTree: EthereumAddressSchema,
  }),
});

// Oracle versions schema
const OracleVersionsSchema = z.object({
  ao_consensus_version: PositiveIntSchema,
});

// V3 vote script params
// const V3VoteScriptSchema = z.object({
//   expiryTimestamp: NonNegativeIntSchema,
//   initialMaxExternalRatioBP: BasisPointsSchema,
//   timeConstraintsContract: EthereumAddressSchema,
//   odcSlashingReserveWeRightShiftEpochs: NonNegativeIntSchema,
//   odcSlashingReserveWeLeftShiftEpochs: NonNegativeIntSchema,
// });

// Aragon app versions schema
const AragonAppVersionsSchema = z.object({
  nor_version: z.array(z.number()).length(3),
  sdvt_version: z.array(z.number()).length(3),
});

const CSMUpgradeConfigSchema = z.object({
  csmProxy: EthereumAddressSchema,
  csmImpl: EthereumAddressSchema,
  vettedGateProxy: EthereumAddressSchema,
  identifiedDVTClusterGate: EthereumAddressSchema,
  identifiedDVTClusterCurveSetup: EthereumAddressSchema,
  identifiedDVTClusterBondCurveId: NonNegativeIntSchema,
  parametersRegistryImpl: EthereumAddressSchema,
  feeOracleImpl: EthereumAddressSchema,
  feeOracleConsensusVersion: NonNegativeIntSchema,
  vettedGateImpl: EthereumAddressSchema,
  accountingImpl: EthereumAddressSchema,
  feeDistributorImpl: EthereumAddressSchema,
  exitPenaltiesImpl: EthereumAddressSchema,
  strikesImpl: EthereumAddressSchema,
  oldPermissionlessGate: EthereumAddressSchema,
  oldVerifier: EthereumAddressSchema,
  newVerifier: EthereumAddressSchema,
  newPermissionlessGate: EthereumAddressSchema,
  newEjector: EthereumAddressSchema,
  csmCommittee: EthereumAddressSchema,
});

const CuratedModuleConfigSchema = z.object({
  module: EthereumAddressSchema,
  curatedGates: z.array(EthereumAddressSchema),
  verifier: EthereumAddressSchema,
  circuitBreakerPauser: EthereumAddressSchema,
  moduleName: z.string().min(1),
  stakeShareLimit: NonNegativeIntSchema,
  priorityExitShareThreshold: NonNegativeIntSchema,
  stakingModuleFee: NonNegativeIntSchema,
  treasuryFee: NonNegativeIntSchema,
  maxDepositsPerBlock: NonNegativeIntSchema,
  minDepositBlockDistance: NonNegativeIntSchema,
  feeOracleConsensusVersion: NonNegativeIntSchema,
  hashConsensusInitialEpoch: NonNegativeIntSchema,
});

const UpgradeVoteScriptSchema = z.object({
  expiryTimestamp: NonNegativeIntSchema,
  timeConstraintsContract: EthereumAddressSchema.optional(),
  enabledDaySpanStart: NonNegativeIntSchema.optional(),
  enabledDaySpanEnd: NonNegativeIntSchema.optional(),
});

// CircuitBreaker schema (for scratch deployment)
const CircuitBreakerSchema = z.object({
  minPauseDuration: PositiveIntSchema,
  maxPauseDuration: PositiveIntSchema,
  minHeartbeatInterval: PositiveIntSchema,
  maxHeartbeatInterval: PositiveIntSchema,
  initialPauseDuration: PositiveIntSchema,
  initialHeartbeatInterval: PositiveIntSchema,
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
  maxValidatorsPerReport: PositiveIntSchema,
  maxExitBalanceEth: PositiveIntSchema,
  balancePerFrameEth: PositiveIntSchema,
  frameDurationInSec: PositiveIntSchema,
  consensusVersion: PositiveIntSchema,
});

// Deposit security module schema
const DepositSecurityModuleSchema = z.object({
  maxOperatorsPerUnvetting: PositiveIntSchema,
  pauseIntentValidityPeriodBlocks: PositiveIntSchema,
  usePredefinedAddressInstead: z.string().optional(),
});

// Oracle report sanity checker schema
export const OracleReportSanityCheckerBaseScheme = z.object({
  annualBalanceIncreaseBPLimit: BasisPointsSchema,
  simulatedShareRateDeviationBPLimit: BasisPointsSchema,
  maxItemsPerExtraDataTransaction: PositiveIntSchema,
  maxNodeOperatorsPerExtraDataItem: PositiveIntSchema,
  requestTimestampMargin: PositiveIntSchema,
  maxPositiveTokenRebase: PositiveIntSchema,
  clBalanceOraclesErrorUpperBPLimit: BasisPointsSchema,
});

export const OracleReportSanityCheckerUpgradeScheme = z.object({
  exitedEthAmountPerDayLimit: PositiveIntSchema,
  appearedEthAmountPerDayLimit: PositiveIntSchema,
  maxEffectiveBalanceWeightWCType01: PositiveIntSchema,
  maxEffectiveBalanceWeightWCType02: PositiveIntSchema,
  maxBalanceExitRequestedPerReportInEth: PositiveIntSchema,
  externalPendingBalanceCapEth: NonNegativeIntSchema,
  consolidationEthAmountPerDayLimit: NonNegativeIntSchema,
  exitedValidatorEthAmountLimit: PositiveIntSchema,
  maxCLBalanceDecreaseBP: BasisPointsSchema,
});

export const OracleReportSanityCheckerSchema = z.object({
  ...OracleReportSanityCheckerBaseScheme.shape,
  ...OracleReportSanityCheckerUpgradeScheme.shape,
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

const LidoSchema = z.object({
  depositsReserveTarget: BigIntStringSchema,
});

// Scratch parameters schema
export const ScratchParametersSchema = z.object({
  chainSpec: ChainSpecSchema.omit({ genesisTime: true, depositContract: true }),
  circuitBreaker: CircuitBreakerSchema,
  lidoApm: LidoApmSchema,
  lido: LidoSchema.optional(),
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
  consolidationGateway: ConsolidationGatewaySchema,
  consolidationBus: ConsolidationBusSchema,
  consolidationMigrator: ConsolidationMigratorSchema,
  predepositGuarantee: PredepositGuaranteeSchema.omit({ genesisForkVersion: true }),
  operatorGrid: OperatorGridSchema,
  topUpGateway: TopUpGatewaySchema,
  stakingRouter: StakingRouterSchema,
});

// Upgrade parameters schema
export const UpgradeParametersSchema = z.object({
  lido: LidoSchema,
  easyTrack: EasyTrackSchema,
  depositSecurityModule: DepositSecurityModuleSchema,
  oracleReportSanityChecker: OracleReportSanityCheckerUpgradeScheme,
  consolidationGateway: ConsolidationGatewaySchema,
  consolidationBus: ConsolidationBusSchema,
  consolidationMigrator: ConsolidationMigratorSchema,

  topUpGateway: TopUpGatewaySchema,
  stakingRouter: StakingRouterSchema,
  withdrawalVault: WithdrawalVaultSchema,
  triggerableWithdrawalsGateway: TriggerableWithdrawalsGatewaySchema,
  accountingOracle: OracleSchema,
  validatorsExitBusOracle: ValidatorsExitBusOracleSchema,

  // csm
  csmUpgrade: CSMUpgradeConfigSchema,
  curatedModule: CuratedModuleConfigSchema,

  upgradeVoteScript: UpgradeVoteScriptSchema,

  // old and optional
  vaultHub: VaultHubSchema.optional(),
  chainSpec: ChainSpecSchema.extend({
    genesisTime: z.number().int(),
    depositContract: EthereumAddressSchema,
  }).optional(),
  burner: BurnerSchema.optional(),
  oracleVersions: OracleVersionsSchema.optional(),
  aragonAppVersions: AragonAppVersionsSchema.optional(),
});

const EDFDelegationContractIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Invalid delegation contract id");
const Bytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Invalid bytes32 value");

export const EDFDelegationContractSchema = z
  .object({
    id: EDFDelegationContractIdSchema,
    address: EthereumAddressSchema.optional(),
    owner: EthereumAddressSchema.optional(),
    delegate: EthereumAddressSchema.optional(),
    cooldown: NonNegativeIntSchema.optional(),
    runtimeCodeHash: Bytes32Schema.optional(),
    deploymentTx: Bytes32Schema.optional(),
  })
  .superRefine((contract, ctx) => {
    const deploymentConfig = [contract.owner, contract.delegate, contract.cooldown];
    const deployedConfig = [contract.address, contract.runtimeCodeHash, contract.deploymentTx];
    const deploymentConfigCount = deploymentConfig.filter((value) => value !== undefined).length;
    const deployedConfigCount = deployedConfig.filter((value) => value !== undefined).length;

    if (deploymentConfigCount !== 0 && deploymentConfigCount !== deploymentConfig.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "owner, delegate and cooldown must be configured together",
      });
    }
    if (deployedConfigCount !== 0 && deployedConfigCount !== deployedConfig.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "address, runtimeCodeHash and deploymentTx must be configured together",
      });
    }
    if (deployedConfigCount === deployedConfig.length && deploymentConfigCount !== deploymentConfig.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a deployed contract must include owner, delegate and cooldown",
      });
    }
    if (contract.owner && contract.delegate && contract.owner.toLowerCase() === contract.delegate.toLowerCase()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "owner and delegate must differ" });
    }
  });

const EDFMemberMappingSchema = z.object({
  oldMember: EthereumAddressSchema,
  delegationContractId: EDFDelegationContractIdSchema,
});

const EDFOracleCommitteeIdSchema = z.enum([
  "accounting-oracle",
  "validators-exit-bus-oracle",
  "csm-fee-oracle",
  "curated-module-fee-oracle",
]);

const EDFOracleCommitteeSchema = z.object({
  id: EDFOracleCommitteeIdSchema,
  consensusContract: EthereumAddressSchema,
  quorum: PositiveIntSchema,
  memberMappings: z.array(EDFMemberMappingSchema).min(1),
});

export const EDFUpgradeParametersSchema = z
  .object({
    chainId: PositiveIntSchema,
    executionDelegationFramework: z.object({
      repository: z.string().url(),
      ref: z.string().min(1),
      factory: z
        .object({
          address: EthereumAddressSchema.optional(),
          runtimeCodeHash: Bytes32Schema.optional(),
        })
        .default({}),
      delegationContracts: z.array(EDFDelegationContractSchema).min(1),
    }),
    depositSecurityModule: z.object({
      maxOperatorsPerUnvetting: PositiveIntSchema,
      pauseIntentValidityPeriodBlocks: PositiveIntSchema,
      quorum: PositiveIntSchema,
      guardianMappings: z.array(EDFMemberMappingSchema).min(1),
    }),
    oracleCommittees: z.array(EDFOracleCommitteeSchema).length(4),
    topUpGateway: z.object({
      address: EthereumAddressSchema,
      delegationContractId: z.string().min(1),
    }),
    upgradeVoteScript: z
      .object({
        expiryTimestamp: PositiveIntSchema.optional(),
      })
      .default({}),
  })
  .superRefine((parameters, ctx) => {
    const delegationContracts = parameters.executionDelegationFramework.delegationContracts;
    const ids = new Set<string>();
    const addresses = new Set<string>();

    delegationContracts.forEach((contract, index) => {
      if (ids.has(contract.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["executionDelegationFramework", "delegationContracts", index, "id"],
          message: `Duplicate delegation contract id ${contract.id}`,
        });
      }
      ids.add(contract.id);

      if (contract.address) {
        const address = contract.address.toLowerCase();
        if (addresses.has(address)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["executionDelegationFramework", "delegationContracts", index, "address"],
            message: `Duplicate delegation contract address ${contract.address}`,
          });
        }
        addresses.add(address);
      }
    });

    const validateMappings = (mappings: z.infer<typeof EDFMemberMappingSchema>[], path: (string | number)[]) => {
      const oldMembers = new Set<string>();
      const contractIds = new Set<string>();
      mappings.forEach((mapping, index) => {
        const oldMember = mapping.oldMember.toLowerCase();
        if (oldMembers.has(oldMember)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, index, "oldMember"],
            message: `Duplicate old member ${mapping.oldMember}`,
          });
        }
        oldMembers.add(oldMember);

        if (contractIds.has(mapping.delegationContractId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, index, "delegationContractId"],
            message: `Duplicate delegation contract ${mapping.delegationContractId} in one committee`,
          });
        }
        contractIds.add(mapping.delegationContractId);

        if (!ids.has(mapping.delegationContractId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, index, "delegationContractId"],
            message: `Unknown delegation contract id ${mapping.delegationContractId}`,
          });
        }
      });
    };

    const guardianMappings = parameters.depositSecurityModule.guardianMappings;
    validateMappings(guardianMappings, ["depositSecurityModule", "guardianMappings"]);
    if (parameters.depositSecurityModule.quorum > guardianMappings.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["depositSecurityModule", "quorum"],
        message: "DSM quorum exceeds guardian count",
      });
    }

    const committeeIds = new Set<string>();
    parameters.oracleCommittees.forEach((committee, index) => {
      committeeIds.add(committee.id);
      validateMappings(committee.memberMappings, ["oracleCommittees", index, "memberMappings"]);
      if (committee.quorum > committee.memberMappings.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["oracleCommittees", index, "quorum"],
          message: `Committee ${committee.id} quorum exceeds member count`,
        });
      }
    });
    if (committeeIds.size !== EDFOracleCommitteeIdSchema.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["oracleCommittees"],
        message: "Every EDF oracle committee must be configured exactly once",
      });
    }

    if (!ids.has(parameters.topUpGateway.delegationContractId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["topUpGateway", "delegationContractId"],
        message: `Unknown delegation contract id ${parameters.topUpGateway.delegationContractId}`,
      });
    }

    const referencedIds = new Set([
      ...guardianMappings.map(({ delegationContractId }) => delegationContractId),
      ...parameters.oracleCommittees.flatMap(({ memberMappings }) =>
        memberMappings.map(({ delegationContractId }) => delegationContractId),
      ),
      parameters.topUpGateway.delegationContractId,
    ]);
    delegationContracts.forEach((contract, index) => {
      if (!referencedIds.has(contract.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["executionDelegationFramework", "delegationContracts", index, "id"],
          message: `Delegation contract ${contract.id} is not used by DSM or an oracle committee`,
        });
      }
    });
  });

// Inferred types from zod schemas
export type UpgradeParameters = z.infer<typeof UpgradeParametersSchema>;
export type ScratchParameters = z.infer<typeof ScratchParametersSchema>;
export type EDFUpgradeParameters = z.infer<typeof EDFUpgradeParametersSchema>;
export type EDFDelegationContract = z.infer<typeof EDFDelegationContractSchema>;

// Configuration validation functions
export function validateUpgradeParameters(data: unknown): UpgradeParameters {
  return UpgradeParametersSchema.parse(data);
}

export function validateScratchParameters(data: unknown): ScratchParameters {
  return ScratchParametersSchema.parse(data);
}

export function validateEDFUpgradeParameters(data: unknown): EDFUpgradeParameters {
  return EDFUpgradeParametersSchema.parse(data);
}

// Safe parsing functions that return either success or error
export function safeValidateUpgradeParameters(data: unknown) {
  return UpgradeParametersSchema.safeParse(data);
}

export function safeValidateScratchParameters(data: unknown) {
  return ScratchParametersSchema.safeParse(data);
}

export function safeValidateEDFUpgradeParameters(data: unknown) {
  return EDFUpgradeParametersSchema.safeParse(data);
}
