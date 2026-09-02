import hre from "hardhat";

import { cy, deployWithoutProxy, log, updateObjectInState } from "#lib";
import { readNetworkState, Sk } from "#lib/state-file.js";

export async function main() {
  const { ethers } = await hre.network.getOrCreate();
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  // Check if EasyTrackEVMScriptExecutor address is already specified
  if (state[Sk.easyTrackEVMScriptExecutor]?.address) {
    log(`Using the specified EasyTrackEVMScriptExecutor address: ${cy(state[Sk.easyTrackEVMScriptExecutor].address)}`);
    log.emptyLine();
    return;
  }

  // deploy temporary stub
  const ese = await deployWithoutProxy(Sk.easyTrackEVMScriptExecutor, "EasyTrackEVMScriptExecutorStub", deployer);

  updateObjectInState(Sk.easyTrackEVMScriptExecutor, {
    note: "It is a temporary stub for EasyTrack deployment",
  });
  log(`EasyTrackEVMScriptExecutor deployed at: ${cy(ese.address)}`);
  log.emptyLine();
}
