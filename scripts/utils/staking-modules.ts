import { execFileSync } from "child_process";
import { HDNodeWallet } from "ethers";
import fs from "fs";
import { ethers, network as hardhatNetwork } from "hardhat";
import { getMode } from "hardhat.helpers";
import os from "os";
import path from "path";
import {
  readUpgradeParameters,
  writeUpgradeParameterAddress,
  writeUpgradeParameterAddresses,
} from "scripts/utils/upgrade";

import { HashConsensus, ValidatorExitDelayVerifier } from "typechain-types";

import { cy, getAddress, loadContract, log, warmUpJsonRpcProvider } from "lib";
import { DeploymentState, Sk, updateObjectInState } from "lib/state-file";

const STAKING_MODULES_REPO = "https://github.com/lidofinance/community-staking-module.git";
const STAKING_MODULES_REPO_BRANCH = "develop";

type ExternalDeployArtifact = Record<string, unknown> & {
  CSModule?: string;
  CuratedModule?: string;
};

//
// ---- Artifact -> canonical substate mapping ----
//
// The external deploy artifacts are flat maps of PascalCase keys: a proxy `X` and its implementation
// `XImpl`, plus singletons (`Verifier`, `Ejector`, gates) and lists (`CuratedGates`). We map them into
// canonical sub-keys that mirror the on-chain upgrade config / TOML params.
//
type ContractMap =
  | { kind: "proxied"; proxyKey?: string; implKey?: string }
  | { kind: "single"; addressKey: string }
  | { kind: "list"; listKey: string };

export const CSM_CONTRACTS: Record<string, ContractMap> = {
  module: { kind: "proxied", proxyKey: "CSModule", implKey: "CSModuleImpl" },
  vettedGate: { kind: "proxied", proxyKey: "VettedGate", implKey: "VettedGateImpl" },
  parametersRegistry: { kind: "proxied", proxyKey: "ParametersRegistry", implKey: "ParametersRegistryImpl" },
  feeOracle: { kind: "proxied", proxyKey: "FeeOracle", implKey: "FeeOracleImpl" },
  accounting: { kind: "proxied", proxyKey: "Accounting", implKey: "AccountingImpl" },
  feeDistributor: { kind: "proxied", proxyKey: "FeeDistributor", implKey: "FeeDistributorImpl" },
  exitPenalties: { kind: "proxied", proxyKey: "ExitPenalties", implKey: "ExitPenaltiesImpl" },
  strikes: { kind: "proxied", proxyKey: "ValidatorStrikes", implKey: "ValidatorStrikesImpl" },
  verifier: { kind: "single", addressKey: "Verifier" },
  permissionlessGate: { kind: "single", addressKey: "PermissionlessGate" },
  ejector: { kind: "single", addressKey: "Ejector" },
  identifiedDVTClusterGate: { kind: "single", addressKey: "IdentifiedDVTClusterGate" },
  identifiedDVTClusterCurveSetup: { kind: "single", addressKey: "IdentifiedDVTClusterCurveSetup" },
};

const CSM_UPGRADE_CONTRACTS: Record<string, ContractMap> = {
  ...CSM_CONTRACTS,
  verifier: { kind: "single", addressKey: "VerifierV3" },
};

const CM_CONTRACTS: Record<string, ContractMap> = {
  module: { kind: "proxied", proxyKey: "CuratedModule", implKey: "CuratedModuleImpl" },
  accounting: { kind: "proxied", proxyKey: "Accounting", implKey: "AccountingImpl" },
  parametersRegistry: { kind: "proxied", implKey: "ParametersRegistryImpl" },
  feeOracle: { kind: "proxied", implKey: "FeeOracleImpl" },
  feeDistributor: { kind: "proxied", implKey: "FeeDistributorImpl" },
  exitPenalties: { kind: "proxied", implKey: "ExitPenaltiesImpl" },
  strikes: { kind: "proxied", implKey: "ValidatorStrikesImpl" },
  metaRegistry: { kind: "proxied", implKey: "MetaRegistryImpl" },
  gateFactory: { kind: "single", addressKey: "CuratedGateFactory" },
  depositAllocator: { kind: "single", addressKey: "CuratedDepositAllocator" },
  verifier: { kind: "single", addressKey: "Verifier" },
  curatedGates: { kind: "list", listKey: "CuratedGates" },
};

//
// ---- Canonical substate -> upgrade-params TOML mapping ----
//
// `proxyParam` is preserved (written only when missing/zero in the TOML, since proxies pre-exist on-chain
// during an upgrade); `implParam` / `addressParam` / `listParam` are always overwritten with the freshly
// deployed addresses. Only keys present in the TOML schema are listed here.
//
type TomlMap = { proxyParam?: string; implParam?: string; addressParam?: string; listParam?: string };

const CSM_TOML_SECTION = "csmUpgrade";
const CSM_TOML_MAP: Record<string, TomlMap> = {
  module: { proxyParam: "csmProxy", implParam: "csmImpl" },
  vettedGate: { proxyParam: "vettedGateProxy", implParam: "vettedGateImpl" },
  parametersRegistry: { implParam: "parametersRegistryImpl" },
  feeOracle: { implParam: "feeOracleImpl" },
  accounting: { implParam: "accountingImpl" },
  feeDistributor: { implParam: "feeDistributorImpl" },
  exitPenalties: { implParam: "exitPenaltiesImpl" },
  strikes: { implParam: "strikesImpl" },
  verifier: { addressParam: "newVerifier" },
  permissionlessGate: { addressParam: "newPermissionlessGate" },
  ejector: { addressParam: "newEjector" },
  identifiedDVTClusterGate: { addressParam: "identifiedDVTClusterGate" },
  identifiedDVTClusterCurveSetup: { addressParam: "identifiedDVTClusterCurveSetup" },
};

const CM_TOML_SECTION = "curatedModule";
const CM_TOML_MAP: Record<string, TomlMap> = {
  module: { proxyParam: "module" },
  verifier: { addressParam: "verifier" },
  curatedGates: { listParam: "curatedGates" },
};

type SubstateEntry = {
  proxy?: { address: string };
  implementation?: { address: string };
  address?: string;
  addresses?: string[];
};
type Substate = Record<string, SubstateEntry>;

const CHAINS = ["mainnet", "hoodi", "local-devnet"] as const;
type Chain = (typeof CHAINS)[number];
const DEFAULT_CHAIN: Chain = "local-devnet";

export function getEnvParams() {
  /// @dev Supported chains: mainnet, hoodi, local-devnet
  const rawChain = process.env.NETWORK;
  return {
    chain: typeof rawChain === "string" && CHAINS.includes(rawChain as Chain) ? (rawChain as Chain) : DEFAULT_CHAIN,
    isScratch: getMode() === "scratch",
  };
}

function getRpcUrl() {
  const networkConfig = hardhatNetwork.config;
  const rpcUrl = "url" in networkConfig ? networkConfig.url : process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC URL is not available");
  return rpcUrl;
}

function getPrivateKey() {
  const accounts = hardhatNetwork.config.accounts;
  if (Array.isArray(accounts) && accounts.length > 0) {
    return accounts[0] as string;
  }

  if (typeof accounts === "object" && "mnemonic" in accounts) {
    const wallet = HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(accounts.mnemonic), `m/44'/60'/0'/0/0`);
    return wallet.privateKey;
  }

  const wallet = HDNodeWallet.fromMnemonic(
    ethers.Mnemonic.fromPhrase("test test test test test test test test test test test junk"),
    `m/44'/60'/0'/0/0`,
  );
  return wallet.privateKey;
}

function getRpcHostPort(rpcUrl: string) {
  const url = new URL(rpcUrl);
  return {
    ANVIL_IP_ADDR: url.hostname,
    ANVIL_PORT: url.port || (url.protocol === "https:" ? "443" : "80"),
  };
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  execFileSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
}

function readArtifact(artifactPath: string): ExternalDeployArtifact {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`External staking module deploy artifact not found at ${artifactPath}`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")) as ExternalDeployArtifact;
}

function isNonZeroAddress(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value !== ethers.ZeroAddress;
}

function artifactAddress(artifact: ExternalDeployArtifact, key: string): string | undefined {
  const value = artifact[key];
  return typeof value === "string" ? value : undefined;
}

function artifactAddressList(artifact: ExternalDeployArtifact, key: string): string[] | undefined {
  const value = artifact[key];
  return Array.isArray(value) ? (value as string[]) : undefined;
}

// Build the `contracts` substate from a deploy artifact, preserving any proxy address already present in
// the existing state (proxies pre-exist on-chain during an upgrade) and always taking implementations and
// singleton/list addresses from the fresh artifact.
export function buildSubstate(
  artifact: ExternalDeployArtifact,
  contractsMap: Record<string, ContractMap>,
  existing: Substate = {},
): Substate {
  const contracts: Substate = { ...existing };

  for (const [subKey, m] of Object.entries(contractsMap)) {
    if (m.kind === "single") {
      const addr = artifactAddress(artifact, m.addressKey);
      if (addr) contracts[subKey] = { address: addr };
      continue;
    }
    if (m.kind === "list") {
      const list = artifactAddressList(artifact, m.listKey);
      if (list) contracts[subKey] = { addresses: list };
      continue;
    }

    // proxied (proxyKey and/or implKey)
    const prev = existing[subKey] ?? {};
    const entry: SubstateEntry = { ...prev };

    if (m.implKey) {
      const impl = artifactAddress(artifact, m.implKey);
      if (impl) entry.implementation = { address: impl };
    }
    if (m.proxyKey) {
      const fromState = prev.proxy?.address;
      const proxyAddress = isNonZeroAddress(fromState) ? fromState : artifactAddress(artifact, m.proxyKey);
      if (proxyAddress) entry.proxy = { address: proxyAddress };
    }
    contracts[subKey] = entry;
  }

  return contracts;
}

// Write the canonical substate addresses into the given upgrade-params TOML section. Proxies are preserved
// (only filled when the current TOML value is empty/zero); implementations and new singletons/lists are
// always overwritten. No-op when not running an upgrade (UPGRADE_PARAMETERS_FILE unset).
function writeSubstateToToml(section: string, tomlMap: Record<string, TomlMap>, contracts: Substate) {
  if (!process.env.UPGRADE_PARAMETERS_FILE) return;

  try {
    const currentSection = (readUpgradeParameters(true) as Record<string, Record<string, unknown>>)[section] ?? {};

    for (const [subKey, t] of Object.entries(tomlMap)) {
      const entry = contracts[subKey];
      if (!entry) continue;

      if (t.implParam && entry.implementation?.address) {
        writeUpgradeParameterAddress(section, t.implParam, entry.implementation.address);
      }
      if (t.addressParam && entry.address) {
        writeUpgradeParameterAddress(section, t.addressParam, entry.address);
      }
      if (t.listParam && entry.addresses) {
        writeUpgradeParameterAddresses(section, t.listParam, entry.addresses);
      }
      if (t.proxyParam && entry.proxy?.address && !isNonZeroAddress(currentSection[t.proxyParam])) {
        writeUpgradeParameterAddress(section, t.proxyParam, entry.proxy.address);
      }
    }
  } catch (e) {
    log.warning(`Could not update [${section}] in upgrade params: ${(e as Error).message}`);
  }
}

function saveCSMArtifact(state: DeploymentState, artifact: ExternalDeployArtifact, isScratch: boolean) {
  if (!artifact.CSModule) throw new Error("CSM deploy artifact does not contain CSModule address");

  const existing = (state[Sk.sm_CSM]?.contracts ?? {}) as Substate;
  const proxyAddress = isNonZeroAddress(existing.module?.proxy?.address)
    ? (existing.module!.proxy!.address as string)
    : artifact.CSModule;
  const contracts = buildSubstate(artifact, isScratch ? CSM_CONTRACTS : CSM_UPGRADE_CONTRACTS, existing);

  updateObjectInState(Sk.sm_CSM, {
    proxy: {
      address: proxyAddress,
      contract: "external:staking-modules/src/CSModule.sol:CSModule",
      constructorArgs: [],
    },
    contracts,
    deployArtifact: artifact,
  });

  writeSubstateToToml(CSM_TOML_SECTION, CSM_TOML_MAP, contracts);
}

function saveCuratedArtifact(state: DeploymentState, artifact: ExternalDeployArtifact) {
  const moduleAddress = artifact.CuratedModule;
  if (!moduleAddress) throw new Error("Curated deploy artifact does not contain CuratedModule address");

  const existing = (state[Sk.sm_CM]?.contracts ?? {}) as Substate;
  const proxyAddress = isNonZeroAddress(existing.module?.proxy?.address)
    ? (existing.module!.proxy!.address as string)
    : moduleAddress;
  const contracts = buildSubstate(artifact, CM_CONTRACTS, existing);

  updateObjectInState(Sk.sm_CM, {
    proxy: {
      address: proxyAddress,
      contract: "external:staking-modules/src/CuratedModule.sol:CuratedModule",
      constructorArgs: [],
    },
    contracts,
    deployArtifact: artifact,
  });

  writeSubstateToToml(CM_TOML_SECTION, CM_TOML_MAP, contracts);
}

/**
 * Clones the external community-staking-module repo and deploys the Community Staking Module (CSM)
 * and Curated Module v2 (CMv2), saving their addresses into the deployment state file.
 *
 * Shared between the scratch deploy step and the protocol upgrade step.
 */
export async function deployStakingModules(state: DeploymentState): Promise<void> {
  // A module counts as deployed only once BOTH its proxy address and its deploy artifact are recorded.
  // During an upgrade the proxies are pre-written into the state file before the new implementations are
  // deployed, so the proxy address alone must not suppress the deploy.
  const csmDeployed = !!(state[Sk.sm_CSM]?.proxy?.address && state[Sk.sm_CSM]?.deployArtifact);
  const curatedDeployed = !!(state[Sk.sm_CM]?.proxy?.address && state[Sk.sm_CM]?.deployArtifact);

  if (csmDeployed && curatedDeployed) {
    log(`Using the deployed CSM address: ${cy(state[Sk.sm_CSM].proxy.address)}`);
    log(`Using the deployed CMv2 address: ${cy(state[Sk.sm_CM].proxy.address)}`);
    log.emptyLine();
    return;
  }

  if (hardhatNetwork.name === "hardhat") {
    log("In-memory 'hardhat' network detected: skipping external CSM/CMv2 deployment (no RPC URL for Foundry).");
    log.emptyLine();
    return;
  }

  const rpcUrl = getRpcUrl();
  const privateKey = getPrivateKey();
  const { chainId } = await ethers.provider.getNetwork();
  const chainSpec = state[Sk.chainSpec];
  const slotsPerEpoch = Number(chainSpec.slotsPerEpoch);
  const genesisTime = Number(chainSpec.genesisTime);

  const validatorExitDelayVerifier = await loadContract<ValidatorExitDelayVerifier>(
    "ValidatorExitDelayVerifier",
    getAddress(Sk.validatorExitDelayVerifier, state),
  );
  const capellaSlot = Number(await validatorExitDelayVerifier.CAPELLA_SLOT());
  const capellaEpoch = Math.floor(capellaSlot / slotsPerEpoch);
  const hashConsensus = await loadContract<HashConsensus>(
    "HashConsensus",
    getAddress(Sk.hashConsensusForAccountingOracle, state),
  );
  const { epochsPerFrame } = await hashConsensus.getFrameConfig();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "staking-modules-"));
  log(`Cloning staking modules repo to ${tmpDir}...`);

  try {
    run(
      "git",
      ["clone", "--depth", "1", "-b", STAKING_MODULES_REPO_BRANCH, "--single-branch", STAKING_MODULES_REPO, tmpDir],
      process.cwd(),
      process.env,
    );
    run("just", ["deps"], tmpDir, process.env);

    const { isScratch, chain } = getEnvParams();
    const artifactsDir = "./artifacts/local/";

    const externalEnv = {
      ...process.env,
      ...getRpcHostPort(rpcUrl),
      RPC_URL: rpcUrl,
      CHAIN: chain,
      ARTIFACTS_DIR: artifactsDir,
      YARN_IGNORE_NODE: "1",
      DEVNET_CHAIN_ID: chainId.toString(),
      DEVNET_SLOTS_PER_EPOCH: slotsPerEpoch.toString(),
      DEVNET_GENESIS_TIME: genesisTime.toString(),
      DEVNET_CAPELLA_EPOCH: capellaEpoch.toString(),
      DEVNET_ELECTRA_EPOCH: capellaEpoch.toString(),
      CSM_EPOCHS_PER_FRAME: epochsPerFrame.toString(),
      CSM_LOCATOR_ADDRESS: state[Sk.lidoLocator].proxy.address,
      CSM_ARAGON_AGENT_ADDRESS: state[Sk.appAgent].proxy.address,
      CSM_FIRST_ADMIN_ADDRESS: state[Sk.appAgent].proxy.address,
      CSM_RESEAL_MANAGER_ADDRESS: state[Sk.resealManager]?.address || state[Sk.appAgent].proxy.address,
      EVM_SCRIPT_EXECUTOR_ADDRESS: state[Sk.appVoting].proxy.address,
    } as unknown as NodeJS.ProcessEnv;

    if (!csmDeployed) {
      log("Deploying Community Staking Module from external repo...");
      let artifactsFile: string;
      const cmdOptions: string[] = [];
      if (isScratch) {
        cmdOptions.push(`deploy-csm`);
        artifactsFile = `deploy-${chain}.json`;
      } else {
        cmdOptions.push(`deploy-csm-impl`);
        cmdOptions.push(`--broadcast`);
        cmdOptions.push(`--slow`);
        artifactsFile = `upgrade-${chain}.json`;
      }
      cmdOptions.push(`--private-key=${privateKey}`);
      run("just", cmdOptions, tmpDir, externalEnv);
      const artifact = readArtifact(path.join(tmpDir, artifactsDir, "csm", artifactsFile));
      saveCSMArtifact(state, artifact, isScratch);
      log(`Community Staking Module deployed at: ${cy(artifact.CSModule!)}`);
      log.emptyLine();
    }

    if (!curatedDeployed) {
      log("Deploying Curated Module v2 from external repo...");
      /// @dev using deploy-curated for both scratch and upgrade, since Curated doesn't exist yet
      ///      and there's nothing to update. Reserved for future use
      const cmdOptions: string[] = [];
      cmdOptions.push("deploy-curated");
      cmdOptions.push(`--private-key=${privateKey}`);
      const artifactsFile = `deploy-${chain}.json`;
      run("just", cmdOptions, tmpDir, externalEnv);
      const artifact = readArtifact(path.join(tmpDir, artifactsDir, "curated", artifactsFile));
      saveCuratedArtifact(state, artifact);
      log(`Curated Module v2 deployed at: ${cy(artifact.CuratedModule!)}`);
      log.emptyLine();
    }

    await warmUpJsonRpcProvider();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
