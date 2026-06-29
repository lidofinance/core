import { ethers } from "hardhat";
import { deployStakingModules } from "scripts/utils/staking-modules";

import { readNetworkState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  await deployStakingModules(state);
}
