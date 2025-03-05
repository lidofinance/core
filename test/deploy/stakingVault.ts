import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForStakingVault,
  EIP7002WithdrawalRequest_Mock,
  StakingVault,
  StakingVault__factory,
  VaultFactory__MockForStakingVault,
  VaultHub__MockForStakingVault,
} from "typechain-types";

import { findEvents } from "lib";

import { EIP7002_PREDEPLOYED_ADDRESS } from "test/suite";

type DeployedStakingVault = {
  depositContract: DepositContract__MockForStakingVault;
  stakingVault: StakingVault;
  stakingVaultImplementation: StakingVault;
  vaultHub: VaultHub__MockForStakingVault;
  vaultFactory: VaultFactory__MockForStakingVault;
};

export async function deployWithdrawalsPreDeployedMock(
  defaultRequestFee: bigint,
): Promise<EIP7002WithdrawalRequest_Mock> {
  const mock = await ethers.deployContract("EIP7002WithdrawalRequest_Mock");
  const mockAddress = await mock.getAddress();
  const mockCode = await ethers.provider.getCode(mockAddress);

  await ethers.provider.send("hardhat_setCode", [EIP7002_PREDEPLOYED_ADDRESS, mockCode]);

  const contract = await ethers.getContractAt("EIP7002WithdrawalRequest_Mock", EIP7002_PREDEPLOYED_ADDRESS);

  await contract.setFee(defaultRequestFee);

  return contract;
}

export async function deployStakingVaultBehindBeaconProxy(
  vaultOwner: HardhatEthersSigner,
  operator: HardhatEthersSigner,
  depositor: HardhatEthersSigner,
): Promise<DeployedStakingVault> {
  // deploying implementation
  const vaultHub_ = await ethers.deployContract("VaultHub__MockForStakingVault");
  const depositContract_ = await ethers.deployContract("DepositContract__MockForStakingVault");
  const stakingVaultImplementation_ = await ethers.deployContract("StakingVault", [
    await vaultHub_.getAddress(),
    await depositContract_.getAddress(),
  ]);

  // deploying factory/beacon
  const vaultFactory_ = await ethers.deployContract("VaultFactory__MockForStakingVault", [
    await stakingVaultImplementation_.getAddress(),
  ]);

  // deploying beacon proxy
  const vaultCreation = await vaultFactory_
    .createVault(await vaultOwner.getAddress(), await operator.getAddress())
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
