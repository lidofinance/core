import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ethers, network as hardhatNetwork } from "hardhat";
import { EDF_REPO } from "scripts/utils/execution-delegation-framework";

import { DeploymentState, log, Sk } from "lib";

const FACTORY_CONTRACT = "src/DelegationFactory.sol:DelegationFactory";
const DELEGATION_CONTRACT = "src/DelegationContract.sol:DelegationContract";
const EDF_COMPILER_VERSION = "0.8.35";

type EDFDeployArtifact = {
  "DelegationFactory"?: string;
  "git-ref"?: string;
};

type StoredDelegationContract = {
  address?: string;
  owner?: string;
  delegate?: string;
  cooldown?: number;
};

type VerificationTarget = {
  label: string;
  address: string;
  contract: string;
  constructorArgs?: string;
};

type BlockscoutSourceResponse = {
  result?: Array<{
    SourceCode?: string;
  }>;
};

export type EDFDevnetVerificationPlan = {
  repository: string;
  ref: string;
  targets: VerificationTarget[];
};

function requiredAddress(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is missing in deployment state`);
  return ethers.getAddress(value);
}

export function buildEDFDevnetVerificationPlan(state: DeploymentState): EDFDevnetVerificationPlan {
  const factory = state[Sk.delegationFactory];
  if (!factory) throw new Error("DelegationFactory is missing in deployment state");
  if (factory.repository !== EDF_REPO) {
    throw new Error(`Unsupported EDF repository ${factory.repository}; expected ${EDF_REPO}`);
  }

  const artifact = factory.deployArtifact as EDFDeployArtifact | undefined;
  const ref = factory.ref as string | undefined;
  if (!ref || !/^[0-9a-f]{40}$/i.test(ref)) {
    throw new Error(`EDF deployment state must contain an exact git commit, got ${ref}`);
  }
  if (!artifact?.["git-ref"] || artifact["git-ref"].toLowerCase() !== ref.toLowerCase()) {
    throw new Error(`EDF deploy artifact git ref ${artifact?.["git-ref"]} does not match state ref ${ref}`);
  }

  const factoryAddress = requiredAddress(factory.address, "DelegationFactory address");
  const artifactFactory = requiredAddress(artifact.DelegationFactory, "EDF deploy artifact DelegationFactory");
  if (factoryAddress !== artifactFactory) {
    throw new Error(`DelegationFactory address mismatch: state ${factoryAddress}, artifact ${artifactFactory}`);
  }

  const storedContracts = (factory.delegationContracts ?? {}) as Record<string, StoredDelegationContract>;
  const entries = Object.entries(storedContracts).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) throw new Error("No DelegationContracts are stored in deployment state");

  const targets: VerificationTarget[] = [
    {
      label: "DelegationFactory",
      address: factoryAddress,
      contract: FACTORY_CONTRACT,
    },
  ];

  for (const [id, stored] of entries) {
    const address = requiredAddress(stored.address, `Delegation contract ${id} address`);
    const owner = requiredAddress(stored.owner, `Delegation contract ${id} owner`);
    const delegate = requiredAddress(stored.delegate, `Delegation contract ${id} delegate`);
    if (!Number.isSafeInteger(stored.cooldown) || stored.cooldown! < 0) {
      throw new Error(`Delegation contract ${id} cooldown is invalid: ${stored.cooldown}`);
    }

    targets.push({
      label: `DelegationContract ${id}`,
      address,
      contract: DELEGATION_CONTRACT,
      constructorArgs: ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256"],
        [owner, delegate, stored.cooldown],
      ),
    });
  }

  return {
    repository: EDF_REPO,
    ref,
    targets,
  };
}

export function buildForgeVerifyArgs(target: VerificationTarget, chainId: bigint, verifierUrl: string): string[] {
  return [
    "verify-contract",
    target.address,
    target.contract,
    "--chain",
    chainId.toString(),
    "--verifier",
    "blockscout",
    "--verifier-url",
    verifierUrl,
    "--compiler-version",
    EDF_COMPILER_VERSION,
    "--watch",
    ...(target.constructorArgs ? ["--constructor-args", target.constructorArgs] : []),
  ];
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  execFileSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
}

function runAndRead(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

export function isBlockscoutSourceVerified(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const result = (response as BlockscoutSourceResponse).result;
  return Array.isArray(result) && typeof result[0]?.SourceCode === "string" && result[0].SourceCode.length > 0;
}

async function requireBlockscoutSource(target: VerificationTarget, verifierUrl: string) {
  const statusUrl = new URL(verifierUrl);
  statusUrl.searchParams.set("module", "contract");
  statusUrl.searchParams.set("action", "getsourcecode");
  statusUrl.searchParams.set("address", target.address);

  for (let attempt = 1; attempt <= 10; attempt++) {
    const response = await fetch(statusUrl);
    if (!response.ok) {
      throw new Error(`Blockscout source check failed for ${target.label}: HTTP ${response.status}`);
    }
    if (isBlockscoutSourceVerified(await response.json())) return;
    if (attempt < 10) await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(
    `Blockscout did not verify ${target.label} at ${target.address}. ` +
      "Forge can exit with code 0 after Blockscout returns 'Fail - Unable to verify'.",
  );
}

export async function verifyExecutionDelegationFrameworkDevnet(state: DeploymentState) {
  if (hardhatNetwork.name !== "local-devnet") {
    throw new Error(`EDF devnet verification requires local-devnet, got ${hardhatNetwork.name}`);
  }

  const verifierUrl = process.env.LOCAL_DEVNET_EXPLORER_API_URL;
  if (!verifierUrl) throw new Error("LOCAL_DEVNET_EXPLORER_API_URL is required");

  const plan = buildEDFDevnetVerificationPlan(state);
  const { chainId } = await ethers.provider.getNetwork();
  const stateChainId = state[Sk.chainId] ?? state[Sk.chainSpec]?.chainId;
  if (stateChainId === undefined || BigInt(stateChainId) !== chainId) {
    throw new Error(`EDF verification chain ID mismatch: provider ${chainId}, state ${stateChainId}`);
  }

  for (const target of plan.targets) {
    if ((await ethers.provider.getCode(target.address)) === "0x") {
      throw new Error(`${target.label} at ${target.address} has no bytecode`);
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "execution-delegation-framework-verify-"));
  try {
    run("git", ["init"], tmpDir);
    run("git", ["remote", "add", "origin", plan.repository], tmpDir);
    run("git", ["fetch", "--depth", "1", "origin", plan.ref], tmpDir);
    run("git", ["checkout", "--detach", "FETCH_HEAD"], tmpDir);

    const clonedRef = runAndRead("git", ["rev-parse", "HEAD"], tmpDir);
    if (clonedRef.toLowerCase() !== plan.ref.toLowerCase()) {
      throw new Error(`Cloned EDF ref ${clonedRef} does not match deployment ref ${plan.ref}`);
    }

    run("just", ["deps"], tmpDir);
    const env = {
      ...process.env,
      FOUNDRY_PROFILE: "deploy",
      YARN_IGNORE_NODE: "1",
    } as unknown as NodeJS.ProcessEnv;
    for (const target of plan.targets) {
      log(`Verifying ${target.label} at ${target.address}`);
      run("forge", buildForgeVerifyArgs(target, chainId, verifierUrl), tmpDir, env);
      await requireBlockscoutSource(target, verifierUrl);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
