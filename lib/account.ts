import { bigintToHex } from "bigint-conversion";
import { type Addressable } from "ethers";

import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import { randomAddress } from "./address.js";
import { ethers } from "./hardhat.js";
import { getNetworkName } from "./network.js";
import { ether } from "./units.js";

export async function getSignerOrImpersonate(
  address: string | Addressable,
  balance?: bigint,
): Promise<HardhatEthersSigner> {
  if (typeof address !== "string") {
    address = await address.getAddress();
  }

  const signers = await ethers.getSigners();
  const signer = signers.find((item) => item.address.toLowerCase() === address.toLowerCase());
  if (signer) {
    return signer;
  }

  try {
    return await impersonate(address, balance);
  } catch {
    throw new Error(`Can't get a signer or impersonation for ${address}.`);
  }
}

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

let cachedDeployerSigner: HardhatEthersSigner | undefined;
let cachedDeployerAddress: string | undefined;

export async function getDeployerSigner() {
  const deployer = process.env.DEPLOYER;
  if (!deployer) {
    throw new Error("Env variable DEPLOYER is not set");
  }

  const deployerAddress = ethers.getAddress(deployer);

  if (cachedDeployerSigner && cachedDeployerAddress === deployerAddress) {
    return cachedDeployerSigner;
  }

  const signer = await getSignerOrImpersonate(deployerAddress, ether("100"));
  cachedDeployerSigner = signer;
  cachedDeployerAddress = deployerAddress;

  return signer;
}
