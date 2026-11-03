import { ethers } from "hardhat";
import { deployExecutionDelegationFramework } from "scripts/utils/execution-delegation-framework";

import { readNetworkState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  await deployExecutionDelegationFramework(state);
}
