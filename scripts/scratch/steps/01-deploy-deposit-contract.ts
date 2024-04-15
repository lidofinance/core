import { ethers } from "hardhat";

import { deployWithoutProxy } from "lib/deploy";
import { log, yl } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

async function main() {
  log.scriptStart(__filename);
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  let depositContractAddress = state.chainSpec.depositContract;
  if (depositContractAddress) {
    log(`Using DepositContract at: ${yl(depositContractAddress)}`);
  } else {
    depositContractAddress = (await deployWithoutProxy(Sk.depositContract, "DepositContract", deployer)).address;
  }
  updateObjectInState(Sk.chainSpec, {
    depositContract: depositContractAddress,
  });

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
