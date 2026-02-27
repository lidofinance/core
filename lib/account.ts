import { bigintToHex } from "bigint-conversion";
import { type Addressable } from "ethers";

import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import { randomAddress } from "./address.js";
import { ethers } from "./hardhat.js";
import { getNetworkName } from "./network.js";
import { ether } from "./units.js";

export async function impersonate(address: string | Addressable, balance?: bigint): Promise<HardhatEthersSigner> {
  if (typeof address !== "string") {
    address = await address.getAddress();
  }

  const networkName = await getNetworkName();

  await ethers.provider.send(`${networkName}_impersonateAccount`, [address]);

  if (balance) {
    await updateBalance(address, balance);
  }

  return ethers.getSigner(address);
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
