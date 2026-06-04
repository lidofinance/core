import { bigintToHex } from "bigint-conversion";
import { Addressable } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { randomAddress } from "./address";
import { getNetworkName } from "./network";
import { ether } from "./units";

export async function impersonate(address: string | Addressable, balance?: bigint): Promise<HardhatEthersSigner> {
  if (typeof address !== "string") {
    address = await address.getAddress();
  }

  const networkName = await getNetworkName();

  await ethers.provider.send(`${networkName}_impersonateAccount`, [address]);

  if (balance) {
    await updateBalance(address, balance);
  }

  const signer = await ethers.getSigner(address);

  // Against an external node (e.g. anvil via `--network local`), eth_sendTransaction
  // can return before the transaction is mined, so the many read-after-write
  // sequences in the protocol provisioning helpers race the miner and observe stale
  // state. Make impersonated signers await their receipt so those helpers behave
  // deterministically, matching the synchronous in-process hardhat network.
  if (networkName !== "hardhat") {
    const sendTransaction = signer.sendTransaction.bind(signer);
    signer.sendTransaction = async (tx) => {
      const response = await sendTransaction(tx);
      await response.wait();
      return response;
    };
  }

  return signer;
}

export async function updateBalance(address: string | Addressable, balance: bigint): Promise<void> {
  if (typeof address !== "string") {
    address = await address.getAddress();
  }

  const networkName = await getNetworkName();

  await ethers.provider.send(`${networkName}_setBalance`, [address, "0x" + bigintToHex(balance)]);
}

export async function getRandomSigners(amount: number): Promise<HardhatEthersSigner[]> {
  const signers = [];
  for (let i = 0; i < amount; i++) {
    signers.push(await impersonate(randomAddress(), ether("10000")));
  }
  return signers;
}
