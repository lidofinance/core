import hre from "hardhat";

import { deployWithoutProxy } from "#lib/deploy.js";
import { cy, log } from "#lib/log.js";
import { readNetworkState, Sk, updateObjectInState } from "#lib/state-file.js";

export async function main() {
  const { ethers } = await hre.network.getOrCreate();
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
