import { execFileSync } from "child_process";
import { HDNodeWallet } from "ethers";
import fs from "fs";
import { ethers, network as hardhatNetwork } from "hardhat";
import os from "os";
import path from "path";

import { cy, log, warmUpJsonRpcProvider } from "lib";
import { DeploymentState, Sk, updateObjectInState } from "lib/state-file";

const EDF_REPO = "https://github.com/lidofinance/execution-delegation-framework.git";
const EDF_REPO_BRANCH = "feat/local-devnet";

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

function readArtifact(artifactPath: string): ExternalDeployArtifact {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`External EDF deploy artifact not found at ${artifactPath}`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")) as ExternalDeployArtifact;
}

export async function deployExecutionDelegationFramework(state: DeploymentState): Promise<void> {
  const existingAddress = state[Sk.delegationFactory]?.address;
  const existingArtifact = state[Sk.delegationFactory]?.deployArtifact;
  if (existingAddress && existingArtifact) {
    log(`Using the deployed DelegationFactory address: ${cy(existingAddress)}`);
    log.emptyLine();
    return;
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
    if (artifact.ChainId === undefined || BigInt(artifact.ChainId) !== chainId) {
      throw new Error(`EDF deploy artifact chain id ${artifact.ChainId} does not match RPC chain id ${chainId}`);
    }

    const factoryAddress = artifact.DelegationFactory;
    if (!factoryAddress || ethers.getAddress(factoryAddress) === ethers.ZeroAddress) {
      throw new Error("EDF deploy artifact does not contain a valid DelegationFactory address");
    }

    const normalizedFactoryAddress = ethers.getAddress(factoryAddress);
    if ((await ethers.provider.getCode(normalizedFactoryAddress)) === "0x") {
      throw new Error(`DelegationFactory at ${normalizedFactoryAddress} has no bytecode`);
    }

    updateObjectInState(Sk.delegationFactory, {
      address: normalizedFactoryAddress,
      contract: "external:execution-delegation-framework/src/DelegationFactory.sol:DelegationFactory",
      constructorArgs: [],
      deployArtifact: artifact,
    });

    log(`Execution Delegation Framework deployed at: ${cy(normalizedFactoryAddress)}`);
    log.emptyLine();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
