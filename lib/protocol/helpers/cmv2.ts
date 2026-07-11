import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { certainAddress, ether, impersonate, log } from "lib";

import { ProtocolContext } from "../types";

import { depositAndReportValidators } from "./staking";
import { randomPubkeys, randomSignatures } from "./staking-module";

/**
 * Helpers for preparing real CMv2 (curated-onchain-v2) node operators in integration tests.
 *
 * CMv2 lives in the external `staking-modules` repo, so no typechain types exist here.
 * The helpers below talk to the deployed contracts through minimal ABIs and follow the
 * official CMv2 fixture flow (staking-modules test/helpers/Fixtures.sol, CuratedIntegrationHelpers):
 *   CuratedGate.createNodeOperator (merkle-gated) -> MetaRegistry group/weight -> addValidatorKeysETH.
 * Deposits go through the real DSM -> StakingRouter -> CMv2 -> DepositContract path via
 * `depositAndReportValidators`, never through a direct `obtainDepositData` call.
 */

const CMV2_MODULE_ABI = [
  "function CREATE_NODE_OPERATOR_ROLE() view returns (bytes32)",
  "function getRoleMemberCount(bytes32 role) view returns (uint256)",
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
  "function META_REGISTRY() view returns (address)",
  "function ACCOUNTING() view returns (address)",
  "function PARAMETERS_REGISTRY() view returns (address)",
  "function getNodeOperatorsCount() view returns (uint256)",
  "function getSigningKeys(uint256 nodeOperatorId, uint256 startIndex, uint256 keysCount) view returns (bytes)",
  "function getNodeOperatorSummary(uint256 nodeOperatorId) view returns (uint256 targetLimitMode, uint256 targetValidatorsCount, uint256 stuckValidatorsCount, uint256 refundedValidatorsCount, uint256 stuckPenaltyEndTimestamp, uint256 totalExitedValidators, uint256 totalDepositedValidators, uint256 depositableValidatorsCount)",
  "function addValidatorKeysETH(address from, uint256 nodeOperatorId, uint256 keysCount, bytes publicKeys, bytes signatures) payable",
  "function batchDepositInfoUpdate(uint256 maxCount) returns (uint256 operatorsLeft)",
  "function isPaused() view returns (bool)",
];

const CURATED_GATE_ABI = [
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function SET_TREE_ROLE() view returns (bytes32)",
  "function RESUME_ROLE() view returns (bytes32)",
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)",
  "function MODULE() view returns (address)",
  "function curveId() view returns (uint256)",
  "function isPaused() view returns (bool)",
  "function resume()",
  "function isConsumed(address member) view returns (bool)",
  "function setTreeParams(bytes32 treeRoot, string treeCid)",
  "function createNodeOperator(string name, string description, address managerAddress, address rewardAddress, bytes32[] proof) returns (uint256 nodeOperatorId)",
];

const META_REGISTRY_ABI = [
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function MANAGE_OPERATOR_GROUPS_ROLE() view returns (bytes32)",
  "function SET_BOND_CURVE_WEIGHT_ROLE() view returns (bytes32)",
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)",
  "function NO_GROUP_ID() view returns (uint256)",
  "function getNodeOperatorGroupId(uint256 nodeOperatorId) view returns (uint256)",
  "function getNodeOperatorWeightAndExternalStake(uint256 nodeOperatorId) view returns (uint256 weight, uint256 externalStake)",
  "function createOrUpdateOperatorGroup(uint256 groupId, (string name, (uint64 nodeOperatorId, uint16 share)[] subNodeOperators, (bytes data)[] externalOperators) groupInfo)",
  "function getBondCurveWeight(uint256 curveId) view returns (uint256)",
  "function setBondCurveWeight(uint256 curveId, uint256 weight)",
];

const CMV2_ACCOUNTING_ABI = ["function getBondAmountByKeysCount(uint256 keys, uint256 curveId) view returns (uint256)"];

const PARAMETERS_REGISTRY_ABI = [
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
  "function getKeysLimit(uint256 curveId) view returns (uint256)",
  "function setKeysLimit(uint256 curveId, uint256 limit)",
];

const OPERATOR_GROUP_FULL_SHARE = 10_000n; // MetaRegistry shares/weights are in basis points

// ethers v6 types Contract.connect() as BaseContract; keep the dynamic Contract interface
const connectSigner = (contract: Contract, signer: HardhatEthersSigner) => contract.connect(signer) as Contract;

export interface CMv2OperatorKeys {
  moduleId: bigint;
  operatorId: bigint;
  keyIndices: bigint[];
  pubkeys: string[];
}

export const getCMv2ModuleId = (ctx: ProtocolContext): bigint => {
  const cmv2 = ctx.modules.cmv2;
  if (!cmv2) {
    throw new Error("CMv2 (curated-onchain-v2) module is not registered in StakingRouter");
  }
  return cmv2.id;
};

const getCMv2Module = (ctx: ProtocolContext) => {
  const cmv2 = ctx.modules.cmv2;
  if (!cmv2) {
    throw new Error("CMv2 (curated-onchain-v2) module is not registered in StakingRouter");
  }
  return new ethers.Contract(cmv2.stakingModuleAddress, CMV2_MODULE_ABI, ethers.provider);
};

/**
 * Find the real CuratedGate: a holder of CREATE_NODE_OPERATOR_ROLE on the CMv2 module
 * that is a MerkleGate bound back to the module.
 */
const findCuratedGate = async (ctx: ProtocolContext) => {
  const module = getCMv2Module(ctx);
  const moduleAddress = await module.getAddress();
  const role = await module.CREATE_NODE_OPERATOR_ROLE();
  const holdersCount = await module.getRoleMemberCount(role);

  for (let i = 0n; i < holdersCount; i++) {
    const holder = await module.getRoleMember(role, i);
    const gate = new ethers.Contract(holder, CURATED_GATE_ABI, ethers.provider);
    try {
      const [gateModule] = await Promise.all([gate.MODULE(), gate.SET_TREE_ROLE(), gate.curveId()]);
      if (gateModule.toLowerCase() === moduleAddress.toLowerCase()) {
        return gate;
      }
    } catch {
      // Not a merkle gate (e.g. an admin EOA holding the role) - keep looking.
    }
  }

  throw new Error(`No CuratedGate found among CREATE_NODE_OPERATOR_ROLE holders of CMv2 at ${moduleAddress}`);
};

// MerkleGate.hashLeaf: keccak256(bytes.concat(keccak256(abi.encode(member))))
const hashGateLeaf = (member: string) =>
  ethers.keccak256(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [member])));

// OpenZeppelin MerkleProof commutative pair hash
const hashLeafPair = (a: string, b: string) =>
  BigInt(a) < BigInt(b) ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a]));

let memberSalt = 0;

/**
 * Create a CMv2 node operator through the real CuratedGate with `keysCount` added
 * (bonded but NOT deposited) keys. Mirrors the official CMv2 fixture:
 * temporary merkle root in the gate snapshot, operator group with full share in
 * MetaRegistry, non-zero bond curve weight, bond paid via addValidatorKeysETH.
 */
export const cmv2CreateOperatorWithKeys = async (
  ctx: ProtocolContext,
  params: { name: string; keysCount: bigint },
): Promise<CMv2OperatorKeys> => {
  const { name, keysCount } = params;
  const moduleId = getCMv2ModuleId(ctx);
  const module = getCMv2Module(ctx);
  const gate = await findCuratedGate(ctx);

  // Fresh member per operator: the gate allows only one createNodeOperator per address
  const member = await impersonate(certainAddress(`cmv2:member:${name}:${memberSalt++}`), ether("100"));

  // Prepare the gate: temporary merkle tree with the member as an admitted leaf
  const gateAdmin = await impersonate(await gate.getRoleMember(await gate.DEFAULT_ADMIN_ROLE(), 0), ether("100"));

  const setTreeRole = await gate.SET_TREE_ROLE();
  if (!(await gate.hasRole(setTreeRole, gateAdmin.address))) {
    await connectSigner(gate, gateAdmin).grantRole(setTreeRole, gateAdmin.address);
  }
  if (await gate.isPaused()) {
    const resumeRole = await gate.RESUME_ROLE();
    if (!(await gate.hasRole(resumeRole, gateAdmin.address))) {
      await connectSigner(gate, gateAdmin).grantRole(resumeRole, gateAdmin.address);
    }
    await connectSigner(gate, gateAdmin).resume();
  }

  const memberLeaf = hashGateLeaf(member.address);
  const extraLeaf = hashGateLeaf(certainAddress(`cmv2:member:extra:${name}:${memberSalt++}`));
  await connectSigner(gate, gateAdmin).setTreeParams(hashLeafPair(memberLeaf, extraLeaf), `test-cid-${name}`);

  const operatorId = await module.getNodeOperatorsCount();
  await connectSigner(gate, member).createNodeOperator(
    name,
    "integration test operator",
    ethers.ZeroAddress,
    member.address,
    [extraLeaf],
  );
  expect(await module.getNodeOperatorsCount()).to.equal(operatorId + 1n);

  // MetaRegistry: the operator must belong to a group and its bond curve must have weight,
  // otherwise the deposit allocator assigns it zero allocation weight
  const metaRegistry = new ethers.Contract(await module.META_REGISTRY(), META_REGISTRY_ABI, ethers.provider);
  const registryAdmin = await impersonate(
    await metaRegistry.getRoleMember(await metaRegistry.DEFAULT_ADMIN_ROLE(), 0),
    ether("100"),
  );

  const noGroupId = await metaRegistry.NO_GROUP_ID();
  if ((await metaRegistry.getNodeOperatorGroupId(operatorId)) === noGroupId) {
    const manageGroupsRole = await metaRegistry.MANAGE_OPERATOR_GROUPS_ROLE();
    if (!(await metaRegistry.hasRole(manageGroupsRole, registryAdmin.address))) {
      await connectSigner(metaRegistry, registryAdmin).grantRole(manageGroupsRole, registryAdmin.address);
    }
    await connectSigner(metaRegistry, registryAdmin).createOrUpdateOperatorGroup(noGroupId, {
      name,
      subNodeOperators: [{ nodeOperatorId: operatorId, share: OPERATOR_GROUP_FULL_SHARE }],
      externalOperators: [],
    });
  }

  const curveId = await gate.curveId();
  if ((await metaRegistry.getBondCurveWeight(curveId)) === 0n) {
    const setWeightRole = await metaRegistry.SET_BOND_CURVE_WEIGHT_ROLE();
    if (!(await metaRegistry.hasRole(setWeightRole, registryAdmin.address))) {
      await connectSigner(metaRegistry, registryAdmin).grantRole(setWeightRole, registryAdmin.address);
    }
    await connectSigner(metaRegistry, registryAdmin).setBondCurveWeight(curveId, OPERATOR_GROUP_FULL_SHARE);
  }
  expect(await metaRegistry.getBondCurveWeight(curveId)).to.be.gt(0n);

  // The per-operator keys limit is a bond-curve parameter; raise it when the requested
  // key count does not fit
  const parametersRegistry = new ethers.Contract(
    await module.PARAMETERS_REGISTRY(),
    PARAMETERS_REGISTRY_ABI,
    ethers.provider,
  );
  if ((await parametersRegistry.getKeysLimit(curveId)) < keysCount) {
    const parametersAdmin = await impersonate(
      await parametersRegistry.getRoleMember(await parametersRegistry.DEFAULT_ADMIN_ROLE(), 0),
      ether("100"),
    );
    await connectSigner(parametersRegistry, parametersAdmin).setKeysLimit(curveId, keysCount);
  }

  // Pay the bond and add the keys
  const accounting = new ethers.Contract(await module.ACCOUNTING(), CMV2_ACCOUNTING_ABI, ethers.provider);
  const bond = await accounting.getBondAmountByKeysCount(keysCount, curveId);
  await ethers.provider.send("hardhat_setBalance", [member.address, ethers.toBeHex(bond + ether("10"))]);

  await connectSigner(module, member).addValidatorKeysETH(
    member.address,
    operatorId,
    keysCount,
    randomPubkeys(Number(keysCount)),
    randomSignatures(Number(keysCount)),
    { value: bond },
  );

  // setBondCurveWeight / group changes invalidate the module deposit info snapshot;
  // obtainDepositData refuses to run until it is refreshed (permissionless call)
  await connectSigner(module, member).batchDepositInfoUpdate(await module.getNodeOperatorsCount());

  const summary = await module.getNodeOperatorSummary(operatorId);
  expect(summary.totalDepositedValidators).to.equal(0n);
  expect(summary.depositableValidatorsCount).to.equal(keysCount);

  const keyIndices = Array.from({ length: Number(keysCount) }, (_, i) => BigInt(i));
  const pubkeys = await getCMv2SigningKeys(ctx, operatorId, keyIndices);

  log.debug("Created CMv2 operator", {
    "Module ID": moduleId,
    "Operator ID": operatorId,
    "Keys added": keysCount,
    "Bond paid": ethers.formatEther(bond),
  });

  return { moduleId, operatorId, keyIndices, pubkeys };
};

/**
 * Normalize the CMv2 top-up allocation baseline so `keepOperatorId` is the only
 * operator with a non-zero allocation weight.
 *
 * On a fork the operators' MetaRegistry weights and tracked stakes are arbitrary, and
 * the greedy allocator caps every operator at `target - current` of its weight share,
 * so top-up amounts are not predictable. This helper clears every other operator
 * group in the MetaRegistry (the same real path the registry admin would use), which
 * zeroes those operators' effective weights. The kept operator then holds 100% of the
 * weight, its allocation target covers the entire requested amount, and expected
 * top-up amounts become exact on any fork state.
 *
 * Use this only as explicit test setup.
 */
export const cmv2NormalizeTopUpAllocationBaseline = async (ctx: ProtocolContext, keepOperatorId: bigint) => {
  const module = getCMv2Module(ctx);
  const metaRegistry = new ethers.Contract(await module.META_REGISTRY(), META_REGISTRY_ABI, ethers.provider);

  const registryAdmin = await impersonate(
    await metaRegistry.getRoleMember(await metaRegistry.DEFAULT_ADMIN_ROLE(), 0),
    ether("100"),
  );
  const manageGroupsRole = await metaRegistry.MANAGE_OPERATOR_GROUPS_ROLE();
  if (!(await metaRegistry.hasRole(manageGroupsRole, registryAdmin.address))) {
    await connectSigner(metaRegistry, registryAdmin).grantRole(manageGroupsRole, registryAdmin.address);
  }

  const noGroupId = await metaRegistry.NO_GROUP_ID();
  const keepGroupId = await metaRegistry.getNodeOperatorGroupId(keepOperatorId);
  if (keepGroupId === noGroupId) {
    throw new Error(`Operator ${keepOperatorId} has no MetaRegistry group; create it via cmv2CreateOperatorWithKeys`);
  }

  // Collect the groups of all other operators and clear them (a cleared group zeroes
  // the effective weight of its operators)
  const operatorsCount = await module.getNodeOperatorsCount();
  const groupsToClear = new Set<bigint>();
  for (let operatorId = 0n; operatorId < operatorsCount; operatorId++) {
    if (operatorId === keepOperatorId) continue;
    const groupId = await metaRegistry.getNodeOperatorGroupId(operatorId);
    if (groupId !== noGroupId && groupId !== keepGroupId) {
      groupsToClear.add(groupId);
    }
  }

  for (const groupId of groupsToClear) {
    await connectSigner(metaRegistry, registryAdmin).createOrUpdateOperatorGroup(groupId, {
      name: "",
      subNodeOperators: [],
      externalOperators: [],
    });
  }

  // Weight changes invalidate the deposit info snapshot; refresh it (permissionless)
  await cmv2RefreshDepositInfo(ctx);

  // The baseline is normalized only if the kept operator now holds all the weight
  const [keepWeight] = await metaRegistry.getNodeOperatorWeightAndExternalStake(keepOperatorId);
  if (keepWeight === 0n) {
    throw new Error(`Kept operator ${keepOperatorId} has zero effective weight after normalization`);
  }
  for (let operatorId = 0n; operatorId < operatorsCount; operatorId++) {
    if (operatorId === keepOperatorId) continue;
    const [weight] = await metaRegistry.getNodeOperatorWeightAndExternalStake(operatorId);
    if (weight !== 0n) {
      throw new Error(`Operator ${operatorId} still has non-zero weight ${weight} after normalization`);
    }
  }

  log.debug("Normalized CMv2 top-up allocation baseline", {
    "Kept operator": keepOperatorId,
    "Groups cleared": groupsToClear.size,
  });
};

/**
 * Refresh the CMv2 module deposit info snapshot (permissionless).
 *
 * `allocateDeposits` reverts with `DepositInfoIsNotUpToDate` while any operator's
 * deposit info is stale, which is a live possibility on populated forks. A call when
 * the snapshot is already fresh is a cheap no-op.
 */
export const cmv2RefreshDepositInfo = async (ctx: ProtocolContext) => {
  const module = getCMv2Module(ctx);
  const caller = await impersonate(certainAddress("cmv2:deposit-info:refresher"), ether("10"));
  await connectSigner(module, caller).batchDepositInfoUpdate(await module.getNodeOperatorsCount());
};

/**
 * Read individual signing keys of a CMv2 operator.
 */
export const getCMv2SigningKeys = async (
  ctx: ProtocolContext,
  operatorId: bigint,
  keyIndices: bigint[],
): Promise<string[]> => {
  const module = getCMv2Module(ctx);
  return Promise.all(keyIndices.map((keyIndex) => module.getSigningKeys(operatorId, keyIndex, 1)));
};

/**
 * Provide a CMv2 operator with `keysCount` deposited keys for consolidation targets.
 *
 * On a populated fork (e.g. Hoodi) the deposit allocator may route new deposits to any
 * operator, so first try to reuse an existing operator that already has enough
 * consecutive deposited non-exited keys. Only when none exists, create a fresh operator
 * and push a real DSM -> StakingRouter deposit through, asserting the exact per-operator
 * deposited delta (a successful module-level deposit alone does not prove the right
 * operator's keys were used).
 */
export const cmv2EnsureDepositedOperatorKeys = async (
  ctx: ProtocolContext,
  keysCount: bigint,
  opts: { excludeOperatorIds?: bigint[]; name?: string; forceCreate?: boolean } = {},
): Promise<CMv2OperatorKeys> => {
  const moduleId = getCMv2ModuleId(ctx);
  const module = getCMv2Module(ctx);
  const excluded = new Set((opts.excludeOperatorIds ?? []).map(String));

  // forceCreate skips the reuse scan: on populated forks an existing operator is
  // usually above its allocation target and would receive zero top-up allocation
  const operatorsCount = opts.forceCreate ? 0n : await module.getNodeOperatorsCount();
  for (let operatorId = 0n; operatorId < operatorsCount; operatorId++) {
    if (excluded.has(operatorId.toString())) continue;

    const summary = await module.getNodeOperatorSummary(operatorId);
    // Take the last deposited key indices: exited keys occupy the earliest indices
    if (summary.totalDepositedValidators - summary.totalExitedValidators >= keysCount) {
      const keyIndices = Array.from(
        { length: Number(keysCount) },
        (_, i) => summary.totalDepositedValidators - keysCount + BigInt(i),
      );
      const pubkeys = await getCMv2SigningKeys(ctx, operatorId, keyIndices);

      log.debug("Reusing existing CMv2 operator with deposited keys", {
        "Module ID": moduleId,
        "Operator ID": operatorId,
        "Key indices": keyIndices.join(", "),
      });

      return { moduleId, operatorId, keyIndices, pubkeys };
    }
  }

  const created = await cmv2CreateOperatorWithKeys(ctx, {
    name: opts.name ?? `cmv2-consolidation-target-${memberSalt}`,
    keysCount,
  });

  const before = await module.getNodeOperatorSummary(created.operatorId);
  await depositAndReportValidators(ctx, moduleId, keysCount);
  const after = await module.getNodeOperatorSummary(created.operatorId);

  const operatorDelta = BigInt(after.totalDepositedValidators) - BigInt(before.totalDepositedValidators);
  if (operatorDelta !== keysCount) {
    throw new Error(
      `CMv2 deposit was not allocated to operator ${created.operatorId}: ` +
        `expected +${keysCount} deposited validators, got +${operatorDelta}. ` +
        `Another CMv2 operator with depositable keys consumed the allocation.`,
    );
  }

  return created;
};
