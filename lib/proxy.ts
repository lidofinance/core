import { BaseContract, BytesLike, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { BeaconProxy, OssifiableProxy, OssifiableProxy__factory, StakingVault, VaultFactory,VaultStaffRoom } from "typechain-types";

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

interface CreateVaultResponse {
  tx: ContractTransactionResponse,
  proxy: BeaconProxy,
  vault: StakingVault,
  vaultStaffRoom: VaultStaffRoom
}

export async function createVaultProxy(vaultFactory: VaultFactory, _owner: HardhatEthersSigner): Promise<CreateVaultResponse> {
  // Define the parameters for the struct
  const vaultStaffRoomParams = {
    managementFee: 100n,
    performanceFee: 200n,
    manager: await _owner.getAddress(),
    operator: await _owner.getAddress(),
  };

  const vaultStaffRoomParamsEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256", "address", "address"],
    [
      vaultStaffRoomParams.managementFee,
      vaultStaffRoomParams.performanceFee,
      vaultStaffRoomParams.manager,
      vaultStaffRoomParams.operator
    ]
  );

  const tx = await vaultFactory.connect(_owner).createVault("0x", vaultStaffRoomParamsEncoded);

  // Get the receipt manually
  const receipt = (await tx.wait())!;
  const events = findEventsWithInterfaces(receipt, "VaultCreated", [vaultFactory.interface]);

  if (events.length === 0) throw new Error("Vault creation event not found");

  const event = events[0];
  const { vault } = event.args;


  const vaultStaffRoomEvents = findEventsWithInterfaces(receipt, "VaultStaffRoomCreated", [vaultFactory.interface]);
  if (vaultStaffRoomEvents.length === 0) throw new Error("VaultStaffRoom creation event not found");

  const { vaultStaffRoom: vaultStaffRoomAddress } = vaultStaffRoomEvents[0].args;

  const proxy = (await ethers.getContractAt("BeaconProxy", vault, _owner)) as BeaconProxy;
  const stakingVault = (await ethers.getContractAt("StakingVault", vault, _owner)) as StakingVault;
  const vaultStaffRoom = (await ethers.getContractAt("VaultStaffRoom", vaultStaffRoomAddress, _owner)) as VaultStaffRoom;

  return {
    tx,
    proxy,
    vault: stakingVault,
    vaultStaffRoom: vaultStaffRoom,
  };
}
