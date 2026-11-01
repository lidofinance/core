import { ethers } from "hardhat";
import { deployStakingModules } from "scripts/utils/staking-modules";

import { log, toBool } from "lib";
import { readNetworkState } from "lib/state-file";

/// @dev CSM and CMv2 are deployed from their own repo; this step deploys them only to get a protocol with all modules
///      for the integration tests. Set SKIP_STAKING_MODULES=true (with ALLOW_SKIP_STEPS=true) to deploy core without them.
export async function skip(): Promise<boolean> {
  const skipStakingModules = toBool(process.env.SKIP_STAKING_MODULES);
  if (skipStakingModules) {
    log.warning("SKIP_STAKING_MODULES is set, CSM and CMv2 are not deployed");
  }
  return skipStakingModules;
}

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  await deployStakingModules(state);
}
