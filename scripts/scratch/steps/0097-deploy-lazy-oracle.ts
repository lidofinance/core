import { ethers } from "hardhat";

import { deployLidoLocatorImplementation, deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  // Extract necessary addresses and parameters from the state
  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const consensusContract = state[Sk.hashConsensusForAccountingOracle].address;
  const lazyOracleParams = state[Sk.lazyOracle].deployParameters;

  // Deploy OracleReportSanityChecker
  const lazyOracleArgs = [locatorAddress, consensusContract, deployer, lazyOracleParams.quarantinePeriod, lazyOracleParams.maxElClRewardsBP];

  const lazyOracle = await deployWithoutProxy(Sk.lazyOracle, "LazyOracle", deployer, lazyOracleArgs);

  await deployLidoLocatorImplementation(locatorAddress, { lazyOracle: lazyOracle.address }, deployer);
}
