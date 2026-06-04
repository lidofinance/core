import { execFileSync } from "child_process";
import { HDNodeWallet } from "ethers";
import fs from "fs";
import { ethers, network as hardhatNetwork } from "hardhat";
import os from "os";
import path from "path";

import { cy, log, warmUpJsonRpcProvider } from "lib";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

const STAKING_MODULES_REPO = "https://github.com/lidofinance/community-staking-module.git";
const STAKING_MODULES_CHAIN = "local-devnet";

type ExternalDeployArtifact = Record<string, unknown> & {
  CSModule?: string;
  CuratedModule?: string;
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
    throw new Error(`External staking module deploy artifact not found at ${artifactPath}`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")) as ExternalDeployArtifact;
}

function saveCSMArtifact(artifact: ExternalDeployArtifact) {
  if (!artifact.CSModule) throw new Error("CSM deploy artifact does not contain CSModule address");

  updateObjectInState(Sk.sm_CSM, {
    proxy: {
      address: artifact.CSModule,
      contract: "external:staking-modules/src/CSModule.sol:CSModule",
      constructorArgs: [],
    },
    deployArtifact: artifact,
  });
}

function saveCuratedArtifact(artifact: ExternalDeployArtifact) {
  const moduleAddress = artifact.CuratedModule;
  if (!moduleAddress) throw new Error("Curated deploy artifact does not contain CuratedModule address");

  updateObjectInState(Sk.sm_CM, {
    proxy: {
      address: moduleAddress,
      contract: "external:staking-modules/src/CuratedModule.sol:CuratedModule",
      constructorArgs: [],
    },
    deployArtifact: artifact,
  });
}

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const csmAddress = state[Sk.sm_CSM]?.proxy?.address;
  const curatedAddress = state[Sk.sm_CM]?.proxy?.address;
  if (csmAddress && curatedAddress) {
    log(`Using the specified CSM address: ${cy(csmAddress)}`);
    log(`Using the specified CMv2 address: ${cy(curatedAddress)}`);
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
  const capellaSlot = Number(state[Sk.validatorExitDelayVerifier].deployParameters.capellaSlot);
  const capellaEpoch = Math.floor(capellaSlot / slotsPerEpoch);
  const hashConsensusParams = state[Sk.hashConsensusForAccountingOracle].deployParameters;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "staking-modules-"));
  log(`Cloning staking modules repo to ${tmpDir}...`);

  try {
    run("git", ["clone", "--depth", "1", STAKING_MODULES_REPO, tmpDir], process.cwd(), process.env);
    run("just", ["deps"], tmpDir, process.env);

    const externalEnv = {
      ...process.env,
      ...getRpcHostPort(rpcUrl),
      CHAIN: STAKING_MODULES_CHAIN,
      YARN_IGNORE_NODE: "1",
      DEVNET_CHAIN_ID: chainId.toString(),
      DEVNET_SLOTS_PER_EPOCH: slotsPerEpoch.toString(),
      DEVNET_GENESIS_TIME: genesisTime.toString(),
      DEVNET_CAPELLA_EPOCH: capellaEpoch.toString(),
      DEVNET_ELECTRA_EPOCH: capellaEpoch.toString(),
      CSM_EPOCHS_PER_FRAME: hashConsensusParams.epochsPerFrame.toString(),
      CSM_LOCATOR_ADDRESS: state[Sk.lidoLocator].proxy.address,
      CSM_ARAGON_AGENT_ADDRESS: state[Sk.appAgent].proxy.address,
      CSM_FIRST_ADMIN_ADDRESS: state[Sk.appAgent].proxy.address,
      CSM_RESEAL_MANAGER_ADDRESS: state[Sk.resealManager]?.address || state[Sk.appAgent].proxy.address,
      EVM_SCRIPT_EXECUTOR_ADDRESS: state[Sk.appVoting].proxy.address,
    } as unknown as NodeJS.ProcessEnv;

    if (!csmAddress) {
      log("Deploying Community Staking Module from external repo...");
      run("just", ["deploy-csm", `--private-key=${privateKey}`], tmpDir, externalEnv);
      const artifact = readArtifact(path.join(tmpDir, "artifacts", "local", "deploy-local-devnet.json"));
      saveCSMArtifact(artifact);
      log(`Community Staking Module deployed at: ${cy(artifact.CSModule!)}`);
      log.emptyLine();
    }

    if (!curatedAddress) {
      log("Deploying Curated Module v2 from external repo...");
      run("just", ["deploy-curated", `--private-key=${privateKey}`], tmpDir, externalEnv);
      const artifact = readArtifact(path.join(tmpDir, "artifacts", "local", "curated", "deploy-local-devnet.json"));
      saveCuratedArtifact(artifact);
      log(`Curated Module v2 deployed at: ${cy(artifact.CuratedModule!)}`);
      log.emptyLine();
    }

    await warmUpJsonRpcProvider();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
