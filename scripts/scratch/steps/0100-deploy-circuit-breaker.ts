import { execSync } from "child_process";
import { HDNodeWallet } from "ethers";
import fs from "fs";
import { ethers, network as hardhatNetwork } from "hardhat";
import os from "os";
import path from "path";

import { cy, log } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

const CIRCUIT_BREAKER_REPO = "https://github.com/lidofinance/circuit-breaker.git";
const CIRCUIT_BREAKER_BRANCH = "deploy-script";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  // Check if CircuitBreaker address is already specified
  if (state[Sk.circuitBreaker].address) {
    log(`Using the specified CircuitBreaker address: ${cy(state[Sk.circuitBreaker].address)}`);
    log.emptyLine();
    return;
  }

  const agentAddress = state[Sk.appAgent].proxy.address;
  if (!agentAddress) {
    throw new Error("AragonAgent proxy address is not set in the state — CircuitBreaker requires it as admin");
  }

  const params = state[Sk.circuitBreaker].deployParameters;

  // Clone the CircuitBreaker repo into a temp directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "circuit-breaker-"));
  log(`Cloning CircuitBreaker repo to ${tmpDir}...`);

  try {
    const cloneCmd = `git clone --depth 1 --branch ${CIRCUIT_BREAKER_BRANCH} ${CIRCUIT_BREAKER_REPO} ${tmpDir}`;
    execSync(cloneCmd, { stdio: "inherit" });

    // Install foundry dependencies
    execSync("forge install", { cwd: tmpDir, stdio: "inherit" });

    // Extract RPC URL and private key from Hardhat's network config
    const networkConfig = hardhatNetwork.config;
    const rpcUrl = "url" in networkConfig ? networkConfig.url : process.env.RPC_URL;
    if (!rpcUrl) throw new Error("RPC URL is not available");

    const accounts = networkConfig.accounts;
    let privateKey: string;
    if (Array.isArray(accounts) && accounts.length > 0) {
      privateKey = accounts[0] as string;
    } else if (typeof accounts === "object" && "mnemonic" in accounts) {
      const wallet = HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(accounts.mnemonic), `m/44'/60'/0'/0/0`);
      privateKey = wallet.privateKey;
    } else {
      // Fallback: derive from the default Hardhat mnemonic (used by "local" network with `npx hardhat node`)
      const wallet = HDNodeWallet.fromMnemonic(
        ethers.Mnemonic.fromPhrase("test test test test test test test test test test test junk"),
        `m/44'/60'/0'/0/0`,
      );
      privateKey = wallet.privateKey;
    }

    const forgeArgs = [
      "forge script script/Deploy.s.sol:Deploy",
      `--sig "run(address,uint256,uint256,uint256,uint256,uint256,uint256)"`,
      agentAddress,
      params.minPauseDuration.toString(),
      params.maxPauseDuration.toString(),
      params.minHeartbeatInterval.toString(),
      params.maxHeartbeatInterval.toString(),
      params.initialPauseDuration.toString(),
      params.initialHeartbeatInterval.toString(),
      `--rpc-url ${rpcUrl}`,
      `--private-key ${privateKey}`,
      "--broadcast",
    ];

    if (process.env.ETHERSCAN_API_KEY) {
      forgeArgs.push("--verify", `--etherscan-api-key ${process.env.ETHERSCAN_API_KEY}`);
    }

    log("Running CircuitBreaker deploy script...");
    execSync(forgeArgs.join(" "), { cwd: tmpDir, stdio: "inherit" });

    // Read the deployment artifact
    const network = await ethers.provider.getNetwork();
    const chainId = network.chainId.toString();
    const artifactName = process.env.DEPLOY_NAME || chainId;
    const artifactPath = path.join(tmpDir, `${artifactName}.json`);

    if (!fs.existsSync(artifactPath)) {
      throw new Error(`CircuitBreaker deploy artifact not found at ${artifactPath}`);
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const circuitBreakerAddress = artifact.circuitBreaker;

    log(`CircuitBreaker deployed at: ${cy(circuitBreakerAddress)}`);
    log.emptyLine();

    updateObjectInState(Sk.circuitBreaker, {
      address: circuitBreakerAddress,
    });
  } finally {
    // Clean up the temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
