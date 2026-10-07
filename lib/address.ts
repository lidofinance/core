import { Wallet } from "ethers";

import { streccak } from "./keccak.js";

export function randomAddress() {
  return Wallet.createRandom().address;
}

export function certainAddress(seed: string) {
  const hashed = streccak(seed);
  const wallet = new Wallet(hashed);
  return wallet.address;
}
