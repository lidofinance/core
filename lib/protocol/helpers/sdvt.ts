import { expect } from "chai";
import { randomBytes } from "ethers";

import { ether, impersonate, log, streccak } from "lib";

import { ProtocolContext } from "../types";

import { getOperatorManagerAddress, getOperatorName, getOperatorRewardAddress } from "./nor";
import { depositAndReportValidators } from "./staking";

const SDVT_MODULE_ID = 2n;
const MIN_OPS_COUNT = 3n;
const MIN_OP_KEYS_COUNT = 10n;

const PUBKEY_LENGTH = 48n;
const SIGNATURE_LENGTH = 96n;

const MANAGE_SIGNING_KEYS_ROLE = streccak("MANAGE_SIGNING_KEYS");

export const sdvtEnsureOperators = async (
  ctx: ProtocolContext,
  minOperatorsCount = MIN_OPS_COUNT,
  minOperatorKeysCount = MIN_OP_KEYS_COUNT,
) => {
  const newOperatorsCount = await sdvtEnsureOperatorsHaveMinKeys(ctx, minOperatorsCount, minOperatorKeysCount);

  const { sdvt } = ctx.contracts;

  for (let operatorId = 0n; operatorId < minOperatorsCount; operatorId++) {
    const nodeOperatorBefore = await sdvt.getNodeOperator(operatorId, false);

    if (nodeOperatorBefore.totalVettedValidators < nodeOperatorBefore.totalAddedValidators) {
      await sdvtSetOperatorStakingLimit(ctx, {
        operatorId,
        limit: nodeOperatorBefore.totalAddedValidators,
      });
    }

    const nodeOperatorAfter = await sdvt.getNodeOperator(operatorId, false);

    expect(nodeOperatorAfter.totalVettedValidators).to.equal(nodeOperatorBefore.totalAddedValidators);
  }

  if (newOperatorsCount > 0) {
    await depositAndReportValidators(ctx, SDVT_MODULE_ID, newOperatorsCount);
  }
};

/**
 * Fills the Simple DVT operators with some keys to deposit in case there are not enough of them.
 */
const sdvtEnsureOperatorsHaveMinKeys = async (
  ctx: ProtocolContext,
  minOperatorsCount = MIN_OPS_COUNT,
  minKeysCount = MIN_OP_KEYS_COUNT,
): Promise<bigint> => {
  const newOperatorsCount = await sdvtEnsureMinOperators(ctx, minOperatorsCount);

  const { sdvt } = ctx.contracts;

  for (let operatorId = 0n; operatorId < minOperatorsCount; operatorId++) {
    const unusedKeysCount = await sdvt.getUnusedSigningKeyCount(operatorId);

    if (unusedKeysCount < minKeysCount) {
      log.debug(`Adding SDVT fake keys to operator ${operatorId}`, {
        "Unused keys count": unusedKeysCount,
        "Min keys count": minKeysCount,
      });

      await sdvtAddNodeOperatorKeys(ctx, {
        operatorId,
        keysToAdd: minKeysCount - unusedKeysCount,
      });
    }

    const unusedKeysCountAfter = await sdvt.getUnusedSigningKeyCount(operatorId);

    expect(unusedKeysCountAfter).to.be.gte(minKeysCount);
  }

  log.debug("Checked SDVT operators keys count", {
    "Min operators count": minOperatorsCount,
    "Min keys count": minKeysCount,
  });

  return newOperatorsCount;
};

/**
 * Fills the Simple DVT with some operators in case there are not enough of them.
 */
const sdvtEnsureMinOperators = async (ctx: ProtocolContext, minOperatorsCount = MIN_OPS_COUNT): Promise<bigint> => {
  const { sdvt } = ctx.contracts;

  const before = await sdvt.getNodeOperatorsCount();
  let count = 0n;

  while (before + count < minOperatorsCount) {
    const operatorId = before + count;

    const operator = {
      operatorId,
      name: getOperatorName("sdvt", operatorId),
      rewardAddress: getOperatorRewardAddress("sdvt", operatorId),
      managerAddress: getOperatorManagerAddress("sdvt", operatorId),
    };

    log.debug(`Adding SDVT fake operator ${operatorId}`, {
      "Operator ID": operatorId,
      "Name": operator.name,
      "Reward address": operator.rewardAddress,
      "Manager address": operator.managerAddress,
    });

    await sdvtAddNodeOperator(ctx, operator);
    count++;
  }

  const after = await sdvt.getNodeOperatorsCount();

  expect(after).to.equal(before + count);
  expect(after).to.be.gte(minOperatorsCount);

  log.debug("Checked SDVT operators count", {
    "Min operators count": minOperatorsCount,
    "Operators count": after,
  });

  return count;
};

/**
 * Adds a new node operator to the Simple DVT.
 */
const sdvtAddNodeOperator = async (
  ctx: ProtocolContext,
  params: {
    operatorId: bigint;
    name: string;
    rewardAddress: string;
    managerAddress: string;
  },
) => {
  const { sdvt, acl } = ctx.contracts;
  const { operatorId, name, rewardAddress, managerAddress } = params;

  const easyTrackExecutor = await ctx.getSigner("easyTrack");

  await sdvt.connect(easyTrackExecutor).addNodeOperator(name, rewardAddress);
  await acl.connect(easyTrackExecutor).grantPermissionP(
    managerAddress,
    sdvt.address,
    MANAGE_SIGNING_KEYS_ROLE,
    // See https://legacy-docs.aragon.org/developers/tools/aragonos/reference-aragonos-3#parameter-interpretation for details
    [1 << (240 + Number(operatorId))],
  );

  log.success(`Added fake SDVT operator ${operatorId}`);
};

/**
 * Adds some signing keys to the operator in the Simple DVT.
 */
const sdvtAddNodeOperatorKeys = async (
  ctx: ProtocolContext,
  params: {
    operatorId: bigint;
    keysToAdd: bigint;
  },
) => {
  const { sdvt } = ctx.contracts;
  const { operatorId, keysToAdd } = params;

  const totalKeysBefore = await sdvt.getTotalSigningKeyCount(operatorId);
  const unusedKeysBefore = await sdvt.getUnusedSigningKeyCount(operatorId);
  const { rewardAddress } = await sdvt.getNodeOperator(operatorId, false);

  const actor = await impersonate(rewardAddress, ether("100"));
  await sdvt
    .connect(actor)
    .addSigningKeys(
      operatorId,
      keysToAdd,
      randomBytes(Number(keysToAdd * PUBKEY_LENGTH)),
      randomBytes(Number(keysToAdd * SIGNATURE_LENGTH)),
    );

  const totalKeysAfter = await sdvt.getTotalSigningKeyCount(operatorId);
  const unusedKeysAfter = await sdvt.getUnusedSigningKeyCount(operatorId);

  expect(totalKeysAfter).to.equal(totalKeysBefore + keysToAdd);
  expect(unusedKeysAfter).to.equal(unusedKeysBefore + keysToAdd);

  log.success(`Added fake keys to SDVT operator ${operatorId}`);
};

/**
 * Sets the staking limit for the operator.
 */
const sdvtSetOperatorStakingLimit = async (
  ctx: ProtocolContext,
  params: {
    operatorId: bigint;
    limit: bigint;
  },
) => {
  const { sdvt } = ctx.contracts;
  const { operatorId, limit } = params;

  const easyTrackExecutor = await ctx.getSigner("easyTrack");
  await sdvt.connect(easyTrackExecutor).setNodeOperatorStakingLimit(operatorId, limit);

  log.success(`Set SDVT operator ${operatorId} staking limit`);
};
