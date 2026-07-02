import { ethers } from "hardhat";
import { deployStakingModules } from "scripts/utils/staking-modules";
import { checkArtifactDeployedAndLog } from "scripts/utils/upgrade";

import { logScriptHeader, readNetworkState, Sk } from "lib";

export async function skip(): Promise<boolean> {
  return (await checkArtifactDeployedAndLog(Sk.sm_CM)) && (await checkArtifactDeployedAndLog(Sk.sm_CSM));
}

export async function main() {
  const state = readNetworkState();
  const deployer = (await ethers.provider.getSigner()).address;

  await logScriptHeader("SRv3/CMv2 — Deploy Staking Modules (CSM/CMv2)", deployer);

  await deployStakingModules(state);
}
