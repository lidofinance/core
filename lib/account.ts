import { bigintToHex } from "bigint-conversion";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { randomAddress } from "./address";
import { getNetworkName } from "./network";
import { ether } from "./units";

export async function impersonate(address: string, balance?: bigint): Promise<HardhatEthersSigner> {
  const networkName = await getNetworkName();

  await ethers.provider.send(`${networkName}_impersonateAccount`, [address]);

  if (balance) {
    await updateBalance(address, balance);
  }

  return ethers.getSigner(address);
}

export async function updateBalance(address: string, balance: bigint): Promise<void> {
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
