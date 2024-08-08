import { bigintToHex } from "bigint-conversion";
import { assert } from "chai";
import { keccak256, ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { AccountingOracle, HashConsensus } from "typechain-types";

import { CONSENSUS_VERSION } from "lib/constants";

import { numberToHex } from "./string";

function splitArrayIntoChunks<T>(inputArray: T[], maxItemsPerChunk: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < inputArray.length; i += maxItemsPerChunk) {
    const chunk: T[] = inputArray.slice(i, i + maxItemsPerChunk);
    result.push(chunk);
  }
  return result;
}

export type OracleReport = AccountingOracle.ReportDataStruct;

export type ReportAsArray = ReturnType<typeof getReportDataItems>;

export type KeyType = { moduleId: number; nodeOpIds: number[]; keysCounts: number[] };
export type ExtraDataType = { stuckKeys: KeyType[]; exitedKeys: KeyType[] };

export type ItemType = KeyType & { type: bigint };

export const EXTRA_DATA_FORMAT_EMPTY = 0n;
export const EXTRA_DATA_FORMAT_LIST = 1n;

export const EXTRA_DATA_TYPE_STUCK_VALIDATORS = 1n;
export const EXTRA_DATA_TYPE_EXITED_VALIDATORS = 2n;

const DEFAULT_REPORT_FIELDS: OracleReport = {
  consensusVersion: 1n,
  refSlot: 0n,
  numValidators: 0n,
  clBalanceGwei: 0n,
  stakingModuleIdsWithNewlyExitedValidators: [],
  numExitedValidatorsByStakingModule: [],
  withdrawalVaultBalance: 0n,
  elRewardsVaultBalance: 0n,
  sharesRequestedToBurn: 0n,
  withdrawalFinalizationBatches: [],
  simulatedShareRate: 0n,
  isBunkerMode: false,
  extraDataFormat: 0n,
  extraDataHash: ethers.ZeroHash,
  extraDataItemsCount: 0n,
};

export function getReportDataItems(r: OracleReport) {
  return [
    r.consensusVersion,
    r.refSlot,
    r.numValidators,
    r.clBalanceGwei,
    r.stakingModuleIdsWithNewlyExitedValidators,
    r.numExitedValidatorsByStakingModule,
    r.withdrawalVaultBalance,
    r.elRewardsVaultBalance,
    r.sharesRequestedToBurn,
    r.withdrawalFinalizationBatches,
    r.simulatedShareRate,
    r.isBunkerMode,
    r.extraDataFormat,
    r.extraDataHash,
    r.extraDataItemsCount,
  ];
}

export function calcReportDataHash(reportItems: ReportAsArray) {
  const data = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "(uint256, uint256, uint256, uint256, uint256[], uint256[], uint256, uint256, uint256, uint256[], uint256, bool, uint256, bytes32, uint256)",
    ],
    [reportItems],
  );
  return ethers.keccak256(data);
}

export async function prepareOracleReport({
  clBalance,
  ...restFields
}: {
  clBalance: bigint;
} & Partial<OracleReport>) {
  const fields = {
    ...DEFAULT_REPORT_FIELDS,
    ...restFields,
    clBalanceGwei: clBalance / 10n ** 9n,
  } as OracleReport;

  const items = getReportDataItems(fields);
  const hash = calcReportDataHash(items);

  return { fields, items, hash };
}

export async function triggerConsensusOnHash(hash: string, consensus: HashConsensus) {
  const { refSlot } = await consensus.getCurrentFrame();
  const membersInfo = await consensus.getMembers();
  const signers = [
    await ethers.provider.getSigner(membersInfo.addresses[0]),
    await ethers.provider.getSigner(membersInfo.addresses[1]),
  ];
  for (const s of signers) {
    await consensus.connect(s).submitReport(refSlot, hash, CONSENSUS_VERSION);
  }
  assert.equal((await consensus.getConsensusState()).consensusReport, hash);
}

export async function reportOracle(
  consensus: HashConsensus,
  oracle: AccountingOracle,
  reportFields: Partial<OracleReport> & { clBalance: bigint },
) {
  const { refSlot } = await consensus.getCurrentFrame();
  const report = await prepareOracleReport({ ...reportFields, refSlot });

  // non-empty extra data is not supported here yet
  assert.equal(report.fields.extraDataFormat, 0n);
  assert.equal(report.fields.extraDataHash, ethers.ZeroHash);
  assert.equal(report.fields.extraDataItemsCount, 0n);

  const membersInfo = await consensus.getMembers();
  await triggerConsensusOnHash(report.hash, consensus);

  const oracleVersion = await oracle.getContractVersion();

  const memberSigner = await ethers.provider.getSigner(membersInfo.addresses[0]);
  const submitDataTx = await oracle.connect(memberSigner).submitReportData(report.fields, oracleVersion);
  const submitExtraDataTx = await oracle.connect(memberSigner).submitReportExtraDataEmpty();

  return { report, submitDataTx, submitExtraDataTx };
}

export function encodeExtraDataItem(
  itemIndex: number,
  itemType: bigint,
  moduleId: number,
  nodeOperatorIds: number[],
  keysCounts: number[],
) {
  const itemHeader = numberToHex(itemIndex, 3) + bigintToHex(itemType, false, 2);
  const payloadHeader = numberToHex(moduleId, 3) + numberToHex(nodeOperatorIds.length, 8);
  const operatorIdsPayload = nodeOperatorIds.map((id) => numberToHex(id, 8)).join("");
  const keysCountsPayload = keysCounts.map((count) => numberToHex(count, 16)).join("");
  return "0x" + itemHeader + payloadHeader + operatorIdsPayload + keysCountsPayload;
}

export function encodeExtraDataItemsArray(items: ItemType[]): string[] {
  return items.map((item, index) =>
    encodeExtraDataItem(index, item.type, item.moduleId, item.nodeOpIds, item.keysCounts),
  );
}

export function encodeExtraDataItems(data: ExtraDataType) {
  const itemsWithType: ItemType[] = [];

  const toItemWithType = (keys: KeyType[], type: bigint) => keys.map((item) => ({ ...item, type }));

  itemsWithType.push(...toItemWithType(data.stuckKeys, EXTRA_DATA_TYPE_STUCK_VALIDATORS));
  itemsWithType.push(...toItemWithType(data.exitedKeys, EXTRA_DATA_TYPE_EXITED_VALIDATORS));

  return encodeExtraDataItemsArray(itemsWithType);
}

function packChunk(extraDataItems: string[], nextHash: string) {
  const extraDataItemsBytes = extraDataItems.map((s) => s.substring(2)).join("");
  return `${nextHash}${extraDataItemsBytes}`;
}

export function packExtraDataItemsToChunksLinkedByHash(extraDataItems: string[], maxItemsPerChunk: number) {
  const chunks = splitArrayIntoChunks(extraDataItems, maxItemsPerChunk);
  const packedChunks = [];

  let nextHash = ethers.ZeroHash;
  for (let i = chunks.length - 1; i >= 0; i--) {
    const packed = packChunk(chunks[i], nextHash);
    packedChunks.push(packed);
    nextHash = calcExtraDataListHash(packed);
  }

  return packedChunks.reverse();
}

export function packExtraDataList(extraDataItems: string[]) {
  const [chunk] = packExtraDataItemsToChunksLinkedByHash(extraDataItems, extraDataItems.length);

  return chunk;
}

export function calcExtraDataListHash(packedExtraDataList: string) {
  return keccak256(packedExtraDataList);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isItemTypeArray(items: any[]): items is ItemType[] {
  return items.every((item) => item.hasOwnProperty("moduleId") && item.hasOwnProperty("type"));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isExtraDataType(data: any): data is ExtraDataType {
  return data.hasOwnProperty("stuckKeys") && data.hasOwnProperty("exitedKeys");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isStringArray(items: any[]): items is string[] {
  return items.every((item) => typeof item === "string");
}

type ExtraDataConfig = {
  maxItemsPerChunk?: number;
};

export type ReportFieldsWithoutExtraData = Omit<
  OracleReport,
  "extraDataHash" | "extraDataItemsCount" | "extraDataFormat"
>;

export type ExtraData = string[] | ItemType[] | ExtraDataType;
export type OracleReportProps = {
  reportFieldsWithoutExtraData: ReportFieldsWithoutExtraData;
  extraData: ExtraData;
  config?: ExtraDataConfig;
};

export function constructOracleReport({ reportFieldsWithoutExtraData, extraData, config }: OracleReportProps) {
  const extraDataItems: string[] = [];

  if (Array.isArray(extraData)) {
    if (isStringArray(extraData)) {
      extraDataItems.push(...extraData);
    } else if (isItemTypeArray(extraData)) {
      extraDataItems.push(...encodeExtraDataItemsArray(extraData));
    }
  } else if (isExtraDataType(extraData)) {
    extraDataItems.push(...encodeExtraDataItems(extraData));
  }

  const extraDataItemsCount = extraDataItems.length;
  const maxItemsPerChunk = config?.maxItemsPerChunk || extraDataItemsCount;
  const extraDataChunks = packExtraDataItemsToChunksLinkedByHash(extraDataItems, maxItemsPerChunk);
  const extraDataChunkHashes = extraDataChunks.map((chunk) => calcExtraDataListHash(chunk));

  const report: OracleReport = {
    ...reportFieldsWithoutExtraData,
    extraDataHash: extraDataItems.length ? extraDataChunkHashes[0] : ZeroHash,
    extraDataItemsCount: extraDataItems.length,
    extraDataFormat: extraDataItems.length ? EXTRA_DATA_FORMAT_LIST : EXTRA_DATA_FORMAT_EMPTY,
  };

  const reportHash = calcReportDataHash(getReportDataItems(report));

  return {
    extraDataChunks,
    extraDataChunkHashes,
    extraDataItemsCount,
    report,
    reportHash,
  };
}

export async function getSecondsPerFrame(consensus: HashConsensus) {
  const [chainConfig, frameConfig] = await Promise.all([consensus.getChainConfig(), consensus.getFrameConfig()]);
  return chainConfig.secondsPerSlot * chainConfig.slotsPerEpoch * frameConfig.epochsPerFrame;
}

export async function getSlotTimestamp(slot: bigint, consensus: HashConsensus) {
  const chainConfig = await consensus.getChainConfig();
  return chainConfig.genesisTime + chainConfig.secondsPerSlot * slot;
}
