import fs from "fs";
import { z } from "zod";

import * as toml from "@iarna/toml";

const UPGRADE_PARAMETERS_FILE = process.env.UPGRADE_PARAMETERS_FILE;

const EthereumAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address");
const NonNegativeIntSchema = z.number().int().nonnegative();

const UpgradeConfigSchema = z.object({
  csmProxy: EthereumAddressSchema,
  csmImpl: EthereumAddressSchema,
  vettedGateProxy: EthereumAddressSchema,
  parametersRegistryImpl: EthereumAddressSchema,
  feeOracleImpl: EthereumAddressSchema,
  feeOracleConsensusVersion: NonNegativeIntSchema,
  vettedGateImpl: EthereumAddressSchema,
  accountingImpl: EthereumAddressSchema,
  feeDistributorImpl: EthereumAddressSchema,
  exitPenaltiesImpl: EthereumAddressSchema,
  strikesImpl: EthereumAddressSchema,
  oldPermissionlessGate: EthereumAddressSchema,
  verifier: EthereumAddressSchema,
  verifierV3: EthereumAddressSchema,
  permissionlessGate: EthereumAddressSchema,
  ejector: EthereumAddressSchema,
});

const CuratedModuleConfigSchema = z.object({
  module: EthereumAddressSchema,
  hashConsensus: EthereumAddressSchema,
  moduleName: z.string().min(1),
  stakeShareLimit: NonNegativeIntSchema,
  priorityExitShareThreshold: NonNegativeIntSchema,
  stakingModuleFee: NonNegativeIntSchema,
  treasuryFee: NonNegativeIntSchema,
  maxDepositsPerBlock: NonNegativeIntSchema,
  minDepositBlockDistance: NonNegativeIntSchema,
});

const StakingRouterV3VoteScriptParamsSchema = z.object({
  agent: EthereumAddressSchema,
  easyTrackEVMScriptExecutor: EthereumAddressSchema,
  resealManager: EthereumAddressSchema,
  identifiedCommunityStakersGateManager: EthereumAddressSchema,
  gateSeal: EthereumAddressSchema,
  gateSealV3: EthereumAddressSchema,
  generalDelayedPenaltyReporter: EthereumAddressSchema,
  hashConsensusInitialEpoch: NonNegativeIntSchema,
  upgrade: UpgradeConfigSchema,
  curatedModule: CuratedModuleConfigSchema,
});

const UpgradeTomlSchema = z.object({
  stakingRouterV3VoteScript: StakingRouterV3VoteScriptParamsSchema,
});

export type StakingRouterV3VoteScriptParams = z.infer<typeof StakingRouterV3VoteScriptParamsSchema>;

export function readStakingRouterV3VoteScriptParameters(): StakingRouterV3VoteScriptParams {
  if (!UPGRADE_PARAMETERS_FILE) {
    throw new Error("UPGRADE_PARAMETERS_FILE is not set");
  }

  if (!fs.existsSync(UPGRADE_PARAMETERS_FILE)) {
    throw new Error(`Upgrade parameters file not found: ${UPGRADE_PARAMETERS_FILE}`);
  }

  const rawData = fs.readFileSync(UPGRADE_PARAMETERS_FILE, "utf8");
  const parsedData = toml.parse(rawData);
  const validated = UpgradeTomlSchema.parse(parsedData);

  return validated.stakingRouterV3VoteScript;
}
