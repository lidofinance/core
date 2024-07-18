import { expect } from "chai";
import { randomBytes } from "ethers";

import { certainAddress, impersonate, log, streccak, trace } from "lib";

import { ether } from "../../units";
import { ProtocolContext } from "../types";

const MIN_OPS_COUNT = 3n;
const MIN_OP_KEYS_COUNT = 10n;

const PUBKEY_LENGTH = 48n;
const SIGNATURE_LENGTH = 96n;

const MANAGE_SIGNING_KEYS_ROLE = streccak("MANAGE_SIGNING_KEYS");

export const ensureSDVTOperators = async (
  ctx: ProtocolContext,
  minOperatorsCount = MIN_OPS_COUNT,
  minOperatorKeysCount = MIN_OP_KEYS_COUNT,
) => {
  await ensureSDVTOperatorsHaveMinKeys(ctx, minOperatorsCount, minOperatorKeysCount);

  const { sdvt } = ctx.contracts;

  for (let operatorId = 0n; operatorId < minOperatorsCount; operatorId++) {
    const nodeOperatorBefore = await sdvt.getNodeOperator(operatorId, false);

    if (nodeOperatorBefore.totalVettedValidators < nodeOperatorBefore.totalAddedValidators) {
      await setSDVTOperatorStakingLimit(ctx, {
        operatorId,
        limit: nodeOperatorBefore.totalAddedValidators,
      });
    }

    const nodeOperatorAfter = await sdvt.getNodeOperator(operatorId, false);

    expect(nodeOperatorAfter.totalVettedValidators).to.be.equal(nodeOperatorBefore.totalAddedValidators);
  }
};

/**
 * Fills the Simple DVT operators with some keys to deposit in case there are not enough of them.
 */
const ensureSDVTOperatorsHaveMinKeys = async (
  ctx: ProtocolContext,
  minOperatorsCount = MIN_OPS_COUNT,
  minKeysCount = MIN_OP_KEYS_COUNT,
) => {
  await ensureSDVTMinOperators(ctx, minOperatorsCount);

  const { sdvt } = ctx.contracts;

  for (let operatorId = 0n; operatorId < minOperatorsCount; operatorId++) {
    const unusedKeysCount = await sdvt.getUnusedSigningKeyCount(operatorId);

    if (unusedKeysCount < minKeysCount) {
      log.warning(`Adding fake keys to operator ${operatorId}`);

      await addFakeNodeOperatorKeysToSDVT(ctx, {
        operatorId,
        keysToAdd: minKeysCount - unusedKeysCount,
      });
    }

    const unusedKeysCountAfter = await sdvt.getUnusedSigningKeyCount(operatorId);

    expect(unusedKeysCountAfter).to.be.gte(minKeysCount);
  }

  log.debug("Checked operators keys count", {
    "Min operators count": minOperatorsCount,
    "Min keys count": minKeysCount,
  });
};

/**
 * Fills the Simple DVT with some operators in case there are not enough of them.
 */
const ensureSDVTMinOperators = async (ctx: ProtocolContext, minOperatorsCount = MIN_OPS_COUNT) => {
  const { sdvt } = ctx.contracts;

  const before = await sdvt.getNodeOperatorsCount();
  let count = 0n;

  while (before + count < minOperatorsCount) {
    const operatorId = before + count;

    const operator = {
      operatorId,
      name: getOperatorName(operatorId),
      rewardAddress: getOperatorRewardAddress(operatorId),
      managerAddress: getOperatorManagerAddress(operatorId),
    };

    log.warning(`Adding fake operator ${operatorId}`);

    await addFakeNodeOperatorToSDVT(ctx, operator);
    count++;
  }

  const after = await sdvt.getNodeOperatorsCount();

  expect(after).to.be.equal(before + count);
  expect(after).to.be.gte(minOperatorsCount);

  log.debug("Checked operators count", {
    "Min operators count": minOperatorsCount,
    "Operators count": after,
  });
};

/**
 * Adds a new node operator to the Simple DVT.
 */
export const addFakeNodeOperatorToSDVT = async (
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

  const addTx = await sdvt.connect(easyTrackExecutor).addNodeOperator(name, rewardAddress);
  await trace("simpleDVT.addNodeOperator", addTx);

  const grantPermissionTx = await acl.connect(easyTrackExecutor).grantPermissionP(
    managerAddress,
    sdvt.address,
    MANAGE_SIGNING_KEYS_ROLE,
    // See https://legacy-docs.aragon.org/developers/tools/aragonos/reference-aragonos-3#parameter-interpretation for details
    [1 << (240 + Number(operatorId))],
  );
  await trace("acl.grantPermissionP", grantPermissionTx);

  log.debug("Added fake operator", {
    "Operator ID": operatorId,
    "Name": name,
    "Reward address": rewardAddress,
    "Manager address": managerAddress,
  });
};

/**
 * Adds some signing keys to the operator in the Simple DVT.
 */
export const addFakeNodeOperatorKeysToSDVT = async (
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

  const addKeysTx = await sdvt
    .connect(actor)
    .addSigningKeys(
      operatorId,
      keysToAdd,
      randomBytes(Number(keysToAdd * PUBKEY_LENGTH)),
      randomBytes(Number(keysToAdd * SIGNATURE_LENGTH)),
    );
  await trace("simpleDVT.addSigningKeys", addKeysTx);

  const totalKeysAfter = await sdvt.getTotalSigningKeyCount(operatorId);
  const unusedKeysAfter = await sdvt.getUnusedSigningKeyCount(operatorId);

  expect(totalKeysAfter).to.be.equal(totalKeysBefore + keysToAdd);
  expect(unusedKeysAfter).to.be.equal(unusedKeysBefore + keysToAdd);

  log.debug("Added fake signing keys", {
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
const setSDVTOperatorStakingLimit = async (
  ctx: ProtocolContext,
  params: {
    operatorId: bigint;
    limit: bigint;
  },
) => {
  const { sdvt } = ctx.contracts;
  const { operatorId, limit } = params;

  const easyTrackExecutor = await ctx.getSigner("easyTrack");

  const setLimitTx = await sdvt.connect(easyTrackExecutor).setNodeOperatorStakingLimit(operatorId, limit);
  await trace("simpleDVT.setNodeOperatorStakingLimit", setLimitTx);
};

/**
 * Helper function to get some operator name.
 */
const getOperatorName = (id: bigint, group: bigint = 0n) => `OP-${group}-${id}`;

/**
 * Helper function to get some operator reward address.
 */
const getOperatorRewardAddress = (id: bigint, group: bigint = 0n) => certainAddress(`OPR:${group}:${id}`);

/**
 * Helper function to get some operator manager address.
 */
const getOperatorManagerAddress = (id: bigint, group: bigint = 0n) => certainAddress(`OPM:${group}:${id}`);
