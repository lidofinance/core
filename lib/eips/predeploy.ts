import { ethers } from "hardhat";

import { log } from "lib";

/**
 * Idempotently make sure `expectedBytecode` lives at `address`, comparing
 * against whatever is already deployed there:
 *
 *  - nothing there yet (`0x`)  -> inject it via `hardhat_setCode` (fresh local nodes);
 *  - identical bytecode        -> nothing to do — e.g. the canonical predeploy that a
 *                                 live or forked chain already ships;
 *  - different bytecode        -> warn and leave it untouched, never overwrite.
 *
 * This is what keeps us from clobbering or re-injecting a predeploy on networks
 * that already have it: on such chains the code is present (and `hardhat_setCode`
 * is not even a valid RPC), so setCode is never called.
 */
export const ensurePredeployedBytecode = async (
  address: string,
  expectedBytecode: string,
  label: string,
): Promise<void> => {
  const existing = (await ethers.provider.getCode(address)).toLowerCase();
  const expected = expectedBytecode.toLowerCase();

  if (existing === expected) {
    return;
  }

  if (existing !== "0x") {
    log.warning(`${label}: unexpected bytecode already present at ${address}; leaving it untouched`);
    return;
  }

  log.warning(`${label} not found at ${address}; injecting it`);
  await ethers.provider.send("hardhat_setCode", [address, expectedBytecode]);
  log.success(`${label} is present`);
};
