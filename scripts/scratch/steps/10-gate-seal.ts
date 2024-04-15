import { ethers } from "hardhat";

import { getContractAt } from "lib/contract";
import { makeTx } from "lib/deploy";
import { findEvents } from "lib/event";
import { log } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

async function main() {
  log.scriptStart(__filename);
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  if (state[Sk.gateSeal].address) {
    log(`Using the specified GateSeal address ${state[Sk.gateSeal].address}`);
    return;
  } else if (!state[Sk.gateSeal].factoryAddress) {
    log(`GateSealFactory not specified: skipping creating GateSeal instance`);
    return;
  } else {
    const sealables = [state.withdrawalQueueERC721.proxy.address, state.validatorsExitBusOracle.proxy.address];
    const gateSealFactory = await getContractAt("IGateSealFactory", state[Sk.gateSeal].factoryAddress);
    const receipt = await makeTx(
      gateSealFactory,
      "create_gate_seal",
      [
        state[Sk.gateSeal].sealingCommittee,
        state[Sk.gateSeal].sealDuration,
        sealables,
        state[Sk.gateSeal].expiryTimestamp,
      ],
      { from: deployer },
    );
    const gateSealAddress = await findEvents(receipt, "GateSealCreated")[0].args.gate_seal;
    log(`GateSeal created: ${gateSealAddress}`);

    updateObjectInState(Sk.gateSeal, {
      address: gateSealAddress,
    });
  }

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
