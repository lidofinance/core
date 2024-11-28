import { BaseContract, BytesLike, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  BeaconProxy,
  OssifiableProxy,
  OssifiableProxy__factory,
  StakingVault,
  StVaultOwnerWithDelegation,
  VaultFactory,
} from "typechain-types";

import { findEventsWithInterfaces } from "lib";

import { IStVaultOwnerWithDelegation } from "../typechain-types/contracts/0.8.25/vaults/VaultFactory.sol/VaultFactory";
import StVaultOwnerWithDelegationInitializationParamsStruct = IStVaultOwnerWithDelegation.InitializationParamsStruct;

interface ProxifyArgs<T> {
  impl: T;
  admin: HardhatEthersSigner;
  caller?: HardhatEthersSigner;
  data?: BytesLike;
}

export async function proxify<T extends BaseContract>({
  impl,
  admin,
  caller = admin,
  data = new Uint8Array(),
}: ProxifyArgs<T>): Promise<[T, OssifiableProxy]> {
  const implAddress = await impl.getAddress();

  const proxy = await new OssifiableProxy__factory(admin).deploy(implAddress, admin.address, data);

  let proxied = impl.attach(await proxy.getAddress()) as T;
  proxied = proxied.connect(caller) as T;

  return [proxied, proxy];
}

interface CreateVaultResponse {
  tx: ContractTransactionResponse;
  proxy: BeaconProxy;
  vault: StakingVault;
  stVaultOwnerWithDelegation: StVaultOwnerWithDelegation;
}

export async function createVaultProxy(
  vaultFactory: VaultFactory,
  _owner: HardhatEthersSigner,
  _lidoAgent: HardhatEthersSigner,
): Promise<CreateVaultResponse> {
  // Define the parameters for the struct
  const initializationParams: StVaultOwnerWithDelegationInitializationParamsStruct = {
    managementFee: 100n,
    performanceFee: 200n,
    manager: await _owner.getAddress(),
    operator: await _owner.getAddress(),
  };

  const tx = await vaultFactory.connect(_owner).createVault("0x", initializationParams, _lidoAgent);

  // Get the receipt manually
  const receipt = (await tx.wait())!;
  const events = findEventsWithInterfaces(receipt, "VaultCreated", [vaultFactory.interface]);

  if (events.length === 0) throw new Error("Vault creation event not found");

  const event = events[0];
  const { vault } = event.args;

  const stVaultOwnerWithDelegationEvents = findEventsWithInterfaces(
    receipt,
    "StVaultOwnerWithDelegationCreated",
    [vaultFactory.interface],
  );

  if (stVaultOwnerWithDelegationEvents.length === 0) throw new Error("StVaultOwnerWithDelegation creation event not found");

  const { stVaultOwnerWithDelegation: stVaultOwnerWithDelegationAddress } = stVaultOwnerWithDelegationEvents[0].args;

  const proxy = (await ethers.getContractAt("BeaconProxy", vault, _owner)) as BeaconProxy;
  const stakingVault = (await ethers.getContractAt("StakingVault", vault, _owner)) as StakingVault;
  const stVaultOwnerWithDelegation = (await ethers.getContractAt(
    "StVaultOwnerWithDelegation",
    stVaultOwnerWithDelegationAddress,
    _owner,
  )) as StVaultOwnerWithDelegation;

  return {
    tx,
    proxy,
    vault: stakingVault,
    stVaultOwnerWithDelegation,
  };
}
