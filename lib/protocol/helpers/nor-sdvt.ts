import { expect } from "chai";
import { CallExceptionError, ethers } from "ethers";

import { NodeOperatorsRegistry } from "typechain-types";

import { certainAddress, log } from "lib";
import { LoadedContract } from "lib/protocol/types";

import { ProtocolContext, StakingModuleName } from "../types";

import { depositAndReportValidators } from "./staking";
import { NOR_MODULE_ID, randomPubkeys, randomSignatures, SDVT_MODULE_ID } from "./staking-module";

const MIN_OPS_COUNT = 3n;
const MIN_OP_KEYS_COUNT = 10n;

async function isNor(module: LoadedContract<NodeOperatorsRegistry>, ctx: ProtocolContext) {
  return (await module.getAddress()) === ctx.contracts.nor.target;
}

export const norSdvtEnsureOperators = async (
  ctx: ProtocolContext,
  module: LoadedContract<NodeOperatorsRegistry>,
  minOperatorsCount = MIN_OPS_COUNT,
  minOperatorKeysCount = MIN_OP_KEYS_COUNT,
  numKeysPerNodeOperatorToDeposit = 1n,
) => {
  const { numBefore, numAdded } = await norSdvtEnsureOperatorsHaveMinKeys(
    ctx,
    module,
    minOperatorsCount,
    minOperatorKeysCount,
  );
  for (let operatorId = 0n; operatorId < minOperatorsCount; operatorId++) {
    const nodeOperatorBefore = await module.getNodeOperator(operatorId, false);

    if (nodeOperatorBefore.totalVettedValidators < nodeOperatorBefore.totalAddedValidators) {
      await norSdvtSetOperatorStakingLimit(ctx, module, {
        operatorId,
        limit: nodeOperatorBefore.totalAddedValidators,
      });
    }

    const nodeOperatorAfter = await module.getNodeOperator(operatorId, false);

    expect(nodeOperatorAfter.totalVettedValidators).to.equal(nodeOperatorBefore.totalAddedValidators);
  }

  log.debug("Checked NOR operators count", {
    "Min operators count": minOperatorsCount,
    "Min keys count": minOperatorKeysCount,
  });

  if (numAdded > 0) {
    const moduleId = (await isNor(module, ctx)) ? NOR_MODULE_ID : SDVT_MODULE_ID;
    await depositAndReportValidators(ctx, moduleId, numAdded * numKeysPerNodeOperatorToDeposit);
  }
  return { numBefore, numAdded };
};

/**
 * Fills the Nor operators with some keys to deposit in case there are not enough of them.
 */
const norSdvtEnsureOperatorsHaveMinKeys = async (
  ctx: ProtocolContext,
  module: LoadedContract<NodeOperatorsRegistry>,
  minOperatorsCount = MIN_OPS_COUNT,
  minKeysCount = MIN_OP_KEYS_COUNT,
): Promise<{ numBefore: bigint; numAdded: bigint }> => {
  const { numBefore, numAdded } = await norSdvtEnsureMinOperators(ctx, module, minOperatorsCount);

  for (let operatorId = 0n; operatorId < minOperatorsCount; operatorId++) {
    const keysCount = await module.getTotalSigningKeyCount(operatorId);

    if (keysCount < minKeysCount) {
      await norSdvtAddOperatorKeys(ctx, module, {
        operatorId,
        keysToAdd: minKeysCount - keysCount,
      });
    }

    const keysCountAfter = await module.getTotalSigningKeyCount(operatorId);

    expect(keysCountAfter).to.be.gte(minKeysCount);
  }

  return { numBefore, numAdded };
};

/**
 * Fills the NOR with some operators in case there are not enough of them.
 */
const norSdvtEnsureMinOperators = async (
  ctx: ProtocolContext,
  module: LoadedContract<NodeOperatorsRegistry>,
  minOperatorsCount = MIN_OPS_COUNT,
): Promise<{ numBefore: bigint; numAdded: bigint }> => {
  const numBefore = await module.getNodeOperatorsCount();
  let numAdded = 0n;

  while (numBefore + numAdded < minOperatorsCount) {
    const operatorId = numBefore + numAdded;

    const operator = {
      name: getOperatorName((await isNor(module, ctx)) ? "nor" : "sdvt", operatorId),
      rewardAddress: getOperatorRewardAddress((await isNor(module, ctx)) ? "nor" : "sdvt", operatorId),
    };

    await norSdvtAddNodeOperator(ctx, module, operator);
    numAdded++;
  }

  const after = await module.getNodeOperatorsCount();

  expect(after).to.equal(numBefore + numAdded);
  expect(after).to.be.gte(minOperatorsCount);

  return { numBefore, numAdded };
};

/**
 * Adds a new node operator to the NOR.
 */
export const norSdvtAddNodeOperator = async (
  ctx: ProtocolContext,
  module: LoadedContract<NodeOperatorsRegistry>,
  params: {
    name: string;
    rewardAddress: string;
  },
) => {
  const { name, rewardAddress } = params;

  log.debug(`Adding fake NOR operator`, {
    "Name": name,
    "Reward address": rewardAddress,
  });

  const operatorId = await module.getNodeOperatorsCount();

  const managerSigner = (await isNor(module, ctx)) ? await ctx.getSigner("agent") : await ctx.getSigner("voting");
  await module.connect(managerSigner).addNodeOperator(name, rewardAddress);

  log.debug("Added NOR fake operator", {
    "Operator ID": operatorId,
    "Name": name,
    "Reward address": rewardAddress,
  });

  return operatorId;
};

/**
 * Adds some signing keys to the operator in the NOR.
 */
export const norSdvtAddOperatorKeys = async (
  ctx: ProtocolContext,
  module: LoadedContract<NodeOperatorsRegistry>,
  params: {
    operatorId: bigint;
    keysToAdd: bigint;
  },
) => {
  const { operatorId, keysToAdd } = params;

  log.debug(`Adding fake keys to NOR operator ${operatorId}`, {
    "Operator ID": operatorId,
    "Keys to add": keysToAdd,
  });

  const totalKeysBefore = await module.getTotalSigningKeyCount(operatorId);
  const unusedKeysBefore = await module.getUnusedSigningKeyCount(operatorId);

  const votingSigner = await ctx.getSigner("voting");
  await module
    .connect(votingSigner)
    .addSigningKeys(operatorId, keysToAdd, randomPubkeys(Number(keysToAdd)), randomSignatures(Number(keysToAdd)));

  const totalKeysAfter = await module.getTotalSigningKeyCount(operatorId);
  const unusedKeysAfter = await module.getUnusedSigningKeyCount(operatorId);

  expect(totalKeysAfter).to.equal(totalKeysBefore + keysToAdd);
  expect(unusedKeysAfter).to.equal(unusedKeysBefore + keysToAdd);

  log.debug("Added NOR fake signing keys", {
    "Operator ID": operatorId,
    "Keys to add": keysToAdd,
    "Total keys before": totalKeysBefore,
    "Total keys after": totalKeysAfter,
    "Unused keys before": unusedKeysBefore,
    "Unused keys after": unusedKeysAfter,
  });
};

/**
 * Sets the staking limit for the operator.
 */
export const norSdvtSetOperatorStakingLimit = async (
  ctx: ProtocolContext,
  module: LoadedContract<NodeOperatorsRegistry>,
  params: {
    operatorId: bigint;
    limit: bigint;
  },
) => {
  const { operatorId, limit } = params;

  log.debug(`Setting NOR operator ${operatorId} staking limit`, {
    "Operator ID": operatorId,
    "Limit": ethers.formatEther(limit),
  });

  try {
    // For SDVT scratch deployment and for NOR
    const votingSigner = await ctx.getSigner("voting");
    await module.connect(votingSigner).setNodeOperatorStakingLimit(operatorId, limit);
  } catch (error: unknown) {
    if ((error as CallExceptionError).message.includes("APP_AUTH_FAILED")) {
      const easyTrackSigner = await ctx.getSigner("easyTrack");
      await module.connect(easyTrackSigner).setNodeOperatorStakingLimit(operatorId, limit);
    } else {
      throw error;
    }
  }
};

export const getOperatorName = (module: StakingModuleName, id: bigint, group: bigint = 0n) =>
  `${module}:op-${group}-${id}`;

export const getOperatorRewardAddress = (module: StakingModuleName, id: bigint, group: bigint = 0n) =>
  certainAddress(`${module}:op:ra-${group}-${id}`);

export const getOperatorManagerAddress = (module: StakingModuleName, id: bigint, group: bigint = 0n) =>
  certainAddress(`${module}:op:ma-${group}-${id}`);
