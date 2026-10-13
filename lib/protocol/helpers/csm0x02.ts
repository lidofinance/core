import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "hardhat";

import { certainAddress, ether, impersonate } from "lib";

import { ProtocolContext } from "../types";

import { depositAndReportValidators } from "./staking";
import { randomPubkeys, randomSignatures } from "./staking-module";

const CSM0X02_ABI = [
  "function ACCOUNTING() view returns (address)",
  "function CREATE_NODE_OPERATOR_ROLE() view returns (bytes32)",
  "function getRoleMemberCount(bytes32 role) view returns (uint256)",
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
  "function getNodeOperatorsCount() view returns (uint256)",
  "function getTopUpQueue() view returns (bool enabled, uint256 limit, uint256 queueLength, uint256 head)",
  "function getTopUpQueueItem(uint256 index) view returns (uint256 nodeOperatorId, uint256 keyIndex)",
  "function getSigningKeys(uint256 nodeOperatorId, uint256 startIndex, uint256 keysCount) view returns (bytes)",
  "function getKeyAllocatedBalances(uint256 nodeOperatorId, uint256 startIndex, uint256 keysCount) view returns (uint256[])",
];

const PERMISSIONLESS_GATE_ABI = [
  "function MODULE() view returns (address)",
  "function CURVE_ID() view returns (uint256)",
  "function addNodeOperatorETH(uint256 keysCount, bytes publicKeys, bytes signatures, (address managerAddress, address rewardAddress, bool extendedManagerPermissions) managementProperties, address referrer) payable returns (uint256)",
];

export const getCSM0x02Module = (ctx: ProtocolContext) => {
  const module = ctx.modules.all.find(({ name }) => name === "Community Staking 0x02");
  if (!module) throw new Error("CSM 0x02 is not registered in StakingRouter; enact its vote before running the suite");
  return {
    moduleId: module.id,
    module: new ethers.Contract(module.stakingModuleAddress, CSM0X02_ABI, ethers.provider),
  };
};

/**
 * Prepare real deposited keys at the head of the CSM 0x02 FIFO top-up queue.
 * On an empty module, create keys through its PermissionlessGate, pay the bond,
 * and deposit through DSM -> Router -> module -> DepositContract. On populated
 * forks, use the queue head rather than jumping to a fresh operator's keys.
 */
export const csm0x02EnsureDepositedKeys = async (ctx: ProtocolContext, keysCount: bigint) => {
  const { moduleId, module } = getCSM0x02Module(ctx);
  const queue = await module.getTopUpQueue();
  expect(queue.enabled, "CSM 0x02 top-up queue must be enabled").to.equal(true);

  if (queue.queueLength < keysCount) {
    const role = await module.CREATE_NODE_OPERATOR_ROLE();
    const holdersCount = await module.getRoleMemberCount(role);
    let gate: Contract | undefined;
    for (let i = 0n; i < holdersCount; i++) {
      const candidate = new ethers.Contract(
        await module.getRoleMember(role, i),
        PERMISSIONLESS_GATE_ABI,
        ethers.provider,
      );
      try {
        if ((await candidate.MODULE()).toLowerCase() === (await module.getAddress()).toLowerCase()) {
          await candidate.CURVE_ID();
          gate = candidate;
          break;
        }
      } catch {
        // Other CREATE_NODE_OPERATOR_ROLE holders need not be permissionless gates.
      }
    }
    if (!gate) throw new Error("No PermissionlessGate found for CSM 0x02");

    const accounting = new ethers.Contract(
      await module.ACCOUNTING(),
      ["function getBondAmountByKeysCount(uint256 keysCount, uint256 curveId) view returns (uint256)"],
      ethers.provider,
    );
    const missingKeys = keysCount - queue.queueLength;
    const bond = await accounting.getBondAmountByKeysCount(missingKeys, await gate.CURVE_ID());
    const operatorId = await module.getNodeOperatorsCount();
    const member = await impersonate(certainAddress(`csm0x02:operator:${operatorId}`), bond + ether("10"));
    const gateWithSigner = gate.connect(member) as Contract;
    await gateWithSigner.addNodeOperatorETH(
      missingKeys,
      randomPubkeys(Number(missingKeys)),
      randomSignatures(Number(missingKeys)),
      { managerAddress: ethers.ZeroAddress, rewardAddress: ethers.ZeroAddress, extendedManagerPermissions: false },
      ethers.ZeroAddress,
      { value: bond },
    );
    expect(await module.getNodeOperatorsCount()).to.equal(operatorId + 1n);

    await depositAndReportValidators(ctx, moduleId, missingKeys);
  }

  const operatorIds: bigint[] = [];
  const keyIndices: bigint[] = [];
  const pubkeys: string[] = [];
  for (let i = 0n; i < keysCount; i++) {
    const [operatorId, keyIndex] = await module.getTopUpQueueItem(i);
    operatorIds.push(operatorId);
    keyIndices.push(keyIndex);
    pubkeys.push(await module.getSigningKeys(operatorId, keyIndex, 1n));
  }
  return { moduleId, operatorIds, keyIndices, pubkeys };
};
