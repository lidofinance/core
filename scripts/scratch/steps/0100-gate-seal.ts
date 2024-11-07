import { ethers } from "hardhat";

import { loadContract } from "lib";
import { makeTx } from "lib/deploy";
import { findEvents } from "lib/event";
import { cy, log } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  // Check if GateSeal address is already specified
  if (state[Sk.gateSeal].address) {
    log(`Using the specified GateSeal address: ${cy(state[Sk.gateSeal].address)}`);
    log.emptyLine();
    return;
  }

  // Check if GateSealFactory address is specified
  if (!state[Sk.gateSeal].factoryAddress) {
    log(`GateSealFactory not specified: skipping creating GateSeal instance`);
    log.emptyLine();
    return;
  }

  // Create new GateSeal instance
  const sealableContracts = [state.withdrawalQueueERC721.proxy.address, state.validatorsExitBusOracle.proxy.address];
  const gateSealFactory = await loadContract("IGateSealFactory", state[Sk.gateSeal].factoryAddress);

  const receipt = await makeTx(
    gateSealFactory,
    "create_gate_seal",
    [
      state[Sk.gateSeal].sealingCommittee,
      state[Sk.gateSeal].sealDuration,
      sealableContracts,
      state[Sk.gateSeal].expiryTimestamp,
    ],
    { from: deployer },
  );

  // Extract and log the new GateSeal address
  const gateSealAddress = await findEvents(receipt, "GateSealCreated")[0].args.gate_seal;
  log(`GateSeal created: ${cy(gateSealAddress)}`);
  log.emptyLine();

  // Update the state with the new GateSeal address
  updateObjectInState(Sk.gateSeal, {
    address: gateSealAddress,
  });
}
