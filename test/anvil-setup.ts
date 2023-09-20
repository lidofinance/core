import "dotenv/config";
import { ChildProcess, spawn } from "child_process";
import { sleep } from "@nomicfoundation/hardhat-verify/internal/utilities";
import chalk from "chalk";
import { HardhatNetworkConfig } from "hardhat/src/types/config";

interface AnvilConfig extends HardhatNetworkConfig {
  url: string;
}

let anvilProcess: ChildProcess;
const NETWORK_NAME = "anvil";
const ANVIL_START_TIMEOUT = 10000;

async function createAnvil(networkConfig: AnvilConfig) {
  const forkArg = [];
  const url = new URL(networkConfig.url);
  if (networkConfig.forking?.url) {
    forkArg.push("--fork-url", networkConfig.forking.url);
  }
  const anvil = spawn("anvil", ["--host", url.hostname, "--port", url.port, ...forkArg], {});

  let started: boolean = false;
  anvil.stdout.on("data", (data) => {
    if (networkConfig.loggingEnabled) {
      const dataList = data.toString().split("\n");
      process.stdout.write(chalk.green(dataList.slice(0, 1)) + "\n");
      process.stdout.write(`${dataList.slice(1).join("\n")}`);
    }
    if (!started && data.toString().includes("Listening on")) {
      started = true;
    }
  });
  anvil.stderr.on("data", (data) => {
    process.stderr.write(chalk.red(`${data}`));
  });

  const start = Date.now();
  while (!started) {
    if (Date.now() - start > ANVIL_START_TIMEOUT) {
      throw new Error("Anvil start timeout");
    }
    await sleep(100);
  }
  return anvil;
}

export async function anvilStart() {
  const hre = await import("hardhat");
  if (hre.network.name !== NETWORK_NAME) return;

  const networkConfig = hre.userConfig.networks?.[NETWORK_NAME] as AnvilConfig;

  anvilProcess = await createAnvil(networkConfig);

  const originalRequest = hre.network.provider.request;
  hre.network.provider.request = (args) => {
    if (args.method === "web3_clientVersion") {
      return new Promise((resolve) => resolve(`hardhatnetwork:${NETWORK_NAME}`));
    }
    return originalRequest.apply(hre.network.provider, [args]);
  };

  console.log("Anvil started");
}

export async function anvilStop() {
  const hre = await import("hardhat");
  if (hre.network.name !== NETWORK_NAME) return;

  anvilProcess.kill();
  console.log("Anvil stopped");
}
