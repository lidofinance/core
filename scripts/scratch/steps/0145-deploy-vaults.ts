import { ethers } from "hardhat";

import { Accounting } from "typechain-types";

import { loadContract, makeTx } from "lib";
import { deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const agentAddress = state[Sk.appAgent].proxy.address;
  const accountingAddress = state[Sk.accounting].address;
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
  await makeTx(accounting, "addFactory", [factoryAddress], { from: deployer });
  await makeTx(accounting, "addImpl", [impAddress], { from: deployer });

  // Grant roles for the Accounting contract
  const role = await accounting.VAULT_MASTER_ROLE();
  await makeTx(accounting, "grantRole", [role, agentAddress], { from: deployer });
  await makeTx(accounting, "renounceRole", [role, deployer], { from: deployer });
}
