import { assert } from "chai";
import { ethers } from "hardhat";

import { AccountingOracle, HashConsensus } from "typechain-types";

import { CONSENSUS_VERSION } from "lib/constants";

export type OracleReport = AccountingOracle.ReportDataStruct;

export type ReportAsArray = ReturnType<typeof getReportDataItems>;

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

// FIXME: kept for compat, remove after refactoring tests
export function pushOracleReport(
  consensus: HashConsensus,
  oracle: AccountingOracle,
  numValidators: bigint,
  clBalance: bigint,
  elRewardsVaultBalance: bigint,
) {
  return reportOracle(consensus, oracle, { numValidators, clBalance, elRewardsVaultBalance });
}

export async function getSecondsPerFrame(consensus: HashConsensus) {
  const [chainConfig, frameConfig] = await Promise.all([consensus.getChainConfig(), consensus.getFrameConfig()]);
  return chainConfig.secondsPerSlot * chainConfig.slotsPerEpoch * frameConfig.epochsPerFrame;
}

export async function getSlotTimestamp(slot: bigint, consensus: HashConsensus) {
  const chainConfig = await consensus.getChainConfig();
  return chainConfig.genesisTime + chainConfig.secondsPerSlot * slot;
}
