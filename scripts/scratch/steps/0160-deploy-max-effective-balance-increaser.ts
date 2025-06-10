import { ethers } from "hardhat";

import { deployWithoutProxy } from "lib/deploy";
import { cy, log } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  let validatorConsolidationRequestsAddress = state.validatorConsolidationRequests;
  if (validatorConsolidationRequestsAddress) {
    log(`Using ValidatorConsolidationRequests at: ${cy(validatorConsolidationRequestsAddress)}`);
    return;
  }

  validatorConsolidationRequestsAddress = (
    await deployWithoutProxy(Sk.validatorConsolidationRequests, "ValidatorConsolidationRequests", deployer)
  ).address;

  updateObjectInState(Sk.validatorConsolidationRequests, {
    validatorConsolidationRequests: validatorConsolidationRequestsAddress,
  });
}
