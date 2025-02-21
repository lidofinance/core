import { expect } from "chai";
import { ContractTransactionResponse, formatEther, Result } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { AccountingOracle } from "typechain-types";

import {
  advanceChainTime,
  BigIntMath,
  certainAddress,
  ether,
  EXTRA_DATA_FORMAT_EMPTY,
  getCurrentBlockTimestamp,
  HASH_CONSENSUS_FAR_FUTURE_EPOCH,
  impersonate,
  log,
  ONE_GWEI,
} from "lib";

import { ProtocolContext } from "../types";

const ZERO_HASH = new Uint8Array(32).fill(0);
const ZERO_BYTES32 = "0x" + Buffer.from(ZERO_HASH).toString("hex");
const SHARE_RATE_PRECISION = 10n ** 27n;
const MIN_MEMBERS_COUNT = 3n;

export type OracleReportParams = {
  clDiff?: bigint;
  clAppearedValidators?: bigint;
  elRewardsVaultBalance?: bigint | null;
  withdrawalVaultBalance?: bigint | null;
  sharesRequestedToBurn?: bigint | null;
  withdrawalFinalizationBatches?: bigint[];
  simulatedShareRate?: bigint | null;
  refSlot?: bigint | null;
  dryRun?: boolean;
  excludeVaultsBalances?: boolean;
  skipWithdrawals?: boolean;
  waitNextReportTime?: boolean;
  extraDataFormat?: bigint;
  extraDataHash?: string;
  extraDataItemsCount?: bigint;
  extraDataList?: Uint8Array;
  stakingModuleIdsWithNewlyExitedValidators?: bigint[];
  numExitedValidatorsByStakingModule?: bigint[];
  reportElVault?: boolean;
  reportWithdrawalsVault?: boolean;
  vaultValues?: bigint[];
  inOutDeltas?: bigint[];
  silent?: boolean;
};

type OracleReportResults = {
  data: AccountingOracle.ReportDataStruct;
  reportTx: ContractTransactionResponse | undefined;
  extraDataTx: ContractTransactionResponse | undefined;
};

/**
 * Prepare and push oracle report.
 */
export const report = async (
  ctx: ProtocolContext,
  {
    clDiff = ether("10"),
    clAppearedValidators = 0n,
    elRewardsVaultBalance = null,
    withdrawalVaultBalance = null,
    sharesRequestedToBurn = null,
    withdrawalFinalizationBatches = [],
    refSlot = null,
    dryRun = false,
    excludeVaultsBalances = false,
    skipWithdrawals = false,
    waitNextReportTime = true,
    extraDataFormat = EXTRA_DATA_FORMAT_EMPTY,
    extraDataHash = ZERO_BYTES32,
    extraDataItemsCount = 0n,
    extraDataList = new Uint8Array(),
    stakingModuleIdsWithNewlyExitedValidators = [],
    numExitedValidatorsByStakingModule = [],
    reportElVault = true,
    reportWithdrawalsVault = true,
    vaultValues = [],
    inOutDeltas = [],
  }: OracleReportParams = {},
): Promise<OracleReportResults> => {
  const { hashConsensus, lido, elRewardsVault, withdrawalVault, burner, accountingOracle } = ctx.contracts;

  if (waitNextReportTime) {
    await waitNextAvailableReportTime(ctx);
  }

  refSlot = refSlot ?? (await hashConsensus.getCurrentFrame()).refSlot;

  const { beaconValidators, beaconBalance } = await lido.getBeaconStat();
  const postCLBalance = beaconBalance + clDiff;
  const postBeaconValidators = beaconValidators + clAppearedValidators;

  log.debug("Beacon", {
    "Beacon validators": postBeaconValidators,
    "Beacon balance": formatEther(postCLBalance),
  });

  elRewardsVaultBalance = elRewardsVaultBalance ?? (await ethers.provider.getBalance(elRewardsVault.address));
  withdrawalVaultBalance = withdrawalVaultBalance ?? (await ethers.provider.getBalance(withdrawalVault.address));

  log.debug("Balances", {
    "Withdrawal vault": formatEther(withdrawalVaultBalance),
    "ElRewards vault": formatEther(elRewardsVaultBalance),
  });

  if (excludeVaultsBalances) {
    if (!reportWithdrawalsVault || !reportElVault) {
      log.warning("excludeVaultsBalances overrides reportWithdrawalsVault and reportElVault");
    }
    reportWithdrawalsVault = false;
    reportElVault = false;
  }

  withdrawalVaultBalance = reportWithdrawalsVault ? withdrawalVaultBalance : 0n;
  elRewardsVaultBalance = reportElVault ? elRewardsVaultBalance : 0n;

  if (sharesRequestedToBurn === null) {
    const [coverShares, nonCoverShares] = await burner.getSharesRequestedToBurn();
    sharesRequestedToBurn = coverShares + nonCoverShares;
  }

  log.debug("Burner", {
    "Shares Requested To Burn": sharesRequestedToBurn,
    "Withdrawal vault": formatEther(withdrawalVaultBalance),
    "ElRewards vault": formatEther(elRewardsVaultBalance),
  });

  let isBunkerMode = false;

  if (!skipWithdrawals) {
    const simulatedReport = await simulateReport(ctx, {
      refSlot,
      beaconValidators: postBeaconValidators,
      clBalance: postCLBalance,
      withdrawalVaultBalance,
      elRewardsVaultBalance,
      vaultValues,
      inOutDeltas,
    });

    if (!simulatedReport) {
      throw new Error("Failed to simulate report");
    }

    const { postTotalPooledEther, postTotalShares, withdrawals, elRewards } = simulatedReport;

    log.debug("Simulated report", {
      "Post Total Pooled Ether": formatEther(postTotalPooledEther),
      "Post Total Shares": postTotalShares,
      "Withdrawals": formatEther(withdrawals),
      "El Rewards": formatEther(elRewards),
    });

    const simulatedShareRate = (postTotalPooledEther * SHARE_RATE_PRECISION) / postTotalShares;

    if (withdrawalFinalizationBatches.length === 0) {
      withdrawalFinalizationBatches = await getFinalizationBatches(ctx, {
        shareRate: simulatedShareRate,
        limitedWithdrawalVaultBalance: withdrawals,
        limitedElRewardsVaultBalance: elRewards,
      });
    }

    isBunkerMode = (await lido.getTotalPooledEther()) > postTotalPooledEther;

    log.debug("Bunker Mode", { "Is Active": isBunkerMode });
  }

  const reportData = {
    consensusVersion: await accountingOracle.getConsensusVersion(),
    refSlot,
    numValidators: postBeaconValidators,
    clBalanceGwei: postCLBalance / ONE_GWEI,
    stakingModuleIdsWithNewlyExitedValidators,
    numExitedValidatorsByStakingModule,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    sharesRequestedToBurn,
    withdrawalFinalizationBatches,
    isBunkerMode,
    vaultsValues: vaultValues,
    vaultsInOutDeltas: inOutDeltas,
    extraDataFormat,
    extraDataHash,
    extraDataItemsCount,
  } satisfies AccountingOracle.ReportDataStruct;

  if (dryRun) {
    log.debug("Final Report (Dry Run)", reportData);
    return { data: reportData, reportTx: undefined, extraDataTx: undefined };
  }

  return submitReport(ctx, {
    ...reportData,
    clBalance: postCLBalance,
    extraDataList,
  });
};

export const getReportTimeElapsed = async (ctx: ProtocolContext) => {
  const { hashConsensus } = ctx.contracts;
  const { slotsPerEpoch, secondsPerSlot, genesisTime } = await hashConsensus.getChainConfig();
  const { refSlot } = await hashConsensus.getCurrentFrame();
  const time = await getCurrentBlockTimestamp();

  const { epochsPerFrame } = await hashConsensus.getFrameConfig();

  log.debug("Report elapse time", {
    "Ref slot": refSlot,
    "Ref slot date": new Date(Number(genesisTime + refSlot * secondsPerSlot) * 1000).toUTCString(),
    "Epochs per frame": epochsPerFrame,
    "Slots per epoch": slotsPerEpoch,
    "Seconds per slot": secondsPerSlot,
    "Genesis time": genesisTime,
    "Current time": time,
  });

  const slotsPerFrame = slotsPerEpoch * epochsPerFrame;
  const nextRefSlot = refSlot + slotsPerFrame;
  const nextFrameStart = genesisTime + nextRefSlot * secondsPerSlot;

  // add 10 slots to be sure that the next frame starts
  const nextFrameStartWithOffset = nextFrameStart + secondsPerSlot * 10n;

  return {
    time,
    nextFrameStart,
    nextFrameStartWithOffset,
    timeElapsed: nextFrameStartWithOffset - time,
  };
};

/**
 * Wait for the next available report time.
 */
export const waitNextAvailableReportTime = async (ctx: ProtocolContext): Promise<void> => {
  const { hashConsensus } = ctx.contracts;
  const { slotsPerEpoch } = await hashConsensus.getChainConfig();
  const { epochsPerFrame } = await hashConsensus.getFrameConfig();
  const { refSlot } = await hashConsensus.getCurrentFrame();

  const slotsPerFrame = slotsPerEpoch * epochsPerFrame;

  const { nextFrameStartWithOffset, timeElapsed } = await getReportTimeElapsed(ctx);

  await advanceChainTime(timeElapsed);

  const timeAfterAdvance = await getCurrentBlockTimestamp();

  const nextFrame = await hashConsensus.getCurrentFrame();

  log.debug("Next frame", {
    "Next ref slot": refSlot + slotsPerFrame,
    "Next frame date": new Date(Number(nextFrameStartWithOffset) * 1000).toUTCString(),
    "Time to advance": timeElapsed,
    "Time after advance": timeAfterAdvance,
    "Time after advance date": new Date(Number(timeAfterAdvance) * 1000).toUTCString(),
    "Ref slot": nextFrame.refSlot,
  });

  expect(nextFrame.refSlot).to.equal(refSlot + slotsPerFrame, "Next frame refSlot is incorrect");
};

type SimulateReportParams = {
  refSlot: bigint;
  beaconValidators: bigint;
  clBalance: bigint;
  withdrawalVaultBalance: bigint;
  elRewardsVaultBalance: bigint;
  vaultValues: bigint[];
  inOutDeltas: bigint[];
};

type SimulateReportResult = {
  postTotalPooledEther: bigint;
  postTotalShares: bigint;
  withdrawals: bigint;
  elRewards: bigint;
};

/**
 * Simulate oracle report to get the expected result.
 */
const simulateReport = async (
  ctx: ProtocolContext,
  {
    refSlot,
    beaconValidators,
    clBalance,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    vaultValues,
    inOutDeltas,
  }: SimulateReportParams,
): Promise<SimulateReportResult> => {
  const { hashConsensus, accounting } = ctx.contracts;

  const { genesisTime, secondsPerSlot } = await hashConsensus.getChainConfig();
  const reportTimestamp = genesisTime + refSlot * secondsPerSlot;

  log.debug("Simulating oracle report", {
    "Ref Slot": refSlot,
    "Beacon Validators": beaconValidators,
    "CL Balance": formatEther(clBalance),
    "Withdrawal Vault Balance": formatEther(withdrawalVaultBalance),
    "El Rewards Vault Balance": formatEther(elRewardsVaultBalance),
  });

  const { timeElapsed } = await getReportTimeElapsed(ctx);
  const update = await accounting.simulateOracleReport(
    {
      timestamp: reportTimestamp,
      timeElapsed,
      clValidators: beaconValidators,
      clBalance,
      withdrawalVaultBalance,
      elRewardsVaultBalance,
      sharesRequestedToBurn: 0n,
      withdrawalFinalizationBatches: [],
      vaultValues,
      inOutDeltas,
    },
    0n,
  );

  log.debug("Simulation result", {
    "Post Total Pooled Ether": formatEther(update.postTotalPooledEther),
    "Post Total Shares": update.postTotalShares,
    "Withdrawals": formatEther(update.withdrawals),
    "El Rewards": formatEther(update.elRewards),
  });

  return {
    postTotalPooledEther: update.postTotalPooledEther,
    postTotalShares: update.postTotalShares,
    withdrawals: update.withdrawals,
    elRewards: update.elRewards,
  };
};

type HandleOracleReportParams = {
  beaconValidators: bigint;
  clBalance: bigint;
  sharesRequestedToBurn: bigint;
  withdrawalVaultBalance: bigint;
  elRewardsVaultBalance: bigint;
  vaultValues?: bigint[];
  inOutDeltas?: bigint[];
};

export const handleOracleReport = async (
  ctx: ProtocolContext,
  {
    beaconValidators,
    clBalance,
    sharesRequestedToBurn,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    vaultValues = [],
    inOutDeltas = [],
  }: HandleOracleReportParams,
): Promise<void> => {
  const { hashConsensus, accountingOracle, accounting } = ctx.contracts;

  const { refSlot } = await hashConsensus.getCurrentFrame();
  const { genesisTime, secondsPerSlot } = await hashConsensus.getChainConfig();
  const reportTimestamp = genesisTime + refSlot * secondsPerSlot;

  const accountingOracleAccount = await impersonate(accountingOracle.address, ether("100"));

  try {
    log.debug("Handle oracle report", {
      "Ref Slot": refSlot,
      "Beacon Validators": beaconValidators,
      "CL Balance": formatEther(clBalance),
      "Withdrawal Vault Balance": formatEther(withdrawalVaultBalance),
      "El Rewards Vault Balance": formatEther(elRewardsVaultBalance),
    });

    const { timeElapsed } = await getReportTimeElapsed(ctx);
    await accounting.connect(accountingOracleAccount).handleOracleReport({
      timestamp: reportTimestamp,
      timeElapsed, // 1 day
      clValidators: beaconValidators,
      clBalance,
      withdrawalVaultBalance,
      elRewardsVaultBalance,
      sharesRequestedToBurn,
      withdrawalFinalizationBatches: [],
      vaultValues,
      inOutDeltas,
    });
  } catch (error) {
    log.error("Error", (error as Error).message ?? "Unknown error during oracle report simulation");
    expect(error).to.be.undefined;
  }
};

type FinalizationBatchesParams = {
  shareRate: bigint;
  limitedWithdrawalVaultBalance: bigint;
  limitedElRewardsVaultBalance: bigint;
};

/**
 * Get finalization batches to finalize withdrawals.
 */
const getFinalizationBatches = async (
  ctx: ProtocolContext,
  { shareRate, limitedWithdrawalVaultBalance, limitedElRewardsVaultBalance }: FinalizationBatchesParams,
): Promise<bigint[]> => {
  const { oracleReportSanityChecker, lido, withdrawalQueue } = ctx.contracts;

  const { requestTimestampMargin } = await oracleReportSanityChecker.getOracleReportLimits();

  const bufferedEther = await lido.getBufferedEther();
  const unfinalizedSteth = await withdrawalQueue.unfinalizedStETH();

  const reservedBuffer = BigIntMath.min(bufferedEther, unfinalizedSteth);
  const availableEth = limitedWithdrawalVaultBalance + limitedElRewardsVaultBalance + reservedBuffer;

  const blockTimestamp = await getCurrentBlockTimestamp();
  const maxTimestamp = blockTimestamp - requestTimestampMargin;
  const MAX_REQUESTS_PER_CALL = 1000n;

  if (availableEth === 0n) {
    log.warning("No available ether to request withdrawals");
    return [];
  }

  log.debug("Calculating finalization batches", {
    "Share Rate": shareRate,
    "Available Eth": formatEther(availableEth),
    "Max Timestamp": maxTimestamp,
  });

  const baseState = {
    remainingEthBudget: availableEth,
    finished: false,
    batches: Array(36).fill(0n),
    batchesLength: 0n,
  };

  let batchesState = await withdrawalQueue.calculateFinalizationBatches(
    shareRate,
    maxTimestamp,
    MAX_REQUESTS_PER_CALL,
    baseState,
  );

  log.debug("Calculated finalization batches", {
    "Batches": batchesState.batches.join(", "),
    "Finished": batchesState.finished,
    "Batches Length": batchesState.batchesLength,
  });

  while (!batchesState.finished) {
    const state = {
      remainingEthBudget: batchesState.remainingEthBudget,
      finished: batchesState.finished,
      batches: (batchesState.batches as Result).toArray(),
      batchesLength: batchesState.batchesLength,
    };

    batchesState = await withdrawalQueue.calculateFinalizationBatches(
      shareRate,
      maxTimestamp,
      MAX_REQUESTS_PER_CALL,
      state,
    );

    log.debug("Calculated finalization batches", {
      "Batches": batchesState.batches.join(", "),
      "Finished": batchesState.finished,
      "Batches Length": batchesState.batchesLength,
    });
  }

  return (batchesState.batches as Result).toArray().filter((x) => x > 0n);
};

export type OracleReportSubmitParams = {
  refSlot: bigint;
  clBalance: bigint;
  numValidators: bigint;
  withdrawalVaultBalance: bigint;
  elRewardsVaultBalance: bigint;
  sharesRequestedToBurn: bigint;
  stakingModuleIdsWithNewlyExitedValidators?: bigint[];
  numExitedValidatorsByStakingModule?: bigint[];
  withdrawalFinalizationBatches?: bigint[];
  isBunkerMode?: boolean;
  vaultsValues: bigint[];
  vaultsInOutDeltas: bigint[];
  extraDataFormat?: bigint;
  extraDataHash?: string;
  extraDataItemsCount?: bigint;
  extraDataList?: Uint8Array;
};

type OracleReportSubmitResult = {
  data: AccountingOracle.ReportDataStruct;
  reportTx: ContractTransactionResponse;
  extraDataTx: ContractTransactionResponse;
};

/**
 * Main function to push oracle report to the protocol.
 */
const submitReport = async (
  ctx: ProtocolContext,
  {
    refSlot,
    clBalance,
    numValidators,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    sharesRequestedToBurn,
    stakingModuleIdsWithNewlyExitedValidators = [],
    numExitedValidatorsByStakingModule = [],
    withdrawalFinalizationBatches = [],
    isBunkerMode = false,
    vaultsValues = [],
    vaultsInOutDeltas = [],
    extraDataFormat = 0n,
    extraDataHash = ZERO_BYTES32,
    extraDataItemsCount = 0n,
    extraDataList = new Uint8Array(),
  }: OracleReportSubmitParams,
): Promise<OracleReportSubmitResult> => {
  const { accountingOracle } = ctx.contracts;

  log.debug("Pushing oracle report", {
    "Ref slot": refSlot,
    "CL balance": formatEther(clBalance),
    "Validators": numValidators,
    "Withdrawal vault": formatEther(withdrawalVaultBalance),
    "El rewards vault": formatEther(elRewardsVaultBalance),
    "Shares requested to burn": sharesRequestedToBurn,
    "Staking module ids with newly exited validators": stakingModuleIdsWithNewlyExitedValidators,
    "Num exited validators by staking module": numExitedValidatorsByStakingModule,
    "Withdrawal finalization batches": withdrawalFinalizationBatches,
    "Is bunker mode": isBunkerMode,
    "Vaults values": vaultsValues,
    "Vaults in-out deltas": vaultsInOutDeltas,
    "Extra data format": extraDataFormat,
    "Extra data hash": extraDataHash,
    "Extra data items count": extraDataItemsCount,
    "Extra data list": extraDataList,
  });

  const consensusVersion = await accountingOracle.getConsensusVersion();
  const oracleVersion = await accountingOracle.getContractVersion();

  const data = {
    consensusVersion,
    refSlot,
    clBalanceGwei: clBalance / ONE_GWEI,
    numValidators,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    sharesRequestedToBurn,
    stakingModuleIdsWithNewlyExitedValidators,
    numExitedValidatorsByStakingModule,
    withdrawalFinalizationBatches,
    isBunkerMode,
    vaultsValues,
    vaultsInOutDeltas,
    extraDataFormat,
    extraDataHash,
    extraDataItemsCount,
  } as AccountingOracle.ReportDataStruct;

  const items = getReportDataItems(data);
  const hash = calcReportDataHash(items);

  const submitter = await reachConsensus(ctx, {
    refSlot,
    reportHash: hash,
    consensusVersion,
  });

  log.debug("Pushed oracle report for reached consensus", data);

  const reportTx = await accountingOracle.connect(submitter).submitReportData(data, oracleVersion);
  log.debug("Pushed oracle report main data", {
    "Ref slot": refSlot,
    "Consensus version": consensusVersion,
    "Report hash": hash,
  });

  let extraDataTx: ContractTransactionResponse;
  if (extraDataFormat) {
    extraDataTx = await accountingOracle.connect(submitter).submitReportExtraDataList(extraDataList);
  } else {
    extraDataTx = await accountingOracle.connect(submitter).submitReportExtraDataEmpty();
  }

  const state = await accountingOracle.getProcessingState();

  log.debug("Processing state", {
    "State ref slot": state.currentFrameRefSlot,
    "State main data hash": state.mainDataHash,
    "State main data submitted": state.mainDataSubmitted,
    "State extra data hash": state.extraDataHash,
    "State extra data format": state.extraDataFormat,
    "State extra data submitted": state.extraDataSubmitted,
    "State extra data items count": state.extraDataItemsCount,
    "State extra data items submitted": state.extraDataItemsSubmitted,
  });

  expect(state.currentFrameRefSlot).to.equal(refSlot, "Processing state ref slot is incorrect");
  expect(state.mainDataHash).to.equal(hash, "Processing state main data hash is incorrect");
  expect(state.mainDataSubmitted).to.be.true;
  expect(state.extraDataHash).to.equal(extraDataHash, "Processing state extra data hash is incorrect");
  expect(state.extraDataFormat).to.equal(extraDataFormat, "Processing state extra data format is incorrect");
  expect(state.extraDataSubmitted).to.be.true;
  expect(state.extraDataItemsCount).to.equal(
    extraDataItemsCount,
    "Processing state extra data items count is incorrect",
  );
  expect(state.extraDataItemsSubmitted).to.equal(
    extraDataItemsCount,
    "Processing state extra data items submitted is incorrect",
  );

  log.debug("Oracle report pushed", {
    "Ref slot": refSlot,
    "Consensus version": consensusVersion,
    "Report hash": hash,
  });

  return { data, reportTx, extraDataTx };
};

type ReachConsensusParams = {
  refSlot: bigint;
  reportHash: string;
  consensusVersion: bigint;
};

/**
 * Submit reports from all fast lane members to reach consensus on the report.
 */
const reachConsensus = async (
  ctx: ProtocolContext,
  { refSlot, reportHash, consensusVersion }: ReachConsensusParams,
) => {
  const { hashConsensus } = ctx.contracts;

  const { addresses } = await hashConsensus.getFastLaneMembers();

  let submitter: HardhatEthersSigner | null = null;

  log.debug("Reaching consensus", {
    "Ref slot": refSlot,
    "Report hash": reportHash,
    "Consensus version": consensusVersion,
    "Addresses": addresses.join(", "),
  });

  for (const address of addresses) {
    const member = await impersonate(address, ether("1"));
    if (!submitter) {
      submitter = member;
    }

    await hashConsensus.connect(member).submitReport(refSlot, reportHash, consensusVersion);
  }

  const { consensusReport } = await hashConsensus.getConsensusState();

  expect(consensusReport).to.equal(reportHash, "Consensus report hash is incorrect");

  return submitter as HardhatEthersSigner;
};

/**
 * Helper function to get report data items in the required order.
 */
const getReportDataItems = (data: AccountingOracle.ReportDataStruct) => [
  data.consensusVersion,
  data.refSlot,
  data.numValidators,
  data.clBalanceGwei,
  data.stakingModuleIdsWithNewlyExitedValidators,
  data.numExitedValidatorsByStakingModule,
  data.withdrawalVaultBalance,
  data.elRewardsVaultBalance,
  data.sharesRequestedToBurn,
  data.withdrawalFinalizationBatches,
  data.isBunkerMode,
  data.vaultsValues,
  data.vaultsInOutDeltas,
  data.extraDataFormat,
  data.extraDataHash,
  data.extraDataItemsCount,
];

/**
 * Helper function to calculate hash of the report data.
 */
const calcReportDataHash = (items: ReturnType<typeof getReportDataItems>) => {
  const types = [
    "uint256", // consensusVersion
    "uint256", // refSlot
    "uint256", // numValidators
    "uint256", // clBalanceGwei
    "uint256[]", // stakingModuleIdsWithNewlyExitedValidators
    "uint256[]", // numExitedValidatorsByStakingModule
    "uint256", // withdrawalVaultBalance
    "uint256", // elRewardsVaultBalance
    "uint256", // sharesRequestedToBurn
    "uint256[]", // withdrawalFinalizationBatches
    "bool", // isBunkerMode
    "uint256[]", // vaultsValues
    "int256[]", // vaultsInOutDeltas
    "uint256", // extraDataFormat
    "bytes32", // extraDataHash
    "uint256", // extraDataItemsCount
  ];

  const data = ethers.AbiCoder.defaultAbiCoder().encode([`(${types.join(",")})`], [items]);
  return ethers.keccak256(data);
};

/**
 * Helper function to get oracle committee member address by id.
 */
const getOracleCommitteeMemberAddress = (id: number) => certainAddress(`AO:HC:OC:${id}`);

/**
 * Ensure that the oracle committee has the required number of members.
 */
export const ensureOracleCommitteeMembers = async (ctx: ProtocolContext, minMembersCount = MIN_MEMBERS_COUNT) => {
  const { hashConsensus } = ctx.contracts;

  const members = await hashConsensus.getFastLaneMembers();
  const addresses = members.addresses.map((address) => address.toLowerCase());

  const agentSigner = await ctx.getSigner("agent");

  if (addresses.length >= minMembersCount) {
    log.debug("Oracle committee members count is sufficient", {
      "Min members count": minMembersCount,
      "Members count": addresses.length,
      "Members": addresses.join(", "),
    });

    return;
  }

  const managementRole = await hashConsensus.MANAGE_MEMBERS_AND_QUORUM_ROLE();
  await hashConsensus.connect(agentSigner).grantRole(managementRole, agentSigner);

  let count = addresses.length;
  while (addresses.length < minMembersCount) {
    log.warning(`Adding oracle committee member ${count}`);

    const address = getOracleCommitteeMemberAddress(count);
    await hashConsensus.connect(agentSigner).addMember(address, minMembersCount);

    addresses.push(address);

    log.success(`Added oracle committee member ${count}`);

    count++;
  }

  await hashConsensus.connect(agentSigner).renounceRole(managementRole, agentSigner);

  log.debug("Checked oracle committee members count", {
    "Min members count": minMembersCount,
    "Members count": addresses.length,
    "Members": addresses.join(", "),
  });

  expect(addresses.length).to.be.gte(minMembersCount);
};

/**
 * Ensure that the oracle committee members have consensus on the initial epoch.
 */
export const ensureHashConsensusInitialEpoch = async (ctx: ProtocolContext) => {
  const { hashConsensus } = ctx.contracts;

  const { initialEpoch } = await hashConsensus.getFrameConfig();
  if (initialEpoch === HASH_CONSENSUS_FAR_FUTURE_EPOCH) {
    log.warning("Initializing hash consensus epoch...");

    const latestBlockTimestamp = await getCurrentBlockTimestamp();
    const { genesisTime, secondsPerSlot, slotsPerEpoch } = await hashConsensus.getChainConfig();
    const updatedInitialEpoch = (latestBlockTimestamp - genesisTime) / (slotsPerEpoch * secondsPerSlot);

    const agentSigner = await ctx.getSigner("agent");
    await hashConsensus.connect(agentSigner).updateInitialEpoch(updatedInitialEpoch);

    log.success("Hash consensus epoch initialized");
  }
};
