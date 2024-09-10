import * as process from "node:process";

import hre from "hardhat";

import { log } from "lib";

import { ProtocolNetworkItems } from "./types";

// If we are running in Hardhat without fork, we need to deploy the contracts from scratch deploy first to run integration tests
export function isNonForkingHardhatNetwork() {
  const networkName = hre.network.name;
  if (networkName === "hardhat") {
    const networkConfig = hre.config.networks[networkName];
    return !networkConfig.forking?.enabled;
  }
  return false;
}

export async function parseDeploymentJson(name: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - file is missing out of the box, that's why we need to catch the error
    return await import(`../../deployed-${name}.json`);
  } catch (e) {
    log.error(e as Error);
    throw new Error("Failed to parse deployed-local.json. Did you run scratch deploy?");
  }
}

export class ProtocolNetworkConfig {
  constructor(
    public readonly env: Record<keyof ProtocolNetworkItems, string>,
    public readonly defaults: Record<keyof ProtocolNetworkItems, string>,
    public readonly source: string,
  ) {}

  get(key: keyof ProtocolNetworkItems): string {
    return process.env[this.env[key]] || this.defaults[key] || "";
  }
}

const defaultEnv = {
  locator: "LOCATOR_ADDRESS",
  // signers
  agentAddress: "AGENT_ADDRESS",
  votingAddress: "VOTING_ADDRESS",
  easyTrackAddress: "EASY_TRACK_EXECUTOR_ADDRESS",
  // foundation contracts
  accountingOracle: "ACCOUNTING_ORACLE_ADDRESS",
  depositSecurityModule: "DEPOSIT_SECURITY_MODULE_ADDRESS",
  elRewardsVault: "EL_REWARDS_VAULT_ADDRESS",
  legacyOracle: "LEGACY_ORACLE_ADDRESS",
  lido: "LIDO_ADDRESS",
  oracleReportSanityChecker: "ORACLE_REPORT_SANITY_CHECKER_ADDRESS",
  burner: "BURNER_ADDRESS",
  stakingRouter: "STAKING_ROUTER_ADDRESS",
  validatorsExitBusOracle: "VALIDATORS_EXIT_BUS_ORACLE_ADDRESS",
  withdrawalQueue: "WITHDRAWAL_QUEUE_ADDRESS",
  withdrawalVault: "WITHDRAWAL_VAULT_ADDRESS",
  oracleDaemonConfig: "ORACLE_DAEMON_CONFIG_ADDRESS",
  // aragon contracts
  kernel: "ARAGON_KERNEL_ADDRESS",
  acl: "ARAGON_ACL_ADDRESS",
  // stacking modules
  nor: "NODE_OPERATORS_REGISTRY_ADDRESS",
  sdvt: "SIMPLE_DVT_REGISTRY_ADDRESS",
  // hash consensus
  hashConsensus: "HASH_CONSENSUS_ADDRESS",
} as ProtocolNetworkItems;

const getPrefixedEnv = (prefix: string, obj: ProtocolNetworkItems) =>
  Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, `${prefix}_${value}`])) as ProtocolNetworkItems;

const getDefaults = (obj: ProtocolNetworkItems) =>
  Object.fromEntries(Object.entries(obj).map(([key]) => [key, ""])) as ProtocolNetworkItems;

async function getLocalNetworkConfig(network: string, source: string): Promise<ProtocolNetworkConfig> {
  const config = await parseDeploymentJson(network);
  const defaults: Record<keyof ProtocolNetworkItems, string> = {
    ...getDefaults(defaultEnv),
    locator: config["lidoLocator"].proxy.address,
    agentAddress: config["app:aragon-agent"].proxy.address,
    votingAddress: config["app:aragon-voting"].proxy.address,
    easyTrackAddress: config["app:aragon-agent"].proxy.address,
    sdvt: config["app:node-operators-registry"].proxy.address,
  };
  return new ProtocolNetworkConfig(getPrefixedEnv(network.toUpperCase(), defaultEnv), defaults, `${network}-${source}`);
}

async function getMainnetForkNetworkConfig(): Promise<ProtocolNetworkConfig> {
  const defaults: Record<keyof ProtocolNetworkItems, string> = {
    ...getDefaults(defaultEnv),
    locator: "0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb",
    agentAddress: "0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c",
    votingAddress: "0x2e59A20f205bB85a89C53f1936454680651E618e",
    easyTrackAddress: "0xFE5986E06210aC1eCC1aDCafc0cc7f8D63B3F977",
  };
  return new ProtocolNetworkConfig(getPrefixedEnv("MAINNET", defaultEnv), defaults, "mainnet-fork");
}

export async function getNetworkConfig(network: string): Promise<ProtocolNetworkConfig> {
  switch (network) {
    case "local":
      return getLocalNetworkConfig(network, "fork");
    case "mainnet-fork":
      return getMainnetForkNetworkConfig();
    case "hardhat":
      if (isNonForkingHardhatNetwork()) {
        return getLocalNetworkConfig(network, "scratch");
      }
      return getMainnetForkNetworkConfig();
    default:
      throw new Error(`Network ${network} is not supported`);
  }
}
