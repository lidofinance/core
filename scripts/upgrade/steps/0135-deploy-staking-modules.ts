import { ethers } from "hardhat";
import { deployStakingModules } from "scripts/utils/staking-modules";

import { logScriptHeader, readNetworkState } from "lib";

export async function main() {
  const state = readNetworkState();
  const deployer = (await ethers.provider.getSigner()).address;

  await logScriptHeader("SRv3/CMv2 — Deploy Staking Modules (CSM/CMv2)", deployer);

  await deployStakingModules(state);
}
