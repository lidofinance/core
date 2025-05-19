import { keccak256 } from "ethers";
import { ethers } from "hardhat";

import { VaultHub } from "typechain-types";

import { loadContract, makeTx } from "lib";
import { deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const stethAddress = state[Sk.appLido].proxy.address;
  const wstethAddress = state[Sk.wstETH].address;
  const vaultHubAddress = state[Sk.vaultHub].proxy.address;
  const locatorAddress = state[Sk.lidoLocator].proxy.address;

  const depositContract = state.chainSpec.depositContract;

  // Deploy StakingVault implementation contract
  const imp = await deployWithoutProxy(Sk.stakingVaultImpl, "StakingVault", deployer, [
    depositContract,
  ]);
  const impAddress = await imp.getAddress();

  // Deploy Dashboard implementation contract
  const dashboard = await deployWithoutProxy(Sk.dashboardImpl, "Dashboard", deployer, [
    stethAddress,
    wstethAddress,
    vaultHubAddress,
    locatorAddress,
  ]);
  const dashboardAddress = await dashboard.getAddress();

  const beacon = await deployWithoutProxy(Sk.stakingVaultBeacon, "UpgradeableBeacon", deployer, [impAddress, deployer]);
  const beaconAddress = await beacon.getAddress();

  // Deploy BeaconProxy to get bytecode and add it to whitelist
  const vaultBeaconProxy = await ethers.deployContract("PinnedBeaconProxy", [beaconAddress, "0x"]);
  await vaultBeaconProxy.waitForDeployment();

  const vaultBeaconProxyCode = await ethers.provider.getCode(await vaultBeaconProxy.getAddress());
  const vaultBeaconProxyCodeHash = keccak256(vaultBeaconProxyCode);

  console.log("BeaconProxy address", await vaultBeaconProxy.getAddress());

  // Deploy VaultFactory contract
  const factory = await deployWithoutProxy(Sk.stakingVaultFactory, "VaultFactory", deployer, [
    locatorAddress,
    beaconAddress,
    dashboardAddress,
  ]);
  console.log("Factory address", await factory.getAddress());

  // Add VaultFactory and Vault implementation to the Accounting contract
  const vaultHub = await loadContract<VaultHub>("VaultHub", vaultHubAddress);

  // Grant roles for the Accounting contract
  const vaultMasterRole = await vaultHub.VAULT_MASTER_ROLE();
  const vaultRegistryRole = await vaultHub.VAULT_REGISTRY_ROLE();

  await makeTx(vaultHub, "grantRole", [vaultMasterRole, deployer], { from: deployer });
  await makeTx(vaultHub, "grantRole", [vaultRegistryRole, deployer], { from: deployer });

  await makeTx(vaultHub, "setAllowedCodehash", [vaultBeaconProxyCodeHash, true], { from: deployer });

  await makeTx(vaultHub, "renounceRole", [vaultMasterRole, deployer], { from: deployer });
  await makeTx(vaultHub, "renounceRole", [vaultRegistryRole, deployer], { from: deployer });
}
