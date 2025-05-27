import { ethers } from "hardhat";

import { deployWithoutProxy } from "lib/deploy";
import { cy, log } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  let maxEffectiveBalanceIncreaserAddress = state.maxEffectiveBalanceIncreaser;
  if (maxEffectiveBalanceIncreaserAddress) {
    log(`Using MaxEffectiveBalanceIncreaser at: ${cy(maxEffectiveBalanceIncreaserAddress)}`);
    return;
  }

  maxEffectiveBalanceIncreaserAddress = (
    await deployWithoutProxy(Sk.maxEffectiveBalanceIncreaser, "MaxEffectiveBalanceIncreaser", deployer)
  ).address;

  updateObjectInState(Sk.maxEffectiveBalanceIncreaser, {
    maxEffectiveBalanceIncreaser: maxEffectiveBalanceIncreaserAddress,
  });
}
