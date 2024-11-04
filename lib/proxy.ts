import { BaseContract, BytesLike } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { BeaconProxy, DelegatorAlligator,OssifiableProxy, OssifiableProxy__factory, StakingVault, VaultFactory } from "typechain-types";

import { findEventsWithInterfaces } from "lib";

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
  const implAddres = await impl.getAddress();

  const proxy = await new OssifiableProxy__factory(admin).deploy(implAddres, admin.address, data);

  let proxied = impl.attach(await proxy.getAddress()) as T;
  proxied = proxied.connect(caller) as T;

  return [proxied, proxy];
}

export async function createVaultProxy(vaultFactory: VaultFactory, _owner: HardhatEthersSigner): Promise<{ proxy: BeaconProxy; vault: StakingVault; delegator: DelegatorAlligator }> {
  const tx = await vaultFactory.connect(_owner).createVault("0x");

  // Get the receipt manually
  const receipt = (await tx.wait())!;
  const events = findEventsWithInterfaces(receipt, "VaultCreated", [vaultFactory.interface]);

  if (events.length === 0) throw new Error("Vault creation event not found");

  const event = events[0];
  const { vault } = event.args;

  const delegatorEvents = findEventsWithInterfaces(receipt, "DelegatorCreated", [vaultFactory.interface]);
  if (delegatorEvents.length === 0) throw new Error("Delegator creation event not found");

  const { delegator } = delegatorEvents[0].args;

  const proxy = (await ethers.getContractAt("BeaconProxy", vault, _owner)) as BeaconProxy;
  const stakingVault = (await ethers.getContractAt("StakingVault", vault, _owner)) as StakingVault;
  const delegatorAlligator = (await ethers.getContractAt("DelegatorAlligator", delegator, _owner)) as DelegatorAlligator;

  return {
    proxy,
    vault: stakingVault,
    delegator: delegatorAlligator,
  };
}
