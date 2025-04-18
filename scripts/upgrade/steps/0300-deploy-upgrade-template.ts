import { ethers } from "hardhat";

import { OssifiableProxy__factory } from "typechain-types";

import { deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

import { readUpgradeParameters } from "../upgrade-utils";

export async function main() {
  const deployerSigner = await ethers.provider.getSigner();
  const deployer = deployerSigner.address;
  const state = readNetworkState();
  const parameters = readUpgradeParameters();

  const locator = OssifiableProxy__factory.connect(state[Sk.lidoLocator].proxy.address, deployerSigner);
  const oldLocatorImpl = await locator.proxy__getImplementation();

  const allowNonSingleBlockUpgrade = true;
  await deployWithoutProxy(Sk.upgradeTemplateV3, "UpgradeTemplateV3", deployer, [
    [
      // New non-proxy contracts
      state[Sk.stakingVaultFactory].address,

      // New fancy proxy contracts
      state[Sk.stakingVaultBeacon].address,
      state[Sk.stakingVaultImplementation].address,
      state[Sk.dashboardImpl].address,

      // Aragon Apps new implementations
      state[Sk.appLido].implementation.address,

      // New non-aragon implementations
      state[Sk.accountingOracle].implementation.address,
      state[Sk.lidoLocator].implementation.address,

      // Existing proxies and contracts
      oldLocatorImpl,
      state[Sk.appAgent].proxy.address,
      state[Sk.aragonLidoAppRepo].proxy.address,
      parameters["csm"].accounting,
      state[Sk.lidoLocator].proxy.address,
      state[Sk.appNodeOperatorsRegistry].proxy.address,
      state[Sk.appSimpleDvt].proxy.address,
      state[Sk.appVoting].proxy.address,
    ],
    allowNonSingleBlockUpgrade,
  ]);
}
