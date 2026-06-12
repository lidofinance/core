import { expect } from "chai";
import { ContractTransactionResponse, formatEther, Result } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { AccountingOracle } from "typechain-types";
import { ReportValuesStruct } from "typechain-types/contracts/0.8.9/Accounting.sol/Accounting";

import {
  advanceChainTime,
  certainAddress,
  ether,
  EXTRA_DATA_FORMAT_EMPTY,
  EXTRA_DATA_FORMAT_LIST,
  getCurrentBlockTimestamp,
  HASH_CONSENSUS_FAR_FUTURE_EPOCH,
  impersonate,
  log,
  ONE_GWEI,
  prepareExtraData,
  toGwei,
} from "lib";

import { ProtocolContext } from "../types";

import { buildModuleAccountingReportParams } from "./staking";

export type OracleReportParams = {
  clDiff?: bigint;
  clAppearedValidators?: bigint;
  clPendingBalanceGwei?: bigint;
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
  stakingModuleIdsWithUpdatedBalance?: bigint[];
  validatorBalancesGweiByStakingModule?: bigint[];
  reportElVault?: boolean;
  reportWithdrawalsVault?: boolean;
  reportBurner?: boolean;
  vaultsDataTreeRoot?: string;
  vaultsDataTreeCid?: string;
  silent?: boolean;
};

type OracleReportResults = {
  data: AccountingOracle.ReportDataStruct;
  reportTx: ContractTransactionResponse | undefined;
  extraDataTx: ContractTransactionResponse | undefined;
};
export const ZERO_HASH = new Uint8Array(32).fill(0);
const ZERO_BYTES32 = "0x" + Buffer.from(ZERO_HASH).toString("hex");
const SHARE_RATE_PRECISION = 10n ** 27n;
const CL_BALANCE_DECREASE_WINDOW_RESET_SECONDS = 37n * 24n * 60n * 60n;

export function adjustReportModuleBalances(
  {
    stakingModuleIdsWithUpdatedBalance = [],
    validatorBalancesGweiByStakingModule = [],
  }: {
    stakingModuleIdsWithUpdatedBalance: bigint[];
    validatorBalancesGweiByStakingModule: bigint[];
  },
  clValidatorsBalanceGwei: bigint,
) {
  const { lastIndex: lastNonZeroIndex, totalBalance: totalBalanceGwei } = validatorBalancesGweiByStakingModule.reduce<{
    lastIndex: number;
    totalBalance: bigint;
  }>(
    ({ lastIndex, totalBalance }, balance, index) => {
      return { lastIndex: balance > 0n ? index : lastIndex, totalBalance: totalBalance + balance };
    },
    { lastIndex: 0, totalBalance: 0n },
  );

  let remainingTotalBalanceGwei = clValidatorsBalanceGwei;
  for (let i = 0; i < validatorBalancesGweiByStakingModule.length; ++i) {
    const balance = validatorBalancesGweiByStakingModule[i];
    if (balance === 0n) continue;

    const balanceNew =
      i === lastNonZeroIndex ? remainingTotalBalanceGwei : (clValidatorsBalanceGwei * balance) / totalBalanceGwei;

    remainingTotalBalanceGwei -= balanceNew;
    validatorBalancesGweiByStakingModule[i] = balanceNew;
  }

  return {
    stakingModuleIdsWithUpdatedBalance,
    validatorBalancesGweiByStakingModule,
  };
}

/**
 * Prepare and push oracle report.
 */
export const report = async (
  ctx: ProtocolContext,
  {
    clDiff,
    clAppearedValidators = 0n,
    clPendingBalanceGwei = 0n,
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
    stakingModuleIdsWithUpdatedBalance = [],
    validatorBalancesGweiByStakingModule = [],
    reportElVault = true,
    reportWithdrawalsVault = true,
    reportBurner = true,
    vaultsDataTreeRoot = ZERO_BYTES32,
    vaultsDataTreeCid = "",
  }: OracleReportParams = {},
): Promise<OracleReportResults> => {
  const { hashConsensus, lido, elRewardsVault, withdrawalVault, burner, accountingOracle, oracleReportSanityChecker } =
    ctx.contracts;

  if (waitNextReportTime) {
    await waitNextAvailableReportTime(ctx);
  }

  refSlot = refSlot ?? (await hashConsensus.getCurrentFrame()).refSlot;

  const {
    clValidatorsBalanceAtLastReport,
    clPendingBalanceAtLastReport,
    depositedForCurrentReport,
    depositedSinceLastReport,
  } = await lido.getBalanceStats();
  const deposited = waitNextReportTime ? depositedForCurrentReport : depositedSinceLastReport;
  clDiff = clDiff ?? deposited;
  const preCLBalance = clValidatorsBalanceAtLastReport + clPendingBalanceAtLastReport;

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

  if (reportWithdrawalsVault) {
    const lastVaultBalanceAfterTransfer = BigInt(await ethers.provider.getStorage(oracleReportSanityChecker, 4n));
    if (withdrawalVaultBalance < lastVaultBalanceAfterTransfer) {
      throw new Error("Reported withdrawal vault balance is below last vault balance after transfer");
    }
    // Sync _lastVaultBalanceAfterTransfer with the current vault balance so the pending check
    // does not interpret test-funded vault balance as CL withdrawals (zero-sum rebalancing).
    // The contract will update _lastVaultBalanceAfterTransfer = vaultBalance - transfer after the report.
    if (withdrawalVaultBalance > lastVaultBalanceAfterTransfer) {
      await ethers.provider.send("hardhat_setStorageAt", [
        await oracleReportSanityChecker.getAddress(),
        ethers.toBeHex(4n, 32),
        ethers.toBeHex(withdrawalVaultBalance, 32),
      ]);
    }
  }

  const postCLBalance = preCLBalance + clDiff;

  log.debug("Beacon", {
    "Beacon validators delta": clAppearedValidators,
    "Beacon balance": formatEther(postCLBalance),
  });

  if (sharesRequestedToBurn === null && reportBurner) {
    const [coverShares, nonCoverShares] = await burner.getSharesRequestedToBurn();
    sharesRequestedToBurn = coverShares + nonCoverShares;
  }

  log.debug("Burner", {
    "Shares Requested To Burn": sharesRequestedToBurn ?? "0",
    "Withdrawal vault": formatEther(withdrawalVaultBalance),
    "ElRewards vault": formatEther(elRewardsVaultBalance),
  });

  let isBunkerMode = false;

  const simulatedReport = await simulateReport(ctx, {
    refSlot,
    clValidatorsBalance: postCLBalance,
    clPendingBalance: 0n,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
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

  const simulatedShareRate =
    postTotalShares === 0n ? 0n : (postTotalPooledEther * SHARE_RATE_PRECISION) / postTotalShares;

  if (!skipWithdrawals) {
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

  if (stakingModuleIdsWithUpdatedBalance.length === 0) {
    ({ stakingModuleIdsWithUpdatedBalance, validatorBalancesGweiByStakingModule } = adjustReportModuleBalances(
      await buildModuleAccountingReportParams(ctx),
      toGwei(postCLBalance),
    ));
  }

  const reportData = {
    consensusVersion: await accountingOracle.getConsensusVersion(),
    refSlot,
    clValidatorsBalanceGwei: postCLBalance / ONE_GWEI - clPendingBalanceGwei,
    clPendingBalanceGwei,
    stakingModuleIdsWithNewlyExitedValidators,
    numExitedValidatorsByStakingModule,
    stakingModuleIdsWithUpdatedBalance,
    validatorBalancesGweiByStakingModule,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    sharesRequestedToBurn: sharesRequestedToBurn ?? 0n,
    withdrawalFinalizationBatches,
    simulatedShareRate,
    isBunkerMode,
    vaultsDataTreeRoot,
    vaultsDataTreeCid,
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

export const getDepositedSinceLastReport = async (ctx: ProtocolContext): Promise<bigint> => {
  const { depositedSinceLastReport } = await ctx.contracts.lido.getBalanceStats();
  return depositedSinceLastReport;
};

/**
 * Submit report with an effective CL delta between reports.
 *
 * `report()` expects `clDiff` as raw `postCLBalance - preCLBalance`.
 * Since `preCLBalance` is based on last report snapshot, deposits made after that
 * snapshot must be added to preserve the intended effective delta.
 */
export const reportWithEffectiveClDiff = async (
  ctx: ProtocolContext,
  effectiveClDiff: bigint,
  params: Omit<OracleReportParams, "clDiff"> = {},
): Promise<OracleReportResults> => {
  const depositedSinceLastReport = await getDepositedSinceLastReport(ctx);
  return report(ctx, { ...params, clDiff: depositedSinceLastReport + effectiveClDiff });
};

export const resetCLBalanceDecreaseWindow = async (
  ctx: ProtocolContext,
  params: Omit<OracleReportParams, "clDiff"> = {},
): Promise<OracleReportResults> => {
  // Move report timestamp beyond the 36-day window and submit an effective neutral report.
  await advanceChainTime(CL_BALANCE_DECREASE_WINDOW_RESET_SECONDS);
  return reportWithEffectiveClDiff(ctx, 0n, {
    excludeVaultsBalances: true,
    skipWithdrawals: true,
    ...params,
  });
};

export async function reportWithoutExtraData(
  ctx: ProtocolContext,
  numExitedValidatorsByStakingModule: bigint[],
  stakingModuleIdsWithNewlyExitedValidators: bigint[],
  extraData: ReturnType<typeof prepareExtraData>,
  {
    effectiveClDiff,
  }: {
    effectiveClDiff?: bigint;
  } = {},
) {
  const { accountingOracle } = ctx.contracts;

  const { extraDataItemsCount, extraDataChunks, extraDataChunkHashes } = extraData;

  const clDiff = effectiveClDiff === undefined ? undefined : (await getDepositedSinceLastReport(ctx)) + effectiveClDiff;

  const reportData: Partial<OracleReportParams> = {
    ...(clDiff === undefined ? {} : { clDiff }),
    excludeVaultsBalances: true,
    extraDataFormat: EXTRA_DATA_FORMAT_LIST,
    extraDataHash: extraDataChunkHashes[0],
    extraDataItemsCount: BigInt(extraDataItemsCount),
    numExitedValidatorsByStakingModule,
    stakingModuleIdsWithNewlyExitedValidators,
    skipWithdrawals: true,
  };

  const { data } = await report(ctx, { ...reportData, dryRun: true });

  const items = getReportDataItems(data);
  const hash = calcReportDataHash(items);
  const oracleVersion = await accountingOracle.getContractVersion();

  const submitter = await reachConsensus(ctx, {
    refSlot: BigInt(data.refSlot),
    reportHash: hash,
    consensusVersion: BigInt(data.consensusVersion),
  });

  const reportTx = await accountingOracle.connect(submitter).submitReportData(data, oracleVersion);
  log.debug("Pushed oracle report main data", {
    "Ref slot": data.refSlot,
    "Consensus version": data.consensusVersion,
    "Report hash": hash,
  });

  // Get processing state after main report is submitted
  const processingStateAfterMainReport = await accountingOracle.getProcessingState();

  // Verify that extra data is not yet submitted
  expect(processingStateAfterMainReport.extraDataSubmitted).to.be.false;
  expect(processingStateAfterMainReport.extraDataItemsCount).to.equal(extraDataItemsCount);
  expect(processingStateAfterMainReport.extraDataItemsSubmitted).to.equal(0n);

  return { reportTx, data, submitter, extraDataChunks, extraDataChunkHashes };
}

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

export const getNextReportContext = async (
  ctx: ProtocolContext,
): Promise<{ nextReportRefSlot: bigint; reportTimeElapsed: bigint }> => {
  const { accountingOracle, hashConsensus } = ctx.contracts;

  const lastProcessingRefSlot = await accountingOracle.getLastProcessingRefSlot();
  const currentFrame = await hashConsensus.getCurrentFrame();
  const frameConfig = await hashConsensus.getFrameConfig();
  const chainConfig = await hashConsensus.getChainConfig();

  const nextReportRefSlot = currentFrame.refSlot + frameConfig.epochsPerFrame * chainConfig.slotsPerEpoch;
  const reportTimeElapsed = (nextReportRefSlot - lastProcessingRefSlot) * chainConfig.secondsPerSlot;

  return { nextReportRefSlot, reportTimeElapsed };
};

/**
 * Wait for the next available report time.
 * Returns the report timestamp and the ref slot of the next frame.
 */
export const waitNextAvailableReportTime = async (
  ctx: ProtocolContext,
): Promise<{ reportTimestamp: bigint; reportRefSlot: bigint }> => {
  const { hashConsensus } = ctx.contracts;
  const { slotsPerEpoch } = await hashConsensus.getChainConfig();
  const { epochsPerFrame } = await hashConsensus.getFrameConfig();
  const { refSlot } = await hashConsensus.getCurrentFrame();

  const slotsPerFrame = slotsPerEpoch * epochsPerFrame;

  const { nextFrameStartWithOffset, timeElapsed, nextFrameStart } = await getReportTimeElapsed(ctx);

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

  return { reportTimestamp: nextFrameStart, reportRefSlot: nextFrame.refSlot };
};

type SimulateReportParams = {
  refSlot: bigint;
  clValidatorsBalance: bigint;
  clPendingBalance: bigint;
  withdrawalVaultBalance: bigint;
  elRewardsVaultBalance: bigint;
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
export const simulateReport = async (
  ctx: ProtocolContext,
  {
    refSlot,
    clValidatorsBalance,
    clPendingBalance,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
  }: SimulateReportParams,
): Promise<SimulateReportResult> => {
  const { hashConsensus, accounting } = ctx.contracts;

  const { genesisTime, secondsPerSlot } = await hashConsensus.getChainConfig();
  const reportTimestamp = genesisTime + refSlot * secondsPerSlot;

  log.debug("Simulating oracle report", {
    "Ref Slot": refSlot,
    "CL Validators Balance": formatEther(clValidatorsBalance),
    "CL Pending Balance": formatEther(clPendingBalance),
    "Withdrawal Vault Balance": formatEther(withdrawalVaultBalance),
    "El Rewards Vault Balance": formatEther(elRewardsVaultBalance),
  });

  // sharesRequestedToBurn must include redeem shares (they're nonCover on Burner)
  const [simCoverShares, simNonCoverShares] = await ctx.contracts.burner.getSharesRequestedToBurn();
  const simSharesRequestedToBurn = simCoverShares + simNonCoverShares;

  const reportValues: ReportValuesStruct = {
    timestamp: reportTimestamp,
    // timeElapsed: (await getReportTimeElapsed(ctx)).timeElapsed,
    timeElapsed: /* 1 day */ 86_400n,
    clValidatorsBalance,
    clPendingBalance,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    sharesRequestedToBurn: simSharesRequestedToBurn,
    withdrawalFinalizationBatches: [],
    simulatedShareRate: 10n ** 27n,
  };
  const update = await accounting.simulateOracleReport(reportValues);
  const { postTotalPooledEther, postTotalShares, withdrawalsVaultTransfer, elRewardsVaultTransfer } = update;

  log.debug("Simulation result", {
    "Post Total Pooled Ether": formatEther(postTotalPooledEther),
    "Post Total Shares": postTotalShares,
    "Withdrawals": formatEther(withdrawalsVaultTransfer),
    "El Rewards": formatEther(elRewardsVaultTransfer),
  });

  return {
    postTotalPooledEther,
    postTotalShares,
    withdrawals: withdrawalsVaultTransfer,
    elRewards: elRewardsVaultTransfer,
  };
};

type HandleOracleReportParams = {
  clBalance: bigint;
  sharesRequestedToBurn: bigint;
  withdrawalVaultBalance: bigint;
  elRewardsVaultBalance: bigint;
  vaultsDataTreeRoot: string;
  vaultsDataTreeCid: string;
};

export const handleOracleReport = async (
  ctx: ProtocolContext,
  {
    clBalance,
    sharesRequestedToBurn,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    vaultsDataTreeRoot,
    vaultsDataTreeCid,
  }: HandleOracleReportParams,
): Promise<void> => {
  const { hashConsensus, accountingOracle, accounting, lazyOracle } = ctx.contracts;

  const { refSlot } = await hashConsensus.getCurrentFrame();
  const { genesisTime, secondsPerSlot } = await hashConsensus.getChainConfig();
  const reportTimestamp = genesisTime + refSlot * secondsPerSlot;

  const accountingOracleAccount = await impersonate(accountingOracle.address, ether("100"));

  try {
    log.debug("Handle oracle report", {
      "Ref Slot": refSlot,
      "CL Balance": formatEther(clBalance),
      "Withdrawal Vault Balance": formatEther(withdrawalVaultBalance),
      "El Rewards Vault Balance": formatEther(elRewardsVaultBalance),
    });

    const { timeElapsed } = await getReportTimeElapsed(ctx);
    await accounting.connect(accountingOracleAccount).handleOracleReport({
      timestamp: reportTimestamp,
      timeElapsed, // 1 day
      clValidatorsBalance: clBalance,
      clPendingBalance: 0n,
      withdrawalVaultBalance,
      elRewardsVaultBalance,
      sharesRequestedToBurn,
      withdrawalFinalizationBatches: [],
      simulatedShareRate: 10n ** 27n,
    });

    await lazyOracle
      .connect(accountingOracleAccount)
      .updateReportData(reportTimestamp, refSlot, vaultsDataTreeRoot, vaultsDataTreeCid);
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
  const reservedBuffer = await lido.getWithdrawalsReserve();
  const availableEth = limitedWithdrawalVaultBalance + limitedElRewardsVaultBalance + reservedBuffer;

  const blockTimestamp = await getCurrentBlockTimestamp();
  const maxTimestamp = blockTimestamp - requestTimestampMargin;
  const MAX_REQUESTS_PER_CALL = 1000n;

  if (availableEth === 0n) {
    log.debug("No available ether to request withdrawals", {
      "Available Eth": formatEther(availableEth),
      "Reserved Buffer": formatEther(reservedBuffer),
      "Buffered Ether": formatEther(bufferedEther),
      "Unfinalized Steth": formatEther(unfinalizedSteth),
    });

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
  clPendingBalanceGwei?: bigint;
  withdrawalVaultBalance: bigint;
  elRewardsVaultBalance: bigint;
  sharesRequestedToBurn: bigint;
  stakingModuleIdsWithNewlyExitedValidators?: bigint[];
  numExitedValidatorsByStakingModule?: bigint[];
  stakingModuleIdsWithUpdatedBalance?: bigint[];
  validatorBalancesGweiByStakingModule?: bigint[];
  withdrawalFinalizationBatches?: bigint[];
  simulatedShareRate?: bigint;
  isBunkerMode?: boolean;
  vaultsDataTreeRoot?: string;
  vaultsDataTreeCid?: string;
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

export const submitReportDataWithConsensus = async (
  ctx: ProtocolContext,
  data: AccountingOracle.ReportDataStruct,
): Promise<ContractTransactionResponse> => {
  const { accountingOracle } = ctx.contracts;

  const reportHash = calcReportDataHash(getReportDataItems(data));
  const submitter = await reachConsensus(ctx, {
    refSlot: BigInt(data.refSlot),
    reportHash,
    consensusVersion: BigInt(data.consensusVersion),
  });
  const oracleVersion = await accountingOracle.getContractVersion();

  return accountingOracle.connect(submitter).submitReportData(data, oracleVersion);
};

export const submitReportDataWithConsensusAndEmptyExtraData = async (
  ctx: ProtocolContext,
  data: AccountingOracle.ReportDataStruct,
): Promise<{ reportTx: ContractTransactionResponse; extraDataTx: ContractTransactionResponse }> => {
  const { accountingOracle } = ctx.contracts;

  const reportHash = calcReportDataHash(getReportDataItems(data));
  const submitter = await reachConsensus(ctx, {
    refSlot: BigInt(data.refSlot),
    reportHash,
    consensusVersion: BigInt(data.consensusVersion),
  });
  const oracleVersion = await accountingOracle.getContractVersion();

  const reportTx = await accountingOracle.connect(submitter).submitReportData(data, oracleVersion);
  const extraDataTx = await accountingOracle.connect(submitter).submitReportExtraDataEmpty();

  return { reportTx, extraDataTx };
};

/**
 * Main function to push oracle report to the protocol.
 */
const submitReport = async (
  ctx: ProtocolContext,
  {
    refSlot,
    clBalance,
    clPendingBalanceGwei = 0n,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    sharesRequestedToBurn,
    stakingModuleIdsWithNewlyExitedValidators = [],
    numExitedValidatorsByStakingModule = [],
    stakingModuleIdsWithUpdatedBalance = [],
    validatorBalancesGweiByStakingModule = [],
    withdrawalFinalizationBatches = [],
    simulatedShareRate = 0n,
    isBunkerMode = false,
    vaultsDataTreeRoot = ZERO_BYTES32,
    vaultsDataTreeCid = "",
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
    // TODO: Add proper validator count logging
    "Withdrawal vault": formatEther(withdrawalVaultBalance),
    "El rewards vault": formatEther(elRewardsVaultBalance),
    "Shares requested to burn": sharesRequestedToBurn,
    "Staking module ids with newly exited validators": stakingModuleIdsWithNewlyExitedValidators,
    "Num exited validators by staking module": numExitedValidatorsByStakingModule,
    "Staking module ids with updated active balance": stakingModuleIdsWithUpdatedBalance,
    "Validator balances by staking module": validatorBalancesGweiByStakingModule,
    "CL pending balance (gwei)": clPendingBalanceGwei,
    "Withdrawal finalization batches": withdrawalFinalizationBatches,
    "Is bunker mode": isBunkerMode,
    "Vaults data tree root": vaultsDataTreeRoot,
    "Vaults data tree cid": vaultsDataTreeCid,
    "Extra data format": extraDataFormat,
    "Extra data hash": extraDataHash,
    "Extra data items count": extraDataItemsCount,
    "Extra data list": extraDataList,
  });

  const consensusVersion = await accountingOracle.getConsensusVersion();
  const oracleVersion = await accountingOracle.getContractVersion();
  const clBalanceGwei = clBalance / ONE_GWEI;
  if (clPendingBalanceGwei > clBalanceGwei) {
    throw new Error("Reported pending CL balance exceeds total CL balance");
  }

  const data = {
    consensusVersion,
    refSlot,
    clValidatorsBalanceGwei: clBalanceGwei - clPendingBalanceGwei,
    clPendingBalanceGwei,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    sharesRequestedToBurn,
    stakingModuleIdsWithNewlyExitedValidators,
    numExitedValidatorsByStakingModule,
    stakingModuleIdsWithUpdatedBalance,
    validatorBalancesGweiByStakingModule,
    withdrawalFinalizationBatches,
    simulatedShareRate,
    isBunkerMode,
    vaultsDataTreeRoot,
    vaultsDataTreeCid,
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
export const getReportDataItems = (data: AccountingOracle.ReportDataStruct) => [
  data.consensusVersion,
  data.refSlot,
  data.clValidatorsBalanceGwei,
  data.clPendingBalanceGwei,
  data.stakingModuleIdsWithNewlyExitedValidators,
  data.numExitedValidatorsByStakingModule,
  data.stakingModuleIdsWithUpdatedBalance,
  data.validatorBalancesGweiByStakingModule,
  data.withdrawalVaultBalance,
  data.elRewardsVaultBalance,
  data.sharesRequestedToBurn,
  data.withdrawalFinalizationBatches,
  data.simulatedShareRate,
  data.isBunkerMode,
  data.vaultsDataTreeRoot,
  data.vaultsDataTreeCid,
  data.extraDataFormat,
  data.extraDataHash,
  data.extraDataItemsCount,
];

/**
 * Helper function to calculate hash of the report data.
 */
export const calcReportDataHash = (items: ReturnType<typeof getReportDataItems>) => {
  const types = [
    "uint256", // consensusVersion
    "uint256", // refSlot
    // TODO: Update types to match new balance-based structure
    "uint256", // clValidatorsBalanceGwei
    "uint256", // clPendingBalanceGwei
    "uint256[]", // stakingModuleIdsWithNewlyExitedValidators
    "uint256[]", // numExitedValidatorsByStakingModule
    "uint256[]", // stakingModuleIdsWithUpdatedBalance
    "uint256[]", // validatorBalancesGweiByStakingModule
    "uint256", // withdrawalVaultBalance
    "uint256", // elRewardsVaultBalance
    "uint256", // sharesRequestedToBurn
    "uint256[]", // withdrawalFinalizationBatches
    "uint256", // simulatedShareRate
    "bool", // isBunkerMode
    "bytes32", // vaultsDataTreeRoot
    "string", // vaultsDataTreeCid
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
export const ensureOracleCommitteeMembers = async (ctx: ProtocolContext, minMembersCount: bigint, quorum: bigint) => {
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
    log(`Adding oracle committee member ${count}`);

    const address = getOracleCommitteeMemberAddress(count);
    if (!(await hashConsensus.getIsMember(address))) {
      await hashConsensus.connect(agentSigner).addMember(address, quorum);
    }

    addresses.push(address);

    log.debug(`Added oracle committee member`, { Count: count });

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
    log.debug("Initializing hash consensus epoch...", {
      "Initial epoch": initialEpoch,
    });

    const latestBlockTimestamp = await getCurrentBlockTimestamp();
    const { genesisTime, secondsPerSlot, slotsPerEpoch } = await hashConsensus.getChainConfig();
    const updatedInitialEpoch = (latestBlockTimestamp - genesisTime) / (slotsPerEpoch * secondsPerSlot);

    const agentSigner = await ctx.getSigner("agent");
    await hashConsensus.connect(agentSigner).updateInitialEpoch(updatedInitialEpoch);
  }
};
