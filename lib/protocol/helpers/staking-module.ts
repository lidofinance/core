import { randomBytes } from "ethers";

import { IStakingModule } from "typechain-types";

import { LoadedContract } from "lib";

export const NOR_MODULE_ID = 1n;
export const SDVT_MODULE_ID = 2n;
export const CSM_MODULE_ID = 3n;

const PUBKEY_LENGTH = 48n;
const SIGNATURE_LENGTH = 96n;

export async function calcNodeOperatorRewards(
  module: LoadedContract<IStakingModule>,
  nodeOperatorId: bigint,
  mintedShares: bigint,
): Promise<bigint> {
  const operatorSummary = await module.getNodeOperatorSummary(nodeOperatorId);
  const moduleSummary = await module.getStakingModuleSummary();

  const operatorTotalActiveKeys = operatorSummary.totalDepositedValidators - operatorSummary.totalExitedValidators;
  const moduleTotalActiveKeys = moduleSummary.totalDepositedValidators - moduleSummary.totalExitedValidators;

  return (mintedShares * BigInt(operatorTotalActiveKeys)) / BigInt(moduleTotalActiveKeys);
}

/**
 * Generates an array of random pubkeys in the correct format for NOR
 */
export const randomPubkeys = (count: number) => {
  return randomBytes(count * Number(PUBKEY_LENGTH));
};

/**
 * Generates an array of random signatures in the correct format for NOR
 */
export const randomSignatures = (count: number) => {
  return randomBytes(count * Number(SIGNATURE_LENGTH));
};
