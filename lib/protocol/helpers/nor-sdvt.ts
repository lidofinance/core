import { expect } from "chai";
import { ethers } from "ethers";

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
    "Limit": ethers.formatEther(limit),
  });

  const managerSigner = await impersonate(
    await acl.getPermissionManager(module.address, await module.MANAGE_SIGNING_KEYS()),
    ether("100"),
  );
  const role = await module.SET_NODE_OPERATOR_LIMIT_ROLE();
  const hasPermission = await acl["hasPermission(address,address,bytes32)"](managerSigner, module.address, role);
  if (!hasPermission) {
    await acl.connect(managerSigner).grantPermission(managerSigner, module.address, role);
  }

  await module.connect(managerSigner).setNodeOperatorStakingLimit(operatorId, limit);

  if (!hasPermission) {
    await acl.connect(managerSigner).revokePermission(managerSigner, module.address, role);
  }
};

export const getOperatorName = (module: StakingModuleName, id: bigint, group: bigint = 0n) =>
  `${module}:op-${group}-${id}`;

export const getOperatorRewardAddress = (module: StakingModuleName, id: bigint, group: bigint = 0n) =>
  certainAddress(`${module}:op:ra-${group}-${id}`);

export const getOperatorManagerAddress = (module: StakingModuleName, id: bigint, group: bigint = 0n) =>
  certainAddress(`${module}:op:ma-${group}-${id}`);
