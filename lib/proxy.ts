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
import DelegationInitializationParamsStruct = IDelegation.InitialStateStruct;

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
  _admin: HardhatEthersSigner,
  _owner: HardhatEthersSigner,
  _operator: HardhatEthersSigner,
  initializationParams: Partial<DelegationInitializationParamsStruct> = {},
): Promise<CreateVaultResponse> {
  // Define the parameters for the struct
  const defaultParams: DelegationInitializationParamsStruct = {
    defaultAdmin: await _admin.getAddress(),
    curatorFee: 100n,
    operatorFee: 200n,
    curator: await _owner.getAddress(),
    staker: await _owner.getAddress(),
    tokenMaster: await _owner.getAddress(),
    operator: await _operator.getAddress(),
    claimOperatorDueRole: await _owner.getAddress(),
  };
  const params = { ...defaultParams, ...initializationParams };

  const tx = await vaultFactory.connect(_owner).createVaultWithDelegation(params, "0x");

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
