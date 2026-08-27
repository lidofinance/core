/**
 * Deploys Gloas-aware verifier contracts to a local devnet without activating them or updating the state file.
 *
 * Required environment:
 * - LOCAL_RPC_URL (or RPC_URL), LOCAL_DEVNET_PK, DEPLOYER
 * - GAS_PRIORITY_FEE, GAS_MAX_FEE
 * - GLOAS_FORK_SLOT (Gloas fork epoch multiplied by the chain's slotsPerEpoch)
 * - A deployment state file selected by NETWORK_STATE_FILE (defaults to deployed-local-devnet.json)
 *
 * Optional environment:
 * - CAPELLA_FORK_SLOT (defaults to 0)
 * - FIRST_SUPPORTED_SLOT (defaults to CAPELLA_FORK_SLOT)
 * - GENESIS_FORK_VERSION (read from the current PredepositGuarantee deployment when omitted)
 *
 * Run with:
 *   GLOAS_FORK_SLOT=<slot> yarn deploy:devnet:gloas-verifiers
 */
import { network } from "hardhat";

import { ConsolidationGateway, LidoLocator } from "typechain-types";

import { deployContract, getAddress, getDeployerSigner, loadContract, log, readNetworkState, Sk } from "lib";

// Canonical mainnet-preset GIs for the pre-Gloas and Gloas consensus state layouts.
const GI_FIRST_VALIDATOR_PRE_GLOAS = "0x0000000000000000000000000000000000000000000000000096000000000028";
const GI_VALIDATORS = "0x0000000000000000000000000000000000000000000000000000000000016600";
const GI_FIRST_HISTORICAL_SUMMARY_PRE_GLOAS = "0x000000000000000000000000000000000000000000000000000000b600000018";
const GI_FIRST_HISTORICAL_SUMMARY_GLOAS = "0x0000000000000000000000000000000000000000000000000000170c00000018";
const GI_FIRST_BLOCK_ROOT_IN_SUMMARY = "0x000000000000000000000000000000000000000000000000000000000040000d";

const SLOTS_PER_HISTORICAL_ROOT = 8192n;
const SHARD_COMMITTEE_PERIOD_EPOCHS = 256n;

function readUintEnv(name: string, fallback?: bigint): bigint {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Env variable ${name} is not set`);
  }

  if (!/^\d+$/.test(value)) throw new Error(`Env variable ${name} must be an unsigned integer`);
  return BigInt(value);
}

function readGenesisForkVersion(state: ReturnType<typeof readNetworkState>): string {
  const envValue = process.env.GENESIS_FORK_VERSION;
  const value =
    envValue && envValue !== "" ? envValue : state[Sk.predepositGuarantee]?.implementation?.constructorArgs?.[0];
  if (typeof value !== "string" || !/^0x[\da-fA-F]{8}$/.test(value)) {
    throw new Error(
      "GENESIS_FORK_VERSION must be a bytes4 value when it cannot be read from the current PredepositGuarantee deployment",
    );
  }
  return value;
}

async function main(): Promise<void> {
  if (network.name !== "local-devnet") {
    throw new Error(`This script can only run on local-devnet, got ${network.name}`);
  }

  const deployer = await getDeployerSigner();
  const state = readNetworkState({ deployer: deployer.address });
  const chainSpec = state[Sk.chainSpec];
  const slotsPerEpoch = BigInt(chainSpec.slotsPerEpoch);
  const secondsPerSlot = BigInt(chainSpec.secondsPerSlot);
  const genesisTime = BigInt(chainSpec.genesisTime);
  const gloasForkSlot = readUintEnv("GLOAS_FORK_SLOT");
  const capellaForkSlot = readUintEnv("CAPELLA_FORK_SLOT", 0n);
  const firstSupportedSlot = readUintEnv("FIRST_SUPPORTED_SLOT", capellaForkSlot);
  const shardCommitteePeriodInSeconds = SHARD_COMMITTEE_PERIOD_EPOCHS * slotsPerEpoch * secondsPerSlot;

  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);
  const currentConsolidationGateway = await loadContract<ConsolidationGateway>(
    "ConsolidationGateway",
    await locator.consolidationGateway(),
  );
  const consolidationLimits = await currentConsolidationGateway.getConsolidationRequestLimitFullInfo();
  const genesisForkVersion = readGenesisForkVersion(state);

  log(`Deploying Gloas verifiers on local-devnet with fork slot ${gloasForkSlot}`);

  const validatorExitDelayVerifier = await deployContract(
    "ValidatorExitDelayVerifier",
    [
      locatorAddress,
      {
        gIFirstValidatorPreGloas: GI_FIRST_VALIDATOR_PRE_GLOAS,
        gIValidators: GI_VALIDATORS,
        gIFirstHistoricalSummaryPrev: GI_FIRST_HISTORICAL_SUMMARY_PRE_GLOAS,
        gIFirstHistoricalSummaryCurr: GI_FIRST_HISTORICAL_SUMMARY_GLOAS,
        gIFirstBlockRootInSummary: GI_FIRST_BLOCK_ROOT_IN_SUMMARY,
      },
      firstSupportedSlot,
      gloasForkSlot,
      capellaForkSlot,
      SLOTS_PER_HISTORICAL_ROOT,
      slotsPerEpoch,
      secondsPerSlot,
      genesisTime,
      shardCommitteePeriodInSeconds,
    ],
    deployer.address,
    false,
  );

  const predepositGuarantee = await deployContract(
    "PredepositGuarantee",
    [genesisForkVersion, GI_FIRST_VALIDATOR_PRE_GLOAS, GI_VALIDATORS, gloasForkSlot],
    deployer.address,
    false,
  );

  const topUpGateway = await deployContract(
    "TopUpGateway",
    [locatorAddress, GI_FIRST_VALIDATOR_PRE_GLOAS, GI_VALIDATORS, gloasForkSlot, slotsPerEpoch],
    deployer.address,
    false,
  );

  const consolidationGateway = await deployContract(
    "ConsolidationGateway",
    [
      deployer.address,
      locatorAddress,
      consolidationLimits.maxConsolidationRequestsLimit,
      consolidationLimits.consolidationsPerFrame,
      consolidationLimits.frameDurationInSec,
      GI_FIRST_VALIDATOR_PRE_GLOAS,
      GI_VALIDATORS,
      gloasForkSlot,
    ],
    deployer.address,
    false,
  );

  log.success("Gloas verifier deployments (not activated):");
  console.log(
    JSON.stringify(
      {
        validatorExitDelayVerifier: validatorExitDelayVerifier.address,
        predepositGuaranteeImplementation: predepositGuarantee.address,
        topUpGatewayImplementation: topUpGateway.address,
        consolidationGateway: consolidationGateway.address,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  log.error(error);
  process.exitCode = 1;
});
