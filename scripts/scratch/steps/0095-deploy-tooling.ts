import { ethers } from "hardhat";

import { deployImplementation } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

// Tooling contracts are not part of the protocol, they only read protocol state via the locator.
// Deployed after the locator upgrade because VaultViewer resolves VaultHub and LazyOracle in its constructor.
export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const locatorAddress = state[Sk.lidoLocator].proxy.address;

  await deployImplementation(Sk.alertingHarness, "AlertingHarness", deployer, [locatorAddress]);
  await deployImplementation(Sk.vaultViewer, "VaultViewer", deployer, [locatorAddress]);
}
