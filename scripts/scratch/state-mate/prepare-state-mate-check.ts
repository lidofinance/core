/**
 * Prepares the inputs for the state-mate post-deploy check (see scratch.yaml in this directory).
 *
 * Reads the network state file (deployed-<network>.json) and generates next to scratch.yaml:
 *   - scratch.deployed.yaml — address anchors for the wiring-only main config (state-mate `.deployed` sibling)
 *   - scratch.inputs.yaml — deploy-parameter anchors (state-mate `.inputs` sibling)
 *   - abi/<Name>.json — ABIs for every contract name the main config mentions, copied from
 *     hardhat artifacts and the dual-governance forge out directory
 *
 * Usage: NETWORK_STATE_FILE=deployed-local.json yarn ts-node scripts/scratch/state-mate/prepare-state-mate-check.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CONFIG_DIR = __dirname;
const MAIN_CONFIG = path.join(CONFIG_DIR, "scratch.yaml");
const HARDHAT_ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts");
const DG_FORGE_OUT_DIR = path.join(REPO_ROOT, "foundry/lib/dual-governance/out");

// Anchor names follow the convention of state-mate's configs/lido/* configs:
// <label> for the (proxy) address and <label>ImplAddress for the implementation.

// State file key → anchor label, for entries with both `proxy` and `implementation`
const PROXY_PAIRS: Record<string, string> = {
  "accounting": "accounting",
  "accountingOracle": "accountingOracle",
  "app:aragon-agent": "aragonAgent",
  "app:aragon-finance": "aragonFinance",
  "app:aragon-token-manager": "aragonTokenManager",
  "app:aragon-voting": "aragonVoting",
  "app:lido": "lido",
  "app:node-operators-registry": "nodeOperatorsRegistry",
  "aragon-acl": "aragonAcl",
  "aragon-apm-registry": "aragonApmRegistry",
  "aragon-evm-script-registry": "aragonEvmScriptRegistry",
  "aragon-kernel": "aragonKernel",
  "burner": "burner",
  "lazyOracle": "lazyOracle",
  "lidoLocator": "lidoLocator",
  "operatorGrid": "operatorGrid",
  "predepositGuarantee": "predepositGuarantee",
  "stakingRouter": "stakingRouter",
  "validatorsExitBusOracle": "validatorsExitBusOracle",
  "vaultHub": "vaultHub",
  "withdrawalQueueERC721": "withdrawalQueueERC721",
  "withdrawalVault": "withdrawalVault",
};

// State file key → anchor label, proxy address only (implementation shared or checked elsewhere)
const PROXY_ONLY: Record<string, string> = {
  "app:simple-dvt": "simpleDvt", // shares the implementation with nodeOperatorsRegistry
};

// State file key → anchor label, implementation address only
const IMPL_ONLY: Record<string, string> = {
  ensSubdomainRegistrar: "ensSubdomainRegistrarImplAddress",
};

// State file key → anchor label, for entries with a single `address`
const SINGLES: Record<string, string> = {
  "apmRegistryFactory": "apmRegistryFactory",
  "aragon-repo-base": "aragonRepoBase",
  "aragonID": "aragonID",
  "callsScript": "callsScript",
  "daoFactory": "daoFactory",
  "dashboardImpl": "dashboardImplAddress",
  "depositContract": "depositContract",
  "depositSecurityModule": "depositSecurityModule",
  "dummyEmptyContract": "dummyEmptyContract",
  "eip712StETH": "eip712StETH",
  "ens": "ens",
  "ensFactory": "ensFactory",
  "evmScriptRegistryFactory": "evmScriptRegistryFactory",
  "executionLayerRewardsVault": "executionLayerRewardsVault",
  "hashConsensusForAccountingOracle": "hashConsensusForAccountingOracle",
  "hashConsensusForValidatorsExitBusOracle": "hashConsensusForValidatorsExitBusOracle",
  "ldo": "ldo",
  "lidoApm": "lidoApm",
  "lidoTemplate": "lidoTemplate",
  "minFirstAllocationStrategy": "minFirstAllocationStrategy",
  "miniMeTokenFactory": "miniMeTokenFactory",
  "oracleDaemonConfig": "oracleDaemonConfig",
  "oracleReportSanityChecker": "oracleReportSanityChecker",
  "stakingVaultBeacon": "stakingVaultBeacon",
  "stakingVaultFactory": "stakingVaultFactory",
  "stakingVaultImplementation": "stakingVaultImplAddress",
  "tokenRebaseNotifier": "tokenRebaseNotifier",
  "triggerableWithdrawalsGateway": "triggerableWithdrawalsGateway",
  "validatorConsolidationRequests": "validatorConsolidationRequests",
  "validatorExitDelayVerifier": "validatorExitDelayVerifier",
  "wstETH": "wstETH",
};

// Dual governance: state file key → anchor label; checked under the `l2` section of the main
// config (state-mate allows only `l1`/`l2` section names; both point at the same chain here)
// so that DG-less deployments can be verified with `--only l1`
const DG_SINGLES: Record<string, string> = {
  "dg:adminExecutor": "dgAdminExecutor",
  "dg:configProvider": "dgConfigProvider",
  "dg:dualGovernance": "dualGovernance",
  "dg:emergencyGovernance": "dgEmergencyGovernance",
  "dg:emergencyProtectedTimelock": "emergencyProtectedTimelock",
  "dg:escrowMasterCopy": "dgEscrowMasterCopy",
  "dg:tiebreakerCoreCommittee": "tiebreakerCoreCommittee",
  "resealManager": "resealManager",
};

const DG_TIEBREAKER_SUB_COMMITTEES_COUNT = 3; // referenced as tiebreakerSubCommittee0..2 in scratch.yaml

// State file keys that intentionally have no address anchors (params, tx hashes, metadata)
const IGNORED_KEYS = new Set([
  "aragonEnsLabelName",
  "chainId",
  "chainSpec",
  "createAppReposTx",
  "daoAragonId",
  "daoInitialSettings",
  "deployer",
  "ensNode",
  "gateSeal", // not deployed from scratch: address/factoryAddress are null
  "lidoApmEnsName",
  "lidoApmEnsRegDurationSec",
  "lidoTemplateCreateStdAppReposTx",
  "lidoTemplateNewDaoTx",
  "networkId",
  "nodeOperatorsRegistry", // deploy parameters only; the app itself is app:node-operators-registry
  "scratchDeployCompletedSteps", // resume-mode cursor maintained by the step runner
  "scratchDeployGasUsed",
  "simpleDvt", // deploy parameters only; the app itself is app:simple-dvt
  "vestingParams",
  "dg:tiebreakerSubCommittees", // handled explicitly (variable-size array)
]);

interface StateFile {
  [key: string]: unknown;
}

function quote(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlAnchorList(entries: [string, unknown][], indent: number, format: (v: unknown) => string): string {
  const spaces = " ".repeat(indent);
  return entries.map(([label, value]) => `${spaces}- &${label} ${format(value)}`).join("\n");
}

function die(message: string): never {
  console.error(`prepare-state-mate-check: ${message}`);
  process.exit(1);
}

function get(state: StateFile, key: string): Record<string, unknown> {
  const value = state[key];
  if (value === undefined || value === null) die(`missing key "${key}" in the state file`);
  return value as Record<string, unknown>;
}

function addressOf(entry: unknown, field: string, key: string): string {
  const container = field ? (entry as Record<string, unknown>)[field] : entry;
  const address = (container as Record<string, unknown> | undefined)?.address;
  if (typeof address !== "string" || !address.startsWith("0x")) {
    die(`no ${field || "top-level"} address for state file key "${key}"`);
  }
  return address;
}

function buildDeployedYaml(state: StateFile): { yaml: string; dgDeployed: boolean } {
  const l1: [string, string][] = [];
  for (const [key, label] of Object.entries(PROXY_PAIRS)) {
    const entry = get(state, key);
    l1.push([label, addressOf(entry, "proxy", key)]);
    l1.push([`${label}ImplAddress`, addressOf(entry, "implementation", key)]);
  }
  for (const [key, label] of Object.entries(PROXY_ONLY)) l1.push([label, addressOf(get(state, key), "proxy", key)]);
  for (const [key, label] of Object.entries(IMPL_ONLY))
    l1.push([label, addressOf(get(state, key), "implementation", key)]);
  for (const [key, label] of Object.entries(SINGLES)) l1.push([label, addressOf(get(state, key), "", key)]);

  const dgDeployed = typeof state["dg:dualGovernance"] === "object" && state["dg:dualGovernance"] !== null;
  const dg: [string, string][] = [];
  for (const [key, label] of Object.entries(DG_SINGLES)) {
    dg.push([label, dgDeployed ? addressOf(get(state, key), "", key) : ZERO_ADDRESS]);
  }
  const subCommittees = dgDeployed
    ? ((state["dg:tiebreakerSubCommittees"] as { addresses: string[] })?.addresses ?? [])
    : Array.from({ length: DG_TIEBREAKER_SUB_COMMITTEES_COUNT }, () => ZERO_ADDRESS);
  if (subCommittees.length !== DG_TIEBREAKER_SUB_COMMITTEES_COUNT) {
    die(
      `expected ${DG_TIEBREAKER_SUB_COMMITTEES_COUNT} tiebreaker sub-committees, got ${subCommittees.length}: ` +
        `update DG_TIEBREAKER_SUB_COMMITTEES_COUNT and the tiebreaker checks in scratch.yaml`,
    );
  }
  subCommittees.forEach((address, index) => dg.push([`tiebreakerSubCommittee${index}`, address]));

  const yaml = `# Generated by prepare-state-mate-check.ts — do not edit\ndeployed:\n  l1:\n${yamlAnchorList(l1, 4, quote)}\n  l2:\n${yamlAnchorList(dg, 4, quote)}\n`;
  return { yaml, dgDeployed };
}

function buildInputsYaml(state: StateFile): string {
  const chainSpec = get(state, "chainSpec");
  const settings = get(state, "daoInitialSettings");
  const voting = (settings as { voting: Record<string, unknown> }).voting;
  const token = (settings as { token: Record<string, unknown> }).token;
  const deployParams = (key: string) =>
    (get(state, key) as { deployParameters: Record<string, unknown> }).deployParameters;
  const norParameters = deployParams("nodeOperatorsRegistry");
  const sdvtParameters = deployParams("simpleDvt");
  const dsmParameters = deployParams("depositSecurityModule");
  const withdrawalVault = addressOf(get(state, "withdrawalVault"), "proxy", "withdrawalVault");
  const withdrawalCredentials = `0x01${"0".repeat(22)}${withdrawalVault.slice(2).toLowerCase()}`;

  const config: [string, unknown][] = [
    ["daoTokenName", token.name],
    ["daoTokenSymbol", token.symbol],
    ["votingMinSupportRequired", voting.minSupportRequired],
    ["votingMinAcceptanceQuorum", voting.minAcceptanceQuorum],
    ["votingVoteDuration", voting.voteDuration],
    ["votingObjectionPhaseDuration", voting.objectionPhaseDuration],
    ["norStuckPenaltyDelay", norParameters.stuckPenaltyDelay],
    ["sdvtStuckPenaltyDelay", sdvtParameters.stuckPenaltyDelay],
    ["dsmMaxOperatorsPerUnvetting", dsmParameters.maxOperatorsPerUnvetting],
    ["dsmPauseIntentValidityPeriodBlocks", dsmParameters.pauseIntentValidityPeriodBlocks],
    ["lidoApmEnsName", state["lidoApmEnsName"]],
    ["genesisTime", chainSpec.genesisTime],
    ["slotsPerEpoch", chainSpec.slotsPerEpoch],
    ["secondsPerSlot", chainSpec.secondsPerSlot],
    ["lidoWithdrawalCredentials", withdrawalCredentials],
  ];
  const externals: [string, unknown][] = [
    ["chainId", state["chainId"]],
    ["deployer", state["deployer"]],
  ];

  return (
    `# Generated by prepare-state-mate-check.ts — do not edit\n` +
    `config:\n${yamlAnchorList(config, 2, quote)}\nexternals:\n${yamlAnchorList(externals, 2, quote)}\n`
  );
}

function checkAllStateKeysCovered(state: StateFile) {
  const known = new Set([
    ...Object.keys(PROXY_PAIRS),
    ...Object.keys(PROXY_ONLY),
    ...Object.keys(IMPL_ONLY),
    ...Object.keys(SINGLES),
    ...Object.keys(DG_SINGLES),
    ...IGNORED_KEYS,
  ]);
  const unknown = Object.keys(state).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    die(
      `state file keys not covered by the state-mate check mappings: ${unknown.join(", ")}\n` +
        `Add them to the mapping tables in this script (and to scratch.yaml) or to IGNORED_KEYS.`,
    );
  }
}

function collectConfigContractNames(): { l1: Set<string>; l2: Set<string> } {
  const text = fs.readFileSync(MAIN_CONFIG, "utf8");
  const l1 = new Set<string>();
  const l2 = new Set<string>();
  let section = "";
  for (const line of text.split("\n")) {
    const sectionMatch = line.match(/^([A-Za-z0-9_]+):/);
    if (sectionMatch) section = sectionMatch[1];
    // Contract fields sit at 6-space indentation; deeper matches would be check lines
    const nameMatch = line.match(/^ {6}(?:name|proxyName):\s*([A-Za-z0-9_]+)\s*$/);
    if (nameMatch) (section === "l2" ? l2 : l1).add(nameMatch[1]);
  }
  if (l1.size === 0) die(`no contract names found in ${MAIN_CONFIG}`);
  return { l1, l2 };
}

function findArtifacts(root: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "build-info") continue;
        walk(fullPath);
      } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) {
        // Artifact basename is the contract name; the parent dir is the source file,
        // which may differ (e.g. MiniMeToken.sol/MiniMeTokenFactory.json)
        if (path.basename(directory).endsWith(".sol")) {
          const name = path.basename(entry.name, ".json");
          const existing = found.get(name);
          if (existing) existing.push(fullPath);
          else found.set(name, [fullPath]);
        }
      }
    }
  };
  walk(root);
  return found;
}

function exportAbis(dgDeployed: boolean) {
  const { l1, l2 } = collectConfigContractNames();
  // The l2 (dual-governance) ABIs exist only in the forge out dir, built when step 0160
  // actually runs; a DG-less deploy is checked with `--only l1`, so they aren't needed
  const names = dgDeployed ? new Set([...l1, ...l2]) : l1;
  const abiDirectory = path.join(CONFIG_DIR, "abi");
  fs.rmSync(abiDirectory, { recursive: true, force: true });
  fs.mkdirSync(abiDirectory, { recursive: true });

  const hardhatArtifacts = findArtifacts(HARDHAT_ARTIFACTS_DIR);
  const forgeArtifacts = fs.existsSync(DG_FORGE_OUT_DIR)
    ? findArtifacts(DG_FORGE_OUT_DIR)
    : new Map<string, string[]>();

  const missing: string[] = [];
  for (const name of names) {
    const candidates = hardhatArtifacts.get(name) ?? forgeArtifacts.get(name) ?? [];
    if (candidates.length === 0) {
      missing.push(name);
      continue;
    }
    // Prefer the shortest path on ambiguity (e.g. a contract over its test/mock copies)
    const artifactPath = [...candidates].sort((a, b) => a.length - b.length)[0];
    if (candidates.length > 1) {
      console.warn(`prepare-state-mate-check: multiple artifacts for ${name}, using ${artifactPath}`);
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    if (!Array.isArray(artifact.abi)) die(`artifact ${artifactPath} has no "abi" array`);
    fs.writeFileSync(path.join(abiDirectory, `${name}.json`), JSON.stringify({ abi: artifact.abi }, null, 2));
  }
  if (missing.length > 0) die(`no artifacts found for contract names: ${missing.join(", ")}`);
  console.log(`prepare-state-mate-check: exported ${names.size} ABIs to ${path.relative(REPO_ROOT, abiDirectory)}`);
}

function main() {
  const stateFilePath = process.env.NETWORK_STATE_FILE || `deployed-${process.env.NETWORK || "local"}.json`;
  const resolvedStateFilePath = path.isAbsolute(stateFilePath) ? stateFilePath : path.join(REPO_ROOT, stateFilePath);
  if (!fs.existsSync(resolvedStateFilePath)) die(`state file not found: ${resolvedStateFilePath}`);
  const state: StateFile = JSON.parse(fs.readFileSync(resolvedStateFilePath, "utf8"));

  checkAllStateKeysCovered(state);

  const { yaml: deployedYaml, dgDeployed } = buildDeployedYaml(state);
  fs.writeFileSync(path.join(CONFIG_DIR, "scratch.deployed.yaml"), deployedYaml);
  fs.writeFileSync(path.join(CONFIG_DIR, "scratch.inputs.yaml"), buildInputsYaml(state));
  exportAbis(dgDeployed);

  console.log(
    `prepare-state-mate-check: generated scratch.deployed.yaml and scratch.inputs.yaml from ` +
      `${path.basename(resolvedStateFilePath)} (dual governance ${dgDeployed ? "deployed" : "NOT deployed — check with --only l1"})`,
  );
}

main();
