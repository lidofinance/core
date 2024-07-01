import { expect } from "chai";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { NodeOperatorsRegistry__Harness } from "typechain-types";

import { PUBKEY_LENGTH_HEX, SIGNATURE_LENGTH_HEX } from "./constants";

export interface NodeOperatorConfig {
  name: string;
  rewardAddress: string;
  totalSigningKeysCount: bigint;
  depositedSigningKeysCount: bigint;
  exitedSigningKeysCount: bigint;
  vettedSigningKeysCount: bigint;
  stuckValidatorsCount: bigint;
  refundedValidatorsCount: bigint;
  stuckPenaltyEndAt: bigint;
  isActive?: boolean;
}

/***
 * Adds new Node Operator to the registry and configures it
 * @param {object} norMock Node operators registry mocked instance
 * @param {HardhatEthersSigner} norManager Node operators registry manager
 * @param {object} config Configuration of the added node operator
 * @param {string} config.name Name of the new node operator
 * @param {string} config.rewardAddress Reward address of the new node operator
 * @param {bigint} config.totalSigningKeysCount Count of the validators in the new node operator
 * @param {bigint} config.depositedSigningKeysCount Count of used signing keys in the new node operator
 * @param {bigint} config.exitedSigningKeysCount Count of stopped signing keys in the new node operator
 * @param {bigint} config.vettedSigningKeysCount Staking limit of the new node operator
 * @param {bigint} config.stuckValidatorsCount Stuck keys count of the new node operator
 * @param {bigint} config.refundedValidatorsKeysCount Repaid keys count of the new node operator
 * @param {bigint} config.isActive The active state of new node operator
 * @returns {bigint} newOperatorId Id of newly added Node Operator
 */
export async function addNodeOperator(
  norMock: NodeOperatorsRegistry__Harness,
  norManager: HardhatEthersSigner,
  config: NodeOperatorConfig,
): Promise<bigint> {
  const isActive = config.isActive === undefined ? true : config.isActive;

  if (config.vettedSigningKeysCount < config.depositedSigningKeysCount) {
    throw new Error("Invalid keys config: vettedSigningKeysCount < depositedSigningKeysCount");
  }

  if (config.vettedSigningKeysCount > config.totalSigningKeysCount) {
    throw new Error("Invalid keys config: vettedSigningKeysCount > totalSigningKeysCount");
  }

  if (config.exitedSigningKeysCount > config.depositedSigningKeysCount) {
    throw new Error("Invalid keys config: depositedSigningKeysCount < exitedSigningKeysCount");
  }

  if (config.stuckValidatorsCount > config.depositedSigningKeysCount - config.exitedSigningKeysCount) {
    throw new Error("Invalid keys config: stuckValidatorsCount > depositedSigningKeysCount - exitedSigningKeysCount");
  }

  if (config.totalSigningKeysCount < config.exitedSigningKeysCount + config.depositedSigningKeysCount) {
    throw new Error("Invalid keys config: totalSigningKeys < stoppedValidators + usedSigningKeys");
  }

  const newOperatorId = await norMock.getNodeOperatorsCount();
  await norMock.harness__addNodeOperator(
    config.name,
    config.rewardAddress,
    config.totalSigningKeysCount,
    config.vettedSigningKeysCount,
    config.depositedSigningKeysCount,
    config.exitedSigningKeysCount,
  );
  await norMock.harness__setNodeOperatorLimits(
    newOperatorId,
    config.stuckValidatorsCount,
    config.refundedValidatorsCount,
    config.stuckPenaltyEndAt,
  );

  if (!isActive) {
    await norMock.connect(norManager).deactivateNodeOperator(newOperatorId);
  }

  const nodeOperatorsSummary = await norMock.getNodeOperatorSummary(newOperatorId);
  const nodeOperator = await norMock.getNodeOperator(newOperatorId, true);

  if (isActive) {
    expect(nodeOperator.totalVettedValidators).to.equal(config.vettedSigningKeysCount);
    expect(nodeOperator.totalAddedValidators).to.equal(config.totalSigningKeysCount);
    expect(nodeOperatorsSummary.totalExitedValidators).to.equal(config.exitedSigningKeysCount);
    expect(nodeOperatorsSummary.totalDepositedValidators).to.equal(config.depositedSigningKeysCount);
    expect(nodeOperatorsSummary.depositableValidatorsCount).to.equal(
      config.vettedSigningKeysCount - config.depositedSigningKeysCount,
    );
  } else {
    expect(nodeOperatorsSummary.totalExitedValidators).to.equal(config.exitedSigningKeysCount);
    expect(nodeOperatorsSummary.totalDepositedValidators).to.equal(config.depositedSigningKeysCount);
    expect(nodeOperatorsSummary.depositableValidatorsCount).to.equal(0);
  }
  return newOperatorId;
}

export interface IdsCountsPayload {
  operatorIds: string;
  keysCounts: string;
}

/***
 * Extracts a single pubkey from the given string of concatenated keys
 * @param {string} keys encoded keys string starting with "0x"
 * @param {string} signatures encoded signatures string starting with "0x"
 * @param {number} index key/signature id
 * @returns {string[]} extracted key/signature
 */
export function unpackKeySig(keys: string, signatures: string, index: number): string[] {
  return [
    "0x" + keys.substring(2 + PUBKEY_LENGTH_HEX * index, 2 + PUBKEY_LENGTH_HEX * (index + 1)),
    "0x" + signatures.substring(2 + SIGNATURE_LENGTH_HEX * index, 2 + SIGNATURE_LENGTH_HEX * (index + 1)),
  ];
}

/***
 * Prepares a payload for the updateExitedValidatorsCount and updateStuckValidatorsCount methods
 * @param {bigint[]} ids Node operator ids array
 * @param {bigint[]} counts Node operator keys count corresponding to the provided ids array
 * @returns {IdsCountsPayload} Encoded payload to pass to the methods
 */
export function prepIdsCountsPayload(ids: bigint[], counts: bigint[]): IdsCountsPayload {
  return {
    operatorIds: "0x" + ids.map((id) => _hex(id, 8)).join(""),
    keysCounts: "0x" + counts.map((count) => _hex(count, 16)).join(""),
  };
}

/***
 * Returns a hexadecimal representation of the given number
 * @param {bigint} n number to represent in hex
 * @param {number} byteLen bytes to pad
 * @returns {string} hexadecimal string
 */
function _hex(n: bigint, byteLen?: number): string {
  const s = n.toString(16);
  return byteLen === undefined ? s : s.padStart(byteLen * 2, "0");
}
