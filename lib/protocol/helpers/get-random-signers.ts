import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { impersonate, randomAddress } from "lib";
import { ether } from "lib/units";

export async function getRandomSigners(amount: number): Promise<HardhatEthersSigner[]> {
  const signers = [];
  for (let i = 0; i < amount; i++) {
    signers.push(await impersonate(randomAddress(), ether("10000")));
  }
  return signers;
}
