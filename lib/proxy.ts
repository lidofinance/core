import { BaseContract, BytesLike, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  BeaconProxy,
  Delegation,
  OssifiableProxy,
  OssifiableProxy__factory,
  StakingVault,
  VaultFactory,
} from "typechain-types";

import { findEventsWithInterfaces } from "lib";

import { IDelegation } from "../typechain-types/contracts/0.8.25/vaults/VaultFactory.sol/VaultFactory";
import DelegationInitializationParamsStruct = IDelegation.InitializationParamsStruct;

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
  delegation: Delegation;
}

export async function createVaultProxy(
  vaultFactory: VaultFactory,
  _owner: HardhatEthersSigner,
  _lidoAgent: HardhatEthersSigner,
): Promise<CreateVaultResponse> {
  // Define the parameters for the struct
  const initializationParams: DelegationInitializationParamsStruct = {
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

  const delegationEvents = findEventsWithInterfaces(receipt, "DelegationCreated", [vaultFactory.interface]);

  if (delegationEvents.length === 0) throw new Error("Delegation creation event not found");

  const { delegation: delegationAddress } = delegationEvents[0].args;

  const proxy = (await ethers.getContractAt("BeaconProxy", vault, _owner)) as BeaconProxy;
  const stakingVault = (await ethers.getContractAt("StakingVault", vault, _owner)) as StakingVault;
  const delegation = (await ethers.getContractAt("Delegation", delegationAddress, _owner)) as Delegation;

  return {
    tx,
    proxy,
    vault: stakingVault,
    delegation,
  };
}
