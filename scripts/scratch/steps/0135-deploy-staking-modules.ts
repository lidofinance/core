import { ethers } from "hardhat";
import { deployStakingModules } from "scripts/utils/staking-modules";

import { isCMv2DeploymentEnabled, isCSMDeploymentEnabled } from "lib/scratch";
import { readNetworkState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  await deployStakingModules(state, { csm: isCSMDeploymentEnabled(), curated: isCMv2DeploymentEnabled() });
}
