import { ethers } from "hardhat";

import { cy, log } from "lib";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  if (deployer !== process.env.DEPLOYER) {
    throw new Error(`Deployer address mismatch: env DEPLOYER=${process.env.DEPLOYER}, signer=${deployer}`);
  }

  if (!process.env.NETWORK_STATE_FILE) {
    throw new Error("Env variable NETWORK_STATE_FILE is not set");
  }

  if (!process.env.GAS_PRIORITY_FEE) {
    throw new Error("Env variable GAS_PRIORITY_FEE is not set");
  }

  if (!process.env.GAS_MAX_FEE) {
    throw new Error("Env variable GAS_MAX_FEE is not set");
  }

  if (process.env.MODE === "scratch" && !process.env.GENESIS_TIME) {
    throw new Error("Env variable GENESIS_TIME is not set");
  }

  const latestBlockNumber = await ethers.provider.getBlockNumber();
  log(cy(`Latest block number: ${latestBlockNumber}`));
}
