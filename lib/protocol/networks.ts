import * as process from "node:process";

import { ProtocolNetworkItems } from "./types";

export async function parseLocalDeploymentJson() {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - file is missing out of the box, that's why we need to catch the error
    return await import("../../deployed-local.json");
  } catch (e) {
    throw new Error("Failed to parse deployed-local.json. Did you run scratch deploy?");
  }
}

export class ProtocolNetworkConfig {
  constructor(
    public readonly env: Record<keyof ProtocolNetworkItems, string>,
    public readonly defaults: Record<keyof ProtocolNetworkItems, string>,
  ) {
  }

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

const getPrefixedEnv = (prefix: string, obj: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [key, `${prefix}_${value}`]),
  );

const getDefaults = (obj: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(obj).map(([key]) => [key, ""]),
  );

export async function getNetworkConfig(network: string): Promise<ProtocolNetworkConfig> {
  const defaults = getDefaults(defaultEnv) as Record<keyof ProtocolNetworkItems, string>;

  switch (network) {
    case "local":
      const config = await parseLocalDeploymentJson();
      return new ProtocolNetworkConfig(
        getPrefixedEnv("LOCAL", defaultEnv),
        {
          ...defaults,
          locator: config["lidoLocator"].proxy.address,
          agentAddress: config["app:aragon-agent"].proxy.address,
          votingAddress: config["app:aragon-voting"].proxy.address,
          // Overrides for local development
          easyTrackAddress: config["app:aragon-agent"].proxy.address,
          sdvt: config["app:node-operators-registry"].proxy.address,
        });

    case "mainnet-fork":
    case "hardhat":
      const env = getPrefixedEnv("MAINNET", defaultEnv);
      return new ProtocolNetworkConfig(env, {
        ...defaults,
        locator: "0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb",
        // https://docs.lido.fi/deployed-contracts/#dao-contracts
        agentAddress: "0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c",
        votingAddress: "0x2e59A20f205bB85a89C53f1936454680651E618e",
        // https://docs.lido.fi/deployed-contracts/#easy-track
        easyTrackAddress: "0xFE5986E06210aC1eCC1aDCafc0cc7f8D63B3F977",
      });

    default:
      throw new Error(`Network ${network} is not supported`);
  }
}
