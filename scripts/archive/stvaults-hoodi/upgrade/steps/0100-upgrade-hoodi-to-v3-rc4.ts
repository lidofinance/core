import assert from "assert";
import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { deployImplementation, readNetworkState, Sk } from "lib";

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;
  assert.equal(process.env.DEPLOYER, deployer);

  const parameters = readUpgradeParameters();
  const state = readNetworkState();

  //
  // Extract necessary addresses and parameters from the state
  //
  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const lidoAddress = state[Sk.appLido].proxy.address;
  const hashConsensusAddress = state[Sk.hashConsensusForAccountingOracle].address;

  const vaultHubParams = parameters.vaultHub;

  //
  // New Lido implementation
  //
  await deployImplementation(Sk.appLido, "Lido", deployer);
  const newLidoImplAddress = state[Sk.appLido].implementation.address;
  console.log("New Lido implementation address", newLidoImplAddress);

  //
  // New LazyOracle implementation
  //
  await deployImplementation(Sk.lazyOracle, "LazyOracle", deployer, [locatorAddress]);
  const newLazyOracleImplAddress = state[Sk.lazyOracle].implementation.address;
  console.log("New LazyOracle implementation address", newLazyOracleImplAddress);

  //
  // New OperatorGrid implementation
  //
  await deployImplementation(Sk.operatorGrid, "OperatorGrid", deployer, [locatorAddress]);
  const newOperatorGridImplAddress = state[Sk.operatorGrid].implementation.address;
  console.log("New OperatorGrid implementation address", newOperatorGridImplAddress);

  //
  // New VaultHub implementation
  //
  await deployImplementation(Sk.vaultHub, "VaultHub", deployer, [
    locatorAddress,
    lidoAddress,
    hashConsensusAddress,
    vaultHubParams.relativeShareLimitBP,
  ]);
  const newVaultHubAddress = state[Sk.vaultHub].implementation.address;
  console.log("New VaultHub implementation address", newVaultHubAddress);

  //
  // New Accounting implementation
  //
  await deployImplementation(Sk.accounting, "Accounting", deployer, [locatorAddress, lidoAddress]);
  const newAccountingImplAddress = state[Sk.accounting].implementation.address;
  console.log("New Accounting implementation address", newAccountingImplAddress);
}
