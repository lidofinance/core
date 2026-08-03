import { execFileSync } from "child_process";
import { HDNodeWallet } from "ethers";
import fs from "fs";
import { ethers, network as hardhatNetwork } from "hardhat";
import os from "os";
import path from "path";

import { cy, log, warmUpJsonRpcProvider } from "lib";
import { DeploymentState, Sk, updateObjectInState } from "lib/state-file";

export const EDF_REPO = "https://github.com/lidofinance/execution-delegation-framework.git";
export const EDF_REPO_BRANCH = "main";

type ExternalDeployArtifact = {
  "ChainId"?: number | string;
  "DelegationFactory"?: string;
  "git-ref"?: string;
};

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

function runAndRead(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

function readArtifact(artifactPath: string): ExternalDeployArtifact {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`External EDF deploy artifact not found at ${artifactPath}`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")) as ExternalDeployArtifact;
}

type EDFDeploymentOptions = {
  expectedAddress?: string;
  expectedRuntimeCodeHash?: string;
  allowDeploy?: boolean;
};

async function validateFactory(address: string, expectedRuntimeCodeHash?: string): Promise<string> {
  const normalizedAddress = ethers.getAddress(address);
  const code = await ethers.provider.getCode(normalizedAddress);
  if (code === "0x") {
    throw new Error(`DelegationFactory at ${normalizedAddress} has no bytecode`);
  }
  const runtimeCodeHash = ethers.keccak256(code);
  if (expectedRuntimeCodeHash && runtimeCodeHash.toLowerCase() !== expectedRuntimeCodeHash.toLowerCase()) {
    throw new Error(
      `DelegationFactory runtime code hash mismatch: expected ${expectedRuntimeCodeHash}, got ${runtimeCodeHash}`,
    );
  }
  return runtimeCodeHash;
}

export async function deployExecutionDelegationFramework(
  state: DeploymentState,
  options: EDFDeploymentOptions = {},
): Promise<string> {
  const existingAddress = state[Sk.delegationFactory]?.address;
  const expectedAddress = options.expectedAddress ? ethers.getAddress(options.expectedAddress) : undefined;
  if (existingAddress && expectedAddress && ethers.getAddress(existingAddress) !== expectedAddress) {
    throw new Error(`DelegationFactory address mismatch: state ${existingAddress}, manifest ${expectedAddress}`);
  }

  const reusableAddress = existingAddress ?? expectedAddress;
  if (reusableAddress) {
    const normalizedAddress = ethers.getAddress(reusableAddress);
    const runtimeCodeHash = await validateFactory(normalizedAddress, options.expectedRuntimeCodeHash);
    updateObjectInState(Sk.delegationFactory, {
      address: normalizedAddress,
      runtimeCodeHash,
      repository: EDF_REPO,
      ref: state[Sk.delegationFactory]?.ref ?? EDF_REPO_BRANCH,
    });
    log(`Using the deployed DelegationFactory address: ${cy(normalizedAddress)}`);
    log.emptyLine();
    return normalizedAddress;
  }

  if (options.allowDeploy === false) {
    throw new Error("DelegationFactory is missing and deployment is disabled for this network");
  }

  if (hardhatNetwork.name === "hardhat") {
    throw new Error(
      "EDF requires an external scratch RPC for its Foundry deploy. Run integration tests with NETWORK=local.",
    );
  }

  const rpcUrl = getRpcUrl();
  const privateKey = getPrivateKey();
  const { chainId } = await ethers.provider.getNetwork();
  const artifactsDir = "./artifacts/local/";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "execution-delegation-framework-"));
  log(`Cloning Execution Delegation Framework repo to ${tmpDir}...`);

  try {
    run(
      "git",
      ["clone", "--depth", "1", "-b", EDF_REPO_BRANCH, "--single-branch", EDF_REPO, tmpDir],
      process.cwd(),
      process.env,
    );
    run("just", ["deps"], tmpDir, process.env);

    const externalEnv = {
      ...process.env,
      ...getRpcHostPort(rpcUrl),
      RPC_URL: rpcUrl,
      ARTIFACTS_DIR: artifactsDir,
      YARN_IGNORE_NODE: "1",
    } as unknown as NodeJS.ProcessEnv;

    log("Deploying Execution Delegation Framework from external repo...");
    run("just", ["deploy-local-devnet", chainId.toString(), `--private-key=${privateKey}`], tmpDir, externalEnv);

    await warmUpJsonRpcProvider();

    const artifactPath = path.join(tmpDir, artifactsDir, "deploy-local-devnet.json");
    const artifact = readArtifact(artifactPath);
    const clonedRef = runAndRead("git", ["rev-parse", "HEAD"], tmpDir);
    if (!artifact["git-ref"] || artifact["git-ref"].toLowerCase() !== clonedRef.toLowerCase()) {
      throw new Error(`EDF deploy artifact git ref ${artifact["git-ref"]} does not match cloned ref ${clonedRef}`);
    }
    if (artifact.ChainId === undefined || BigInt(artifact.ChainId) !== chainId) {
      throw new Error(`EDF deploy artifact chain id ${artifact.ChainId} does not match RPC chain id ${chainId}`);
    }

    const factoryAddress = artifact.DelegationFactory;
    if (!factoryAddress || ethers.getAddress(factoryAddress) === ethers.ZeroAddress) {
      throw new Error("EDF deploy artifact does not contain a valid DelegationFactory address");
    }

    const normalizedFactoryAddress = ethers.getAddress(factoryAddress);
    const runtimeCodeHash = await validateFactory(normalizedFactoryAddress, options.expectedRuntimeCodeHash);

    updateObjectInState(Sk.delegationFactory, {
      address: normalizedFactoryAddress,
      contract: "external:execution-delegation-framework/src/DelegationFactory.sol:DelegationFactory",
      constructorArgs: [],
      deployArtifact: artifact,
      runtimeCodeHash,
      repository: EDF_REPO,
      ref: clonedRef,
    });

    log(`Execution Delegation Framework deployed at: ${cy(normalizedFactoryAddress)}`);
    log.emptyLine();
    return normalizedFactoryAddress;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
