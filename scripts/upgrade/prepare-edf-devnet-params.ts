import fs from "node:fs";
import path from "node:path";

import { ethers } from "hardhat";
import { buildEDFDevnetUpgradeParameters, EDFDevnetCommittee } from "scripts/utils/edf-devnet";
import { EDF_REPO, EDF_REPO_BRANCH } from "scripts/utils/execution-delegation-framework";

import * as toml from "@iarna/toml";

type JsonObject = Record<string, unknown>;

const LOCATOR_ABI = ["function depositSecurityModule() view returns (address)"];
const DSM_ABI = [
  "function getGuardians() view returns (address[])",
  "function getGuardianQuorum() view returns (uint256)",
  "function getPauseIntentValidityPeriodBlocks() view returns (uint256)",
  "function getMaxOperatorsPerUnvetting() view returns (uint256)",
];
const HASH_CONSENSUS_ABI = [
  "function getMembers() view returns (address[] members, uint256 lastProcessingRefSlot)",
  "function getQuorum() view returns (uint256)",
];

// The shared devnet wallet keeps named deployer/oracle/council roles at
// indexes 0..6. These public accounts are the next unused wallet entries.
const GUARDIAN_DELEGATES = ["0x741bFE4802cE1C4b5b00F9Df2F5f179A1C89171A", "0xc3913d4D8bAb4914328651C2EAE817C8b78E1f4c"];
const ORACLE_DELEGATES = [
  "0x65D08a056c17Ae13370565B04cF77D2AfA1cB9FA",
  "0x3e95dFbBaF6B348396E6674C7871546dCC568e56",
  "0x5918b2e647464d4743601a865753e64C8059Dc4F",
];

const COMMITTEE_PATHS: {
  id: EDFDevnetCommittee["id"];
  paths: string[][];
}[] = [
  {
    id: "accounting-oracle",
    paths: [
      ["lidoCore", "hashConsensusForAccountingOracle", "address"],
      ["hashConsensusForAccountingOracle", "address"],
    ],
  },
  {
    id: "validators-exit-bus-oracle",
    paths: [
      ["lidoCore", "hashConsensusForValidatorsExitBusOracle", "address"],
      ["hashConsensusForValidatorsExitBusOracle", "address"],
    ],
  },
  {
    id: "csm-fee-oracle",
    paths: [
      ["csm", "HashConsensus"],
      ["csm", "hashConsensus"],
    ],
  },
  {
    id: "curated-module-fee-oracle",
    paths: [
      ["cmv2", "HashConsensus"],
      ["cmv2", "hashConsensus"],
    ],
  },
];

function readJson(filePath: string, label: string): JsonObject {
  if (!fs.existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object: ${filePath}`);
  }
  return parsed as JsonObject;
}

function readPath(input: JsonObject, keys: string[]): unknown {
  let value: unknown = input;
  for (const key of keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as JsonObject)[key];
  }
  return value;
}

function findAddress(input: JsonObject, paths: string[][]): string | undefined {
  for (const keys of paths) {
    const value = readPath(input, keys);
    if (typeof value === "string") return ethers.getAddress(value);
  }
  return undefined;
}

function readAddress(input: JsonObject, paths: string[][], label: string): string {
  const address = findAddress(input, paths);
  if (address) return address;
  throw new Error(`${label} address is missing from devnet state`);
}

function addressSetsEqual(actual: string[], expected: string[]): boolean {
  const actualSet = new Set(actual.map((address) => ethers.getAddress(address)));
  const expectedSet = new Set(expected.map((address) => ethers.getAddress(address)));
  return actualSet.size === expectedSet.size && [...actualSet].every((address) => expectedSet.has(address));
}

function readPositiveInteger(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} is not a positive safe integer: ${value}`);
  }
  return number;
}

async function requireCode(address: string, label: string): Promise<void> {
  if ((await ethers.provider.getCode(address)) === "0x") {
    throw new Error(`${label} at ${address} has no bytecode`);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const devnetStateFile = path.resolve(requiredEnv("DEVNET_STATE_FILE"));
  const networkStateFile = path.resolve(requiredEnv("NETWORK_STATE_FILE"));
  const outputFile = path.resolve(requiredEnv("UPGRADE_PARAMETERS_FILE"));
  const devnetState = readJson(devnetStateFile, "Devnet state");
  const networkState = readJson(networkStateFile, "Core network state");
  const force = process.env.EDF_DEVNET_PARAMS_FORCE === "true";

  if (fs.existsSync(outputFile) && !force) {
    throw new Error(`${outputFile} already exists; set EDF_DEVNET_PARAMS_FORCE=true to replace it`);
  }

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`Provider returned an invalid chain ID: ${network.chainId}`);
  }

  const wrapperChainId = readPath(devnetState, ["lidoCore", "chainId"]);
  const coreChainId = readPath(networkState, ["chainId"]) ?? readPath(networkState, ["chainSpec", "chainId"]);
  if (wrapperChainId === undefined || BigInt(wrapperChainId as string | number) !== network.chainId) {
    throw new Error(`Devnet state chain ID ${String(wrapperChainId)} does not match RPC chain ID ${network.chainId}`);
  }
  if (coreChainId === undefined || BigInt(coreChainId as string | number) !== network.chainId) {
    throw new Error(`Core state chain ID ${String(coreChainId)} does not match RPC chain ID ${network.chainId}`);
  }

  const wrapperLocator = readAddress(devnetState, [["lidoCore", "lidoLocator", "proxy", "address"]], "LidoLocator");
  const coreLocator = readAddress(networkState, [["lidoLocator", "proxy", "address"]], "Core LidoLocator");
  if (wrapperLocator !== coreLocator) {
    throw new Error(`LidoLocator mismatch: devnet state ${wrapperLocator}, core state ${coreLocator}`);
  }
  await requireCode(wrapperLocator, "LidoLocator");

  const locator = new ethers.Contract(wrapperLocator, LOCATOR_ABI, ethers.provider);
  const dsmAddress = ethers.getAddress(await locator.depositSecurityModule());
  await requireCode(dsmAddress, "DepositSecurityModule");
  const dsm = new ethers.Contract(dsmAddress, DSM_ABI, ethers.provider);
  const guardians = (await dsm.getGuardians()).map((address: string) => ethers.getAddress(address));
  if (guardians.length === 0) throw new Error("DepositSecurityModule has no guardians");

  const oracleCommittees: EDFDevnetCommittee[] = [];
  for (const committee of COMMITTEE_PATHS) {
    const devnetConsensusAddress = findAddress(devnetState, committee.paths);
    const coreConsensusAddress = findAddress(networkState, committee.paths);
    if (devnetConsensusAddress && coreConsensusAddress && devnetConsensusAddress !== coreConsensusAddress) {
      throw new Error(
        `${committee.id} mismatch: devnet state ${devnetConsensusAddress}, core state ${coreConsensusAddress}`,
      );
    }
    const consensusAddress = devnetConsensusAddress ?? coreConsensusAddress;
    if (!consensusAddress) throw new Error(`${committee.id} address is missing from devnet and core state`);
    await requireCode(consensusAddress, committee.id);

    const consensus = new ethers.Contract(consensusAddress, HASH_CONSENSUS_ABI, ethers.provider);
    const [rawMembers] = await consensus.getMembers();
    const members = (rawMembers as string[]).map((address) => ethers.getAddress(address));
    if (members.length === 0) throw new Error(`${committee.id} has no members`);

    oracleCommittees.push({
      id: committee.id,
      consensusContract: consensusAddress,
      members,
      quorum: readPositiveInteger(await consensus.getQuorum(), `${committee.id} quorum`),
    });
  }

  const expectedOracleWallets = process.env.EDF_DEVNET_ORACLE_WALLETS?.split(",")
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => ethers.getAddress(address));
  if (expectedOracleWallets?.length) {
    for (const committee of oracleCommittees) {
      if (!addressSetsEqual(committee.members, expectedOracleWallets)) {
        throw new Error(`${committee.id} members do not match EDF_DEVNET_ORACLE_WALLETS`);
      }
    }
  }

  const deployer = readAddress(networkState, [["deployer"]], "Core deployer");
  const owner = ethers.getAddress(process.env.EDF_DEVNET_OWNER ?? deployer);
  const cooldown = Number(process.env.EDF_DEVNET_COOLDOWN ?? "0");
  if (!Number.isSafeInteger(cooldown) || cooldown < 0) {
    throw new Error(`EDF_DEVNET_COOLDOWN must be a non-negative safe integer, got ${String(cooldown)}`);
  }

  const parameters = buildEDFDevnetUpgradeParameters({
    chainId,
    repository: EDF_REPO,
    ref: process.env.EDF_REPO_REF ?? EDF_REPO_BRANCH,
    owner,
    cooldown,
    guardians,
    guardianDelegates: GUARDIAN_DELEGATES,
    guardianQuorum: readPositiveInteger(await dsm.getGuardianQuorum(), "DSM guardian quorum"),
    maxOperatorsPerUnvetting: readPositiveInteger(
      await dsm.getMaxOperatorsPerUnvetting(),
      "DSM max operators per unvetting",
    ),
    pauseIntentValidityPeriodBlocks: readPositiveInteger(
      await dsm.getPauseIntentValidityPeriodBlocks(),
      "DSM pause intent validity period",
    ),
    oracleCommittees,
    oracleDelegates: ORACLE_DELEGATES,
  });

  const comments = [
    "# Generated from an already running devnet. It contains public addresses only.",
    `# Source state: ${devnetStateFile}`,
    `# Core working state: ${networkStateFile}`,
    `# EDF owner: ${owner}`,
    `# DSM delegates: ${GUARDIAN_DELEGATES.join(", ")}`,
    `# Oracle delegates: ${ORACLE_DELEGATES.join(", ")}`,
    ...oracleCommittees.map(({ id, members }) => `# ${id} wallets: ${members.join(", ")}`),
    "",
  ].join("\n");
  const content = `${comments}${toml.stringify(parameters as unknown as Parameters<typeof toml.stringify>[0])}`;

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, content, { encoding: "utf8", flag: force ? "w" : "wx" });

  console.log(`Prepared EDF devnet parameters: ${outputFile}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`LidoLocator: ${wrapperLocator}`);
  console.log(`DepositSecurityModule: ${dsmAddress}`);
  console.log(`DSM guardians: ${guardians.join(", ")}`);
  for (const committee of oracleCommittees) {
    console.log(`${committee.id}: ${committee.members.join(", ")} (quorum ${committee.quorum})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
