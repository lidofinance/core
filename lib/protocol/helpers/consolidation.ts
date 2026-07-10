import { ethers } from "hardhat";

import { ConsolidationBus } from "typechain-types";

import { advanceChainTime, getCurrentBlockTimestamp } from "lib";

export interface ConsolidationPubkeyGroup {
  sourcePubkeys: string[];
  targetPubkey: string;
}

/**
 * Compute the batch hash exactly as ConsolidationBus does:
 * keccak256(abi.encode(ConsolidationGroup[])).
 */
export const calcConsolidationBatchHash = (groups: ConsolidationPubkeyGroup[]) =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"], [groups]),
  );

/**
 * Advance chain time until a pending batch passes the ConsolidationBus execution delay.
 *
 * Real deployments use a non-zero delay (86400s on Hoodi/mainnet), so executing right
 * after submission reverts with ExecutionDelayNotPassed. The delay is read from the
 * contract and the batch's own addedAt timestamp; the delay itself is never modified.
 */
export const waitUntilBatchExecutable = async (consolidationBus: ConsolidationBus, batchHash: string) => {
  const batchInfo = await consolidationBus.getBatchInfo(batchHash);
  if (batchInfo.publisher === ethers.ZeroAddress) {
    throw new Error(`Batch ${batchHash} is not pending in ConsolidationBus`);
  }

  const executeAfter = batchInfo.addedAt + (await consolidationBus.executionDelay());
  const now = await getCurrentBlockTimestamp();
  if (now < executeAfter) {
    await advanceChainTime(executeAfter - now);
  }
};
