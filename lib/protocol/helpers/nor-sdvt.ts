import { expect } from "chai";

import { NodeOperatorsRegistry } from "typechain-types";

import { certainAddress, ether, impersonate, log } from "lib";
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
  const { numBefore, numAdded, operatorIds } = await norSdvtEnsureOperatorsHaveMinKeys(
    ctx,
    module,
    minOperatorsCount,
    minOperatorKeysCount,
  );
  for (const operatorId of operatorIds) {
    const nodeOperatorBefore = await module.getNodeOperator(operatorId, false);

    // cannot set staking limit for a deactivated operator
    if (!nodeOperatorBefore.active) continue;

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
): Promise<{ numBefore: bigint; numAdded: bigint; operatorIds: bigint[] }> => {
  const { numBefore, numAdded, operatorIds } = await norSdvtEnsureMinActiveOperators(ctx, module, minOperatorsCount);

  for (const operatorId of operatorIds) {
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

  return { numBefore, numAdded, operatorIds };
};

/**
 * Fills the NOR with active operators in case there are not enough of them.
 */
const norSdvtEnsureMinActiveOperators = async (
  ctx: ProtocolContext,
  module: LoadedContract<NodeOperatorsRegistry>,
  minOperatorsCount = MIN_OPS_COUNT,
): Promise<{ numBefore: bigint; numAdded: bigint; operatorIds: bigint[] }> => {
  const numBefore = await module.getNodeOperatorsCount();
  let numAdded = 0n;
  const operatorIds: bigint[] = [];

  for (let operatorId = 0n; operatorId < numBefore && BigInt(operatorIds.length) < minOperatorsCount; operatorId++) {
    const { active } = await module.getNodeOperator(operatorId, false);
    if (active) {
      operatorIds.push(operatorId);
    }
  }

  while (BigInt(operatorIds.length) < minOperatorsCount) {
    const operatorId = numBefore + numAdded;

    const operator = {
      name: getOperatorName((await isNor(module, ctx)) ? "nor" : "sdvt", operatorId),
      rewardAddress: getOperatorRewardAddress((await isNor(module, ctx)) ? "nor" : "sdvt", operatorId),
    };

    await norSdvtAddNodeOperator(ctx, module, operator);
    const nodeOperator = await module.getNodeOperator(operatorId, false);
    expect(nodeOperator.active).to.equal(true);

    operatorIds.push(operatorId);
    numAdded++;
  }

  const after = await module.getNodeOperatorsCount();

  expect(after).to.equal(numBefore + numAdded);
  expect(BigInt(operatorIds.length)).to.be.gte(minOperatorsCount);

  return { numBefore, numAdded, operatorIds };
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
  const { acl } = ctx.contracts;
  const { name, rewardAddress } = params;

  log.debug(`Adding fake NOR operator`, {
    "Name": name,
    "Reward address": rewardAddress,
  });

  const operatorId = await module.getNodeOperatorsCount();

  const role = await module.MANAGE_NODE_OPERATOR_ROLE();
  const managerSigner = await impersonate(await acl.getPermissionManager(module.address, role), ether("100"));

  const hasPermission = await acl["hasPermission(address,address,bytes32)"](managerSigner, module.address, role);

  if (!hasPermission) {
    await acl.connect(managerSigner).grantPermission(managerSigner, module.address, role);
  }

  await module.connect(managerSigner).addNodeOperator(name, rewardAddress);

  if (!hasPermission) {
    await acl.connect(managerSigner).revokePermission(managerSigner, module.address, role);
  }

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
  const { acl } = ctx.contracts;
  const { operatorId, keysToAdd } = params;

  log.debug(`Adding fake keys to NOR operator ${operatorId}`, {
    "Operator ID": operatorId,
    "Keys to add": keysToAdd,
  });

  const totalKeysBefore = await module.getTotalSigningKeyCount(operatorId);
  const unusedKeysBefore = await module.getUnusedSigningKeyCount(operatorId);

  const managerSigner = await impersonate(
    await acl.getPermissionManager(module.address, await module.MANAGE_SIGNING_KEYS()),
    ether("100"),
  );
  const role = await module.MANAGE_SIGNING_KEYS();
  const hasPermission = await acl["hasPermission(address,address,bytes32)"](managerSigner, module.address, role);
  if (!hasPermission) {
    await acl.connect(managerSigner).grantPermission(managerSigner, module.address, role);
  }

  await module
    .connect(managerSigner)
    .addSigningKeys(operatorId, keysToAdd, randomPubkeys(Number(keysToAdd)), randomSignatures(Number(keysToAdd)));

  if (!hasPermission) {
    await acl.connect(managerSigner).revokePermission(managerSigner, module.address, role);
  }

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
  const { acl } = ctx.contracts;
  const { operatorId, limit } = params;

  log.debug(`Setting NOR operator ${operatorId} staking limit`, {
    "Operator ID": operatorId,
    "Limit": limit,
  });

  const role = await module.SET_NODE_OPERATOR_LIMIT_ROLE();
  const managerSigner = await impersonate(await acl.getPermissionManager(module.address, role), ether("100"));
  const hasPermission = await acl["hasPermission(address,address,bytes32)"](managerSigner, module.address, role);
  if (!hasPermission) {
    await acl.connect(managerSigner).grantPermission(managerSigner, module.address, role);
  }

  await module.connect(managerSigner).setNodeOperatorStakingLimit(operatorId, limit);

  if (!hasPermission) {
    await acl.connect(managerSigner).revokePermission(managerSigner, module.address, role);
  }
};

export interface NorOperatorKeys {
  moduleId: bigint;
  operatorId: bigint;
  keyIndices: bigint[];
  pubkeys: string[];
}

/**
 * Cap every other active operator's staking limit at its deposited count so the next
 * module-level deposits can only consume keys of the given operator.
 *
 * The real deposit path only targets a staking module (DSM calls
 * `StakingRouter.deposit(moduleId, "")` and NOR ignores deposit calldata), so a test
 * cannot route a deposit to a specific operator directly. Existing keys of other
 * operators stay untouched; only their new deposit capacity is removed.
 */
export const norSdvtCapOtherOperatorsToDeposited = async (
  ctx: ProtocolContext,
  module: LoadedContract<NodeOperatorsRegistry>,
  operatorIdToKeepDepositable: bigint,
) => {
  const operatorsCount = await module.getNodeOperatorsCount();

  for (let operatorId = 0n; operatorId < operatorsCount; operatorId++) {
    if (operatorId === operatorIdToKeepDepositable) continue;

    const { active, totalDepositedValidators, totalVettedValidators } = await module.getNodeOperator(operatorId, true);
    if (!active) continue;
    if (totalVettedValidators === totalDepositedValidators) continue;

    await norSdvtSetOperatorStakingLimit(ctx, module, {
      operatorId,
      limit: totalDepositedValidators,
    });
  }
};

/**
 * Provide a NOR/SDVT operator with `keysCount` deposited keys for consolidation sources.
 *
 * On populated forks existing operators already have plenty of deposited keys, so first
 * reuse one (taking its last deposited, non-exited key indices). Only when none fits,
 * create a fresh operator and push real module-level deposits through, capping other
 * operators so the allocation deterministically lands on the new one.
 */
export const norEnsureDepositedOperatorKeys = async (
  ctx: ProtocolContext,
  module: LoadedContract<NodeOperatorsRegistry>,
  moduleId: bigint,
  keysCount: bigint,
  opts: { excludeOperatorIds?: bigint[]; name?: string } = {},
): Promise<NorOperatorKeys> => {
  const excluded = new Set((opts.excludeOperatorIds ?? []).map(String));
  const operatorsCount = await module.getNodeOperatorsCount();

  const collectKeys = async (operatorId: bigint, firstKeyIndex: bigint) => {
    const keyIndices = Array.from({ length: Number(keysCount) }, (_, i) => firstKeyIndex + BigInt(i));
    const pubkeys: string[] = [];
    for (const keyIndex of keyIndices) {
      const signingKey = await module.getSigningKey(operatorId, keyIndex);
      expect(signingKey.used).to.be.true;
      pubkeys.push(signingKey.key);
    }
    return { moduleId, operatorId, keyIndices, pubkeys };
  };

  for (let operatorId = 0n; operatorId < operatorsCount; operatorId++) {
    if (excluded.has(operatorId.toString())) continue;

    const { active, totalDepositedValidators, totalExitedValidators } = await module.getNodeOperator(operatorId, true);
    if (!active) continue;
    // Take the last deposited key indices: exit requests target the oldest keys first
    if (totalDepositedValidators - totalExitedValidators >= keysCount) {
      log.debug("Reusing existing NOR operator with deposited keys", {
        "Module ID": moduleId,
        "Operator ID": operatorId,
      });
      return collectKeys(operatorId, totalDepositedValidators - keysCount);
    }
  }

  const operatorId = await norSdvtAddNodeOperator(ctx, module, {
    name: opts.name ?? getOperatorName("nor", operatorsCount, 999n),
    rewardAddress: getOperatorRewardAddress("nor", operatorsCount, 999n),
  });

  // Add keys and deposit in batches to stay within the block gas limit
  const KEYS_BATCH = 100n;
  for (let added = 0n; added < keysCount; added += KEYS_BATCH) {
    const batch = added + KEYS_BATCH > keysCount ? keysCount - added : KEYS_BATCH;
    await norSdvtAddOperatorKeys(ctx, module, { operatorId, keysToAdd: batch });
  }

  await norSdvtSetOperatorStakingLimit(ctx, module, { operatorId, limit: keysCount });
  await norSdvtCapOtherOperatorsToDeposited(ctx, module, operatorId);

  const { totalDepositedValidators: depositedBefore } = await module.getNodeOperator(operatorId, true);

  const DEPOSIT_BATCH = 50n;
  for (let deposited = 0n; deposited < keysCount; deposited += DEPOSIT_BATCH) {
    const batch = deposited + DEPOSIT_BATCH > keysCount ? keysCount - deposited : DEPOSIT_BATCH;
    await depositAndReportValidators(ctx, moduleId, batch);
  }

  const { totalDepositedValidators: depositedAfter } = await module.getNodeOperator(operatorId, true);

  if (depositedAfter - depositedBefore !== keysCount) {
    throw new Error(
      `NOR deposit was not allocated to operator ${operatorId}: ` +
        `expected +${keysCount} deposited validators, got +${depositedAfter - depositedBefore}`,
    );
  }

  return collectKeys(operatorId, depositedBefore);
};

export const getOperatorName = (module: StakingModuleName, id: bigint, group: bigint = 0n) =>
  `${module}:op-${group}-${id}`;

export const getOperatorRewardAddress = (module: StakingModuleName, id: bigint, group: bigint = 0n) =>
  certainAddress(`${module}:op:ra-${group}-${id}`);
