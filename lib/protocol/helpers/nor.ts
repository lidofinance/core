import { expect } from "chai";
import { ethers, randomBytes } from "ethers";

import { certainAddress, log } from "lib";

import { ProtocolContext, StakingModuleName } from "../types";

import { depositAndReportValidators } from "./staking";

const NOR_MODULE_ID = 1n;
const MIN_OPS_COUNT = 3n;
const MIN_OP_KEYS_COUNT = 10n;

const PUBKEY_LENGTH = 48n;
const SIGNATURE_LENGTH = 96n;

export const norEnsureOperators = async (
  ctx: ProtocolContext,
  minOperatorsCount = MIN_OPS_COUNT,
  minOperatorKeysCount = MIN_OP_KEYS_COUNT,
) => {
  const { nor } = ctx.contracts;

  const newOperatorsCount = await norEnsureOperatorsHaveMinKeys(ctx, minOperatorsCount, minOperatorKeysCount);
  for (let operatorId = 0n; operatorId < minOperatorsCount; operatorId++) {
    const nodeOperatorBefore = await nor.getNodeOperator(operatorId, false);

    if (nodeOperatorBefore.totalVettedValidators < nodeOperatorBefore.totalAddedValidators) {
      await norSetOperatorStakingLimit(ctx, {
        operatorId,
        limit: nodeOperatorBefore.totalAddedValidators,
      });
    }

    const nodeOperatorAfter = await nor.getNodeOperator(operatorId, false);

    expect(nodeOperatorAfter.totalVettedValidators).to.equal(nodeOperatorBefore.totalAddedValidators);
  }

  log.debug("Checked NOR operators count", {
    "Min operators count": minOperatorsCount,
    "Min keys count": minOperatorKeysCount,
  });

  if (newOperatorsCount > 0) {
    await depositAndReportValidators(ctx, NOR_MODULE_ID, newOperatorsCount);
  }
};

/**
 * Fills the Nor operators with some keys to deposit in case there are not enough of them.
 */
const norEnsureOperatorsHaveMinKeys = async (
  ctx: ProtocolContext,
  minOperatorsCount = MIN_OPS_COUNT,
  minKeysCount = MIN_OP_KEYS_COUNT,
): Promise<bigint> => {
  const newOperatorsCount = await norEnsureMinOperators(ctx, minOperatorsCount);

  const { nor } = ctx.contracts;

  for (let operatorId = 0n; operatorId < minOperatorsCount; operatorId++) {
    const keysCount = await nor.getTotalSigningKeyCount(operatorId);

    if (keysCount < minKeysCount) {
      await norAddOperatorKeys(ctx, {
        operatorId,
        keysToAdd: minKeysCount - keysCount,
      });
    }

    const keysCountAfter = await nor.getTotalSigningKeyCount(operatorId);

    expect(keysCountAfter).to.be.gte(minKeysCount);
  }

  return newOperatorsCount;
};

/**
 * Fills the NOR with some operators in case there are not enough of them.
 */
const norEnsureMinOperators = async (ctx: ProtocolContext, minOperatorsCount = MIN_OPS_COUNT): Promise<bigint> => {
  const { nor } = ctx.contracts;

  const before = await nor.getNodeOperatorsCount();
  let count = 0n;

  while (before + count < minOperatorsCount) {
    const operatorId = before + count;

    const operator = {
      operatorId,
      name: getOperatorName("nor", operatorId),
      rewardAddress: getOperatorRewardAddress("nor", operatorId),
      managerAddress: getOperatorManagerAddress("nor", operatorId),
    };

    await norAddNodeOperator(ctx, operator);
    count++;
  }

  const after = await nor.getNodeOperatorsCount();

  expect(after).to.equal(before + count);
  expect(after).to.be.gte(minOperatorsCount);

  return count;
};

/**
 * Adds a new node operator to the NOR.
 */
export const norAddNodeOperator = async (
  ctx: ProtocolContext,
  params: {
    operatorId: bigint;
    name: string;
    rewardAddress: string;
    managerAddress: string;
  },
) => {
  const { nor } = ctx.contracts;
  const { operatorId, name, rewardAddress, managerAddress } = params;

  log.debug(`Adding fake NOR operator ${operatorId}`, {
    "Operator ID": operatorId,
    "Name": name,
    "Reward address": rewardAddress,
    "Manager address": managerAddress,
  });

  const agentSigner = await ctx.getSigner("agent");
  await nor.connect(agentSigner).addNodeOperator(name, rewardAddress);

  log.debug("Added NOR fake operator", {
    "Operator ID": operatorId,
    "Name": name,
    "Reward address": rewardAddress,
    "Manager address": managerAddress,
  });

  log.success(`Added fake NOR operator ${operatorId}`);
};

/**
 * Adds some signing keys to the operator in the NOR.
 */
export const norAddOperatorKeys = async (
  ctx: ProtocolContext,
  params: {
    operatorId: bigint;
    keysToAdd: bigint;
  },
) => {
  const { nor } = ctx.contracts;
  const { operatorId, keysToAdd } = params;

  log.debug(`Adding fake keys to NOR operator ${operatorId}`, {
    "Operator ID": operatorId,
    "Keys to add": keysToAdd,
  });

  const totalKeysBefore = await nor.getTotalSigningKeyCount(operatorId);
  const unusedKeysBefore = await nor.getUnusedSigningKeyCount(operatorId);

  const votingSigner = await ctx.getSigner("voting");

  await nor
    .connect(votingSigner)
    .addSigningKeys(
      operatorId,
      keysToAdd,
      randomBytes(Number(keysToAdd * PUBKEY_LENGTH)),
      randomBytes(Number(keysToAdd * SIGNATURE_LENGTH)),
    );

  const totalKeysAfter = await nor.getTotalSigningKeyCount(operatorId);
  const unusedKeysAfter = await nor.getUnusedSigningKeyCount(operatorId);

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

  log.success(`Added fake keys to NOR operator ${operatorId}`);
};

/**
 * Sets the staking limit for the operator.
 */
const norSetOperatorStakingLimit = async (
  ctx: ProtocolContext,
  params: {
    operatorId: bigint;
    limit: bigint;
  },
) => {
  const { nor } = ctx.contracts;
  const { operatorId, limit } = params;

  log.debug(`Setting NOR operator ${operatorId} staking limit`, {
    "Operator ID": operatorId,
    "Limit": ethers.formatEther(limit),
  });

  const votingSigner = await ctx.getSigner("voting");
  await nor.connect(votingSigner).setNodeOperatorStakingLimit(operatorId, limit);

  log.success(`Set NOR operator ${operatorId} staking limit`);
};

export const getOperatorName = (module: StakingModuleName, id: bigint, group: bigint = 0n) =>
  `${module}:op-${group}-${id}`;

export const getOperatorRewardAddress = (module: StakingModuleName, id: bigint, group: bigint = 0n) =>
  certainAddress(`${module}:op:ra-${group}-${id}`);

export const getOperatorManagerAddress = (module: StakingModuleName, id: bigint, group: bigint = 0n) =>
  certainAddress(`${module}:op:ma-${group}-${id}`);
