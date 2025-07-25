import fs from "fs";

import * as toml from "@iarna/toml";

const SCRATCH_PARAMETERS_FILE = process.env.SCRATCH_PARAMETERS_FILE || "scripts/scratch/deploy-params-testnet.toml";

export interface ScratchParameters {
  chainSpec: {
    slotsPerEpoch: number;
    secondsPerSlot: number;
  };
  gateSeal: {
    sealDuration: number;
    expiryTimestamp: number;
    sealingCommittee: string[];
  };
  lidoApm: {
    ensName: string;
    ensRegDurationSec: number;
  };
  dao: {
    aragonId: string;
    aragonEnsLabelName: string;
    initialSettings: {
      voting: {
        minSupportRequired: string;
        minAcceptanceQuorum: string;
        voteDuration: number;
        objectionPhaseDuration: number;
      };
      fee: {
        totalPercent: number;
        treasuryPercent: number;
        nodeOperatorsPercent: number;
      };
      token: {
        name: string;
        symbol: string;
      };
    };
  };
  vesting: {
    unvestedTokensAmount: string;
    start: number;
    cliff: number;
    end: number;
    revokable: boolean;
    holders: Record<string, string>;
  };
  burner: {
    isMigrationAllowed: boolean;
    totalCoverSharesBurnt: string;
    totalNonCoverSharesBurnt: string;
  };
  hashConsensusForAccountingOracle: {
    fastLaneLengthSlots: number;
    epochsPerFrame: number;
  };
  vaultHub: {
    maxRelativeShareLimitBP: number;
  };
  lazyOracle: {
    quarantinePeriod: number;
    maxRewardRatioBP: number;
  };
  accountingOracle: {
    consensusVersion: number;
  };
  hashConsensusForValidatorsExitBusOracle: {
    fastLaneLengthSlots: number;
    epochsPerFrame: number;
  };
  validatorsExitBusOracle: {
    consensusVersion: number;
    maxValidatorsPerRequest: number;
    maxExitRequestsLimit: number;
    exitsPerFrame: number;
    frameDurationInSec: number;
  };
  depositSecurityModule: {
    maxOperatorsPerUnvetting: number;
    pauseIntentValidityPeriodBlocks: number;
    usePredefinedAddressInstead?: string;
  };
  oracleReportSanityChecker: {
    exitedValidatorsPerDayLimit: number;
    appearedValidatorsPerDayLimit: number;
    deprecatedOneOffCLBalanceDecreaseBPLimit: number;
    annualBalanceIncreaseBPLimit: number;
    simulatedShareRateDeviationBPLimit: number;
    maxValidatorExitRequestsPerReport: number;
    maxItemsPerExtraDataTransaction: number;
    maxNodeOperatorsPerExtraDataItem: number;
    requestTimestampMargin: number;
    maxPositiveTokenRebase: number;
    initialSlashingAmountPWei: number;
    inactivityPenaltiesAmountPWei: number;
    clBalanceOraclesErrorUpperBPLimit: number;
  };
  oracleDaemonConfig: {
    NORMALIZED_CL_REWARD_PER_EPOCH: number;
    NORMALIZED_CL_REWARD_MISTAKE_RATE_BP: number;
    REBASE_CHECK_NEAREST_EPOCH_DISTANCE: number;
    REBASE_CHECK_DISTANT_EPOCH_DISTANCE: number;
    VALIDATOR_DELAYED_TIMEOUT_IN_SLOTS: number;
    VALIDATOR_DELINQUENT_TIMEOUT_IN_SLOTS: number;
    NODE_OPERATOR_NETWORK_PENETRATION_THRESHOLD_BP: number;
    PREDICTION_DURATION_IN_SLOTS: number;
    FINALIZATION_MAX_NEGATIVE_REBASE_EPOCH_SHIFT: number;
  };
  nodeOperatorsRegistry: {
    stakingModuleName: string;
    stakingModuleTypeId: string;
    stuckPenaltyDelay: number;
  };
  simpleDvt: {
    stakingModuleName: string;
    stakingModuleTypeId: string;
    stuckPenaltyDelay: number;
  };
  withdrawalQueueERC721: {
    name: string;
    symbol: string;
  };
  validatorExitDelayVerifier: {
    gIFirstValidatorPrev: string;
    gIFirstValidatorCurr: string;
    gIFirstHistoricalSummaryPrev: string;
    gIFirstHistoricalSummaryCurr: string;
    gIFirstBlockRootInSummaryPrev: string;
    gIFirstBlockRootInSummaryCurr: string;
  };
  triggerableWithdrawalsGateway: {
    maxExitRequestsLimit: number;
    exitsPerFrame: number;
    frameDurationInSec: number;
  };
  predepositGuarantee: {
    gIndex: string;
    gIndexAfterChange: string;
    changeSlot: number;
  };
  operatorGrid: {
    defaultTierParams: {
      shareLimitInEther: string;
      reserveRatioBP: number;
      forcedRebalanceThresholdBP: number;
      infraFeeBP: number;
      liquidityFeeBP: number;
      reservationFeeBP: number;
    };
  };
}

export function readScratchParameters(): ScratchParameters {
  const rawData = fs.readFileSync(SCRATCH_PARAMETERS_FILE, "utf8");
  return toml.parse(rawData) as unknown as ScratchParameters;
}

// Convert TOML scratch parameters to deployment state format
export function scratchParametersToDeploymentState(params: ScratchParameters): Record<string, unknown> {
  return {
    deployer: null, // Set by deployment scripts
    gateSeal: {
      address: null, // Set by deployment scripts
      factoryAddress: null, // Set by deployment scripts
      sealDuration: params.gateSeal.sealDuration,
      expiryTimestamp: params.gateSeal.expiryTimestamp,
      sealingCommittee: params.gateSeal.sealingCommittee,
    },
    lidoApmEnsName: params.lidoApm.ensName,
    lidoApmEnsRegDurationSec: params.lidoApm.ensRegDurationSec,
    daoAragonId: params.dao.aragonId,
    daoFactory: {
      address: null, // Set by deployment scripts
    },
    ens: {
      address: null, // Set by deployment scripts
    },
    miniMeTokenFactory: {
      address: null, // Set by deployment scripts
    },
    aragonID: {
      address: null, // Set by deployment scripts
    },
    aragonEnsLabelName: params.dao.aragonEnsLabelName,
    chainSpec: {
      slotsPerEpoch: params.chainSpec.slotsPerEpoch,
      secondsPerSlot: params.chainSpec.secondsPerSlot,
      genesisTime: null, // Set via environment variables
      depositContract: null, // Set via environment variables
    },
    daoInitialSettings: params.dao.initialSettings,
    vestingParams: params.vesting,
    burner: {
      deployParameters: {
        totalCoverSharesBurnt: params.burner.totalCoverSharesBurnt,
        totalNonCoverSharesBurnt: params.burner.totalNonCoverSharesBurnt,
      },
    },
    hashConsensusForAccountingOracle: {
      deployParameters: params.hashConsensusForAccountingOracle,
    },
    vaultHub: {
      deployParameters: {
        maxRelativeShareLimitBP: params.vaultHub.maxRelativeShareLimitBP,
      },
    },
    lazyOracle: {
      deployParameters: params.lazyOracle,
    },
    accountingOracle: {
      deployParameters: params.accountingOracle,
    },
    hashConsensusForValidatorsExitBusOracle: {
      deployParameters: params.hashConsensusForValidatorsExitBusOracle,
    },
    validatorsExitBusOracle: {
      deployParameters: params.validatorsExitBusOracle,
    },
    depositSecurityModule: {
      deployParameters: {
        ...params.depositSecurityModule,
        usePredefinedAddressInstead: params.depositSecurityModule.usePredefinedAddressInstead || null,
      },
    },
    oracleReportSanityChecker: {
      deployParameters: params.oracleReportSanityChecker,
    },
    oracleDaemonConfig: {
      deployParameters: params.oracleDaemonConfig,
    },
    nodeOperatorsRegistry: {
      deployParameters: params.nodeOperatorsRegistry,
    },
    simpleDvt: {
      deployParameters: params.simpleDvt,
    },
    withdrawalQueueERC721: {
      deployParameters: {
        name: params.withdrawalQueueERC721.name,
        symbol: params.withdrawalQueueERC721.symbol,
        baseUri: null, // Set by deployment scripts
      },
    },
    validatorExitDelayVerifier: {
      deployParameters: params.validatorExitDelayVerifier,
    },
    triggerableWithdrawalsGateway: {
      deployParameters: params.triggerableWithdrawalsGateway,
    },
    predepositGuarantee: {
      deployParameters: params.predepositGuarantee,
    },
    operatorGrid: {
      deployParameters: params.operatorGrid,
    },
  };
}
