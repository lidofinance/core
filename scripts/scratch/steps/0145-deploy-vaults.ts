import { ethers } from "hardhat";

import { Accounting } from "typechain-types";

import { loadContract, makeTx } from "lib";
import { deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const accountingAddress = state[Sk.accounting].proxy.address;
  const lidoAddress = state[Sk.appLido].proxy.address;

  const depositContract = state.chainSpec.depositContract;

  // Deploy StakingVault implementation contract
  const imp = await deployWithoutProxy(Sk.stakingVaultImpl, "StakingVault", deployer, [
    accountingAddress,
    depositContract,
  ]);
  const impAddress = await imp.getAddress();

  // Deploy Delegation implementation contract
  const room = await deployWithoutProxy(Sk.delegationImpl, "Delegation", deployer, [lidoAddress]);
  const roomAddress = await room.getAddress();

  // Deploy VaultFactory contract
  const factory = await deployWithoutProxy(Sk.stakingVaultFactory, "VaultFactory", deployer, [
    deployer,
    impAddress,
    roomAddress,
  ]);
  const factoryAddress = await factory.getAddress();

  // Add VaultFactory and Vault implementation to the Accounting contract
  const accounting = await loadContract<Accounting>("Accounting", accountingAddress);

  // Grant roles for the Accounting contract
  const vaultMasterRole = await accounting.VAULT_MASTER_ROLE();
  const vaultRegistryRole = await accounting.VAULT_REGISTRY_ROLE();

  await makeTx(accounting, "grantRole", [vaultMasterRole, deployer], { from: deployer });
  await makeTx(accounting, "grantRole", [vaultRegistryRole, deployer], { from: deployer });

  await makeTx(accounting, "addFactory", [factoryAddress], { from: deployer });
  await makeTx(accounting, "addImpl", [impAddress], { from: deployer });

  await makeTx(accounting, "renounceRole", [vaultMasterRole, deployer], { from: deployer });
  await makeTx(accounting, "renounceRole", [vaultRegistryRole, deployer], { from: deployer });
}