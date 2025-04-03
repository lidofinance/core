import { BaseContract, BytesLike, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Delegation,
  OssifiableProxy,
  OssifiableProxy__factory,
  PinnedBeaconProxy,
  StakingVault,
  VaultFactory,
} from "typechain-types";
import { DelegationConfigStruct } from "typechain-types/contracts/0.8.25/vaults/VaultFactory";

import { ether, findEventsWithInterfaces, impersonate } from "lib";

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
  proxy: PinnedBeaconProxy;
  vault: StakingVault;
  delegation: Delegation;
}

export async function createVaultProxy(
  caller: HardhatEthersSigner,
  vaultFactory: VaultFactory,
  delegationParams: DelegationConfigStruct,
  stakingVaultInitializerExtraParams: BytesLike = "0x",
): Promise<CreateVaultResponse> {
  const tx = await vaultFactory
    .connect(caller)
    .createVaultWithDelegation(delegationParams, stakingVaultInitializerExtraParams);

  // Get the receipt manually
  const receipt = (await tx.wait())!;
  const events = findEventsWithInterfaces(receipt, "VaultCreated", [vaultFactory.interface]);

  if (events.length === 0) throw new Error("Vault creation event not found");

  const event = events[0];
  const { vault } = event.args;

  const delegationEvents = findEventsWithInterfaces(receipt, "DelegationCreated", [vaultFactory.interface]);

  if (delegationEvents.length === 0) throw new Error("Delegation creation event not found");

  const { delegation: delegationAddress } = delegationEvents[0].args;

  const proxy = (await ethers.getContractAt("PinnedBeaconProxy", vault, caller)) as PinnedBeaconProxy;
  const stakingVault = (await ethers.getContractAt("StakingVault", vault, caller)) as StakingVault;
  const delegation = (await ethers.getContractAt("Delegation", delegationAddress, caller)) as Delegation;

  //fund and lock
  const delegationSigner = await impersonate(await delegation.getAddress(), ether("100"));
  await stakingVault.connect(delegationSigner).fund({ value: ether("1") });
  await stakingVault.connect(delegationSigner).lock(ether("1"));

  return {
    tx,
    proxy,
    vault: stakingVault,
    delegation,
  };
}
