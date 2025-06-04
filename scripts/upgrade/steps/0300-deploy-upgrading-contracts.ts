import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { IAragonAppRepo, IOssifiableProxy, OssifiableProxy__factory } from "typechain-types";

import { loadContract } from "lib/contract";
import { deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployerSigner = await ethers.provider.getSigner();
  const deployer = deployerSigner.address;
  const state = readNetworkState();
  const parameters = readUpgradeParameters();

  const locator = OssifiableProxy__factory.connect(state[Sk.lidoLocator].proxy.address, deployerSigner);
  const oldLocatorImplementation = await locator.proxy__getImplementation();
  const accountingOracle = await loadContract<IOssifiableProxy>(
    "IOssifiableProxy",
    state[Sk.accountingOracle].proxy.address,
  );
  const lidoRepo = await loadContract<IAragonAppRepo>("IAragonAppRepo", state[Sk.aragonLidoAppRepo].proxy.address);
  const [, lidoImplementation] = await lidoRepo.getLatest();

  const addressesParams = [
    // Old implementations
    oldLocatorImplementation,
    lidoImplementation,
    await accountingOracle.proxy__getImplementation(),

    // New implementations
    state[Sk.lidoLocator].implementation.address,
    state[Sk.appLido].implementation.address,
    state[Sk.accountingOracle].implementation.address,

    // New non-proxy contracts
    state[Sk.stakingVaultFactory].address,

    // New fancy proxy and blueprint contracts
    state[Sk.stakingVaultBeacon].address,
    state[Sk.stakingVaultImplementation].address,
    state[Sk.dashboardImpl].address,

    // Existing proxies and contracts
    state[Sk.aragonKernel].proxy.address,
    state[Sk.appAgent].proxy.address,
    state[Sk.aragonLidoAppRepo].proxy.address,
    state[Sk.lidoLocator].proxy.address,
    state[Sk.appVoting].proxy.address,
  ];

  const template = await deployWithoutProxy(Sk.v3Template, "V3Template", deployer, [addressesParams]);

  await deployWithoutProxy(Sk.v3VoteScript, "V3VoteScript", deployer, [
    [template.address, parameters[Sk.appLido].newVersion, state[Sk.appLido].aragonApp.id],
  ]);
}
