import { ethers } from "hardhat";

import { deployLidoLocatorImplementation, deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  // Extract necessary addresses and parameters from the state
  const locatorAddress = state[Sk.lidoLocator].proxy.address;

  const lazyOracleArgs = [locatorAddress];

  const lazyOracle = await deployWithoutProxy(Sk.lazyOracle, "LazyOracle", deployer, lazyOracleArgs);

  await deployLidoLocatorImplementation(locatorAddress, { lazyOracle: lazyOracle.address }, deployer);
}
