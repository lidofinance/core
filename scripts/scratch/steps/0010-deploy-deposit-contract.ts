import { ethers } from "hardhat";

import { deployWithoutProxy } from "lib/deploy";
import { cy, log } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  let depositContractAddress = state.chainSpec.depositContract;
  if (depositContractAddress) {
    log(`Using DepositContract at: ${cy(depositContractAddress)}`);
    return;
  }

  depositContractAddress = (await deployWithoutProxy(Sk.depositContract, "DepositContract", deployer)).address;

  updateObjectInState(Sk.chainSpec, {
    depositContract: depositContractAddress,
  });
}
