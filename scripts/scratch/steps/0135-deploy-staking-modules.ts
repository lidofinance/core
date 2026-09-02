import hre from "hardhat";

import { readNetworkState } from "#lib/state-file.js";

import { deployStakingModules } from "#scripts/utils/staking-modules.js";

export async function main() {
  const { ethers } = await hre.network.getOrCreate();
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  await deployStakingModules(state);
}
