import assert from "assert";
import { ethers } from "hardhat";

import { deployImplementation, readNetworkState, Sk } from "lib";

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;
  assert.equal(process.env.DEPLOYER, deployer);

  const state = readNetworkState();

  //
  // Extract necessary addresses and parameters from the state
  //
  const locatorAddress = state[Sk.lidoLocator].proxy.address;

  //
  // New AlertingHarness deployment
  //
  const alertingHarness = await deployImplementation(Sk.alertingHarness, "AlertingHarness", deployer, [locatorAddress]);
  const alertingHarnessAddress = await alertingHarness.getAddress();
  console.log("AlertingHarness address", alertingHarnessAddress);
}
