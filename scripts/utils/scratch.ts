import fs from "fs";

import * as toml from "@iarna/toml";

import { ScratchParameters, validateScratchParameters } from "lib/config-schemas";

const SCRATCH_DEPLOY_CONFIG = process.env.SCRATCH_DEPLOY_CONFIG || "scripts/scratch/deploy-params-testnet.toml";

export { ScratchParameters };

export function readScratchParameters(): ScratchParameters {
  if (!fs.existsSync(SCRATCH_DEPLOY_CONFIG)) {
    throw new Error(`Scratch parameters file not found: ${SCRATCH_DEPLOY_CONFIG}`);
  }

  const rawData = fs.readFileSync(SCRATCH_DEPLOY_CONFIG, "utf8");
  const parsedData = toml.parse(rawData);

  try {
    return validateScratchParameters(parsedData);
  } catch (error) {
    throw new Error(`Invalid scratch parameters: ${error}`);
  }
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
