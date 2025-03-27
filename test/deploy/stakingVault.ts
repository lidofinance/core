import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForStakingVault,
  StakingVault,
  StakingVault__factory,
  VaultFactory__MockForStakingVault,
  VaultHub__MockForStakingVault,
} from "typechain-types";

import { findEvents } from "lib";

type DeployedStakingVault = {
  depositContract: DepositContract__MockForStakingVault;
  stakingVault: StakingVault;
  stakingVaultImplementation: StakingVault;
  vaultHub: VaultHub__MockForStakingVault;
  vaultFactory: VaultFactory__MockForStakingVault;
};

export async function deployStakingVaultBehindBeaconProxy(
  vaultOwner: HardhatEthersSigner,
  operator: HardhatEthersSigner,
  depositor: HardhatEthersSigner,
): Promise<DeployedStakingVault> {
  // deploying implementation
  const vaultHub_ = await ethers.deployContract("VaultHub__MockForStakingVault");
  const depositContract_ = await ethers.deployContract("DepositContract__MockForStakingVault");
  const stakingVaultImplementation_ = await ethers.deployContract("StakingVault", [depositContract_]);

  // deploying factory/beacon
  const vaultFactory_ = await ethers.deployContract("VaultFactory__MockForStakingVault", [
    await stakingVaultImplementation_.getAddress(),
  ]);

  // deploying beacon proxy
  const vaultCreation = await vaultFactory_
    .createVault(await vaultOwner.getAddress(), await operator.getAddress(), vaultHub_, depositor)
    .then((tx) => tx.wait());
  if (!vaultCreation) throw new Error("Vault creation failed");
  const events = findEvents(vaultCreation, "VaultCreated");

  if (events.length != 1) throw new Error("There should be exactly one VaultCreated event");
  const vaultCreatedEvent = events[0];

  const stakingVault_ = StakingVault__factory.connect(vaultCreatedEvent.args.vault, vaultOwner);
  expect(await stakingVault_.owner()).to.equal(await vaultOwner.getAddress());
  expect(await stakingVault_.nodeOperator()).to.equal(await operator.getAddress());
  expect(await stakingVault_.depositor()).to.equal(await depositor.getAddress());

  return {
    depositContract: depositContract_,
    stakingVault: stakingVault_,
    stakingVaultImplementation: stakingVaultImplementation_,
    vaultHub: vaultHub_,
    vaultFactory: vaultFactory_,
  };
}
