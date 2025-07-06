import assert from "assert";
import { ethers } from "hardhat";

import { deployImplementation, readNetworkState, Sk } from "lib";

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;
  assert.equal(process.env.DEPLOYER, deployer);

  const state = readNetworkState();

  await deployImplementation(Sk.lazyOracle, "LazyOracle", deployer, [state[Sk.lidoLocator].proxy.address]);
}
