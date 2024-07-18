import { expect } from "chai";
import { Result } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { AccountingOracle } from "typechain-types";

import {
  advanceChainTime,
  BigIntMath,
  ether,
  EXTRA_DATA_FORMAT_EMPTY,
  getCurrentBlockTimestamp,
  impersonate,
  log,
  ONE_GWEI,
  trace,
} from "lib";

import { ProtocolContext } from "../types";

type OracleReportPrepareOptions = {
  clDiff: bigint;
  clAppearedValidators: bigint;
  elRewardsVaultBalance: bigint | null;
  withdrawalVaultBalance: bigint | null;
  sharesRequestedToBurn: bigint | null;
  withdrawalFinalizationBatches: bigint[];
  simulatedShareRate: bigint | null;
  refSlot: bigint | null;
  dryRun: boolean;
  excludeVaultsBalances: boolean;
  skipWithdrawals: boolean;
  waitNextReportTime: boolean;
  extraDataFormat: bigint;
  extraDataHash: string;
  extraDataItemsCount: bigint;
  extraDataList: Uint8Array;
  stakingModuleIdsWithNewlyExitedValidators: bigint[];
  numExitedValidatorsByStakingModule: bigint[];
  reportElVault: boolean;
  reportWithdrawalsVault: boolean;
  silent: boolean;
};

type OracleReportPushOptions = {
  refSlot: bigint;
  clBalance: bigint;
  numValidators: bigint;
  withdrawalVaultBalance: bigint;
  elRewardsVaultBalance: bigint;
  sharesRequestedToBurn: bigint;
  simulatedShareRate: bigint;
  stakingModuleIdsWithNewlyExitedValidators?: bigint[];
  numExitedValidatorsByStakingModule?: bigint[];
  withdrawalFinalizationBatches?: bigint[];
  isBunkerMode?: boolean;
  extraDataFormat?: bigint;
  extraDataHash?: string;
  extraDataItemsCount?: bigint;
  extraDataList?: Uint8Array;
};

const ZERO_HASH = new Uint8Array(32).fill(0);
const ZERO_BYTES32 = "0x" + Buffer.from(ZERO_HASH).toString("hex");
const SHARE_RATE_PRECISION = 10n ** 27n;

/**
 * Prepare and push oracle report.
 */
export const oracleReport = async (
  ctx: ProtocolContext,
  {
    clDiff = ether("10"),
    clAppearedValidators = 0n,
    elRewardsVaultBalance = null,
    withdrawalVaultBalance = null,
    sharesRequestedToBurn = null,
    withdrawalFinalizationBatches = [],
    simulatedShareRate = null,
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
  } = {} as Partial<OracleReportPrepareOptions>,
) => {
  const { hashConsensus, lido, elRewardsVault, withdrawalVault, burner, accountingOracle } = ctx.contracts;

  // Fast-forward to next report time
  if (waitNextReportTime) {
    await waitNextAvailableReportTime(ctx);
  }

  // Get report slot from the protocol
  if (!refSlot) {
    ({ refSlot } = await hashConsensus.getCurrentFrame());
  }

  const { beaconValidators, beaconBalance } = await lido.getBeaconStat();
  const postCLBalance = beaconBalance + clDiff;
  const postBeaconValidators = beaconValidators + clAppearedValidators;

  elRewardsVaultBalance = elRewardsVaultBalance ?? (await ethers.provider.getBalance(elRewardsVault.address));
  withdrawalVaultBalance = withdrawalVaultBalance ?? (await ethers.provider.getBalance(withdrawalVault.address));

  log.debug("Balances", {
    "Withdrawal vault": ethers.formatEther(withdrawalVaultBalance),
    "ElRewards vault": ethers.formatEther(elRewardsVaultBalance),
  });

  // excludeVaultsBalance safely forces LIDO to see vault balances as empty allowing zero/negative rebase
  // simulateReports needs proper withdrawal and elRewards vaults balances

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
    "Withdrawal vault": ethers.formatEther(withdrawalVaultBalance),
    "ElRewards vault": ethers.formatEther(elRewardsVaultBalance),
  });

  let isBunkerMode = false;

  if (!skipWithdrawals) {
    const params = {
      refSlot,
      beaconValidators: postBeaconValidators,
      clBalance: postCLBalance,
      withdrawalVaultBalance,
      elRewardsVaultBalance,
    };

    const simulatedReport = await simulateReport(ctx, params);

    expect(simulatedReport).to.not.be.undefined;

    const { postTotalPooledEther, postTotalShares, withdrawals, elRewards } = simulatedReport!;

    log.debug("Simulated report", {
      "Post Total Pooled Ether": ethers.formatEther(postTotalPooledEther),
      "Post Total Shares": postTotalShares,
      "Withdrawals": ethers.formatEther(withdrawals),
      "El Rewards": ethers.formatEther(elRewards),
    });

    if (simulatedShareRate === null) {
      simulatedShareRate = (postTotalPooledEther * SHARE_RATE_PRECISION) / postTotalShares;
    }

    if (withdrawalFinalizationBatches.length === 0) {
      withdrawalFinalizationBatches = await getFinalizationBatches(ctx, {
        shareRate: simulatedShareRate,
        limitedWithdrawalVaultBalance: withdrawals,
        limitedElRewardsVaultBalance: elRewards,
      });
    }

    isBunkerMode = (await lido.getTotalPooledEther()) > postTotalPooledEther;

    log.debug("Bunker Mode", { "Is Active": isBunkerMode });
  } else if (simulatedShareRate === null) {
    simulatedShareRate = 0n;
  }

  if (dryRun) {
    const report = {
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
      simulatedShareRate,
      isBunkerMode,
      extraDataFormat,
      extraDataHash,
      extraDataItemsCount,
    } as AccountingOracle.ReportDataStruct;

    log.debug("Final Report (Dry Run)", {
      "Consensus version": report.consensusVersion,
      "Ref slot": report.refSlot,
      "CL balance": report.clBalanceGwei,
      "Num validators": report.numValidators,
      "Withdrawal vault balance": report.withdrawalVaultBalance,
      "EL rewards vault balance": report.elRewardsVaultBalance,
      "Shares requested to burn": report.sharesRequestedToBurn,
      "Withdrawal finalization batches": report.withdrawalFinalizationBatches,
      "Simulated share rate": report.simulatedShareRate,
      "Is bunker mode": report.isBunkerMode,
      "Extra data format": report.extraDataFormat,
      "Extra data hash": report.extraDataHash,
      "Extra data items count": report.extraDataItemsCount,
    });

    return { report, reportTx: undefined, extraDataTx: undefined };
  }

  const reportParams = {
    refSlot,
    clBalance: postCLBalance,
    numValidators: postBeaconValidators,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    sharesRequestedToBurn,
    simulatedShareRate,
    stakingModuleIdsWithNewlyExitedValidators,
    numExitedValidatorsByStakingModule,
    withdrawalFinalizationBatches,
    isBunkerMode,
    extraDataFormat,
    extraDataHash,
    extraDataItemsCount,
    extraDataList,
  };

  return pushOracleReport(ctx, reportParams);
};

/**
 * Wait for the next available report time.
 */
const waitNextAvailableReportTime = async (ctx: ProtocolContext): Promise<void> => {
  const { hashConsensus } = ctx.contracts;
  const { slotsPerEpoch, secondsPerSlot, genesisTime } = await hashConsensus.getChainConfig();
  const { refSlot } = await hashConsensus.getCurrentFrame();

  const time = await getCurrentBlockTimestamp();

  const { epochsPerFrame } = await hashConsensus.getFrameConfig();

  log.debug("Current frame", {
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

  const timeToAdvance = Number(nextFrameStartWithOffset - time);

  await advanceChainTime(timeToAdvance);

  const timeAfterAdvance = await getCurrentBlockTimestamp();

  const nextFrame = await hashConsensus.getCurrentFrame();

  log.debug("Next frame", {
    "Next ref slot": nextRefSlot,
    "Next frame date": new Date(Number(nextFrameStart) * 1000).toUTCString(),
    "Time to advance": timeToAdvance,
    "Time after advance": timeAfterAdvance,
    "Time after advance date": new Date(Number(timeAfterAdvance) * 1000).toUTCString(),
    "Ref slot": nextFrame.refSlot,
  });

  expect(nextFrame.refSlot).to.be.equal(refSlot + slotsPerFrame, "Next frame refSlot is incorrect");
};

/**
 * Simulate oracle report to get the expected result.
 */
const simulateReport = async (
  ctx: ProtocolContext,
  params: {
    refSlot: bigint;
    beaconValidators: bigint;
    clBalance: bigint;
    withdrawalVaultBalance: bigint;
    elRewardsVaultBalance: bigint;
  },
): Promise<
  { postTotalPooledEther: bigint; postTotalShares: bigint; withdrawals: bigint; elRewards: bigint } | undefined
> => {
  const { hashConsensus, accountingOracle, lido } = ctx.contracts;
  const { refSlot, beaconValidators, clBalance, withdrawalVaultBalance, elRewardsVaultBalance } = params;

  const { genesisTime, secondsPerSlot } = await hashConsensus.getChainConfig();
  const reportTimestamp = genesisTime + refSlot * secondsPerSlot;

  const accountingOracleAccount = await impersonate(accountingOracle.address, ether("100"));

  try {
    log.debug("Simulating oracle report", {
      "Ref Slot": refSlot,
      "Beacon Validators": beaconValidators,
      "CL Balance": ethers.formatEther(clBalance),
      "Withdrawal Vault Balance": ethers.formatEther(withdrawalVaultBalance),
      "El Rewards Vault Balance": ethers.formatEther(elRewardsVaultBalance),
    });

    const [postTotalPooledEther, postTotalShares, withdrawals, elRewards] = await lido
      .connect(accountingOracleAccount)
      .handleOracleReport.staticCall(
        reportTimestamp,
        1n * 24n * 60n * 60n, // 1 day
        beaconValidators,
        clBalance,
        withdrawalVaultBalance,
        elRewardsVaultBalance,
        0n,
        [],
        0n,
      );

    log.debug("Simulation result", {
      "Post Total Pooled Ether": ethers.formatEther(postTotalPooledEther),
      "Post Total Shares": postTotalShares,
      "Withdrawals": ethers.formatEther(withdrawals),
      "El Rewards": ethers.formatEther(elRewards),
    });

    return { postTotalPooledEther, postTotalShares, withdrawals, elRewards };
  } catch (error) {
    log.error("Error", (error as Error).message ?? "Unknown error during oracle report simulation");
    expect(error).to.be.undefined;
  }
};

/**
 * Get finalization batches to finalize withdrawals.
 */
const getFinalizationBatches = async (
  ctx: ProtocolContext,
  params: {
    shareRate: bigint;
    limitedWithdrawalVaultBalance: bigint;
    limitedElRewardsVaultBalance: bigint;
  },
): Promise<bigint[]> => {
  const { oracleReportSanityChecker, lido, withdrawalQueue } = ctx.contracts;
  const { shareRate, limitedWithdrawalVaultBalance, limitedElRewardsVaultBalance } = params;

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
    "Available Eth": ethers.formatEther(availableEth),
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

/**
 * Main function to push oracle report to the protocol.
 */
export const pushOracleReport = async (
  ctx: ProtocolContext,
  {
    refSlot,
    clBalance,
    numValidators,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    sharesRequestedToBurn,
    simulatedShareRate,
    stakingModuleIdsWithNewlyExitedValidators = [],
    numExitedValidatorsByStakingModule = [],
    withdrawalFinalizationBatches = [],
    isBunkerMode = false,
    extraDataFormat = 0n,
    extraDataHash = ZERO_BYTES32,
    extraDataItemsCount = 0n,
    extraDataList = new Uint8Array(),
  } = {} as OracleReportPushOptions,
) => {
  const { accountingOracle } = ctx.contracts;

  log.debug("Pushing oracle report", {
    "Ref slot": refSlot,
    "CL balance": ethers.formatEther(clBalance),
    "Validators": numValidators,
    "Withdrawal vault": ethers.formatEther(withdrawalVaultBalance),
    "El rewards vault": ethers.formatEther(elRewardsVaultBalance),
    "Shares requested to burn": sharesRequestedToBurn,
    "Simulated share rate": simulatedShareRate,
    "Staking module ids with newly exited validators": stakingModuleIdsWithNewlyExitedValidators,
    "Num exited validators by staking module": numExitedValidatorsByStakingModule,
    "Withdrawal finalization batches": withdrawalFinalizationBatches,
    "Is bunker mode": isBunkerMode,
    "Extra data format": extraDataFormat,
    "Extra data hash": extraDataHash,
    "Extra data items count": extraDataItemsCount,
    "Extra data list": extraDataList,
  });

  const consensusVersion = await accountingOracle.getConsensusVersion();
  const oracleVersion = await accountingOracle.getContractVersion();

  const { report, hash } = prepareOracleReport({
    consensusVersion,
    refSlot,
    clBalanceGwei: clBalance / ONE_GWEI,
    numValidators,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    sharesRequestedToBurn,
    simulatedShareRate,
    stakingModuleIdsWithNewlyExitedValidators,
    numExitedValidatorsByStakingModule,
    withdrawalFinalizationBatches,
    isBunkerMode,
    extraDataFormat,
    extraDataHash,
    extraDataItemsCount,
  });

  const submitter = await reachConsensus(ctx, {
    refSlot,
    reportHash: hash,
    consensusVersion,
  });

  const reportTx = await accountingOracle.connect(submitter).submitReportData(report, oracleVersion);
  await trace("accountingOracle.submitReportData", reportTx);

  log.debug("Pushing oracle report", {
    "Ref slot": refSlot,
    "Consensus version": consensusVersion,
    "Report hash": hash,
  });

  let extraDataTx;
  if (extraDataFormat) {
    extraDataTx = await accountingOracle.connect(submitter).submitReportExtraDataList(extraDataList);
    await trace("accountingOracle.submitReportExtraDataList", extraDataTx);
  } else {
    extraDataTx = await accountingOracle.connect(submitter).submitReportExtraDataEmpty();
    await trace("accountingOracle.submitReportExtraDataEmpty", extraDataTx);
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

  expect(state.currentFrameRefSlot).to.be.equal(refSlot, "Processing state ref slot is incorrect");
  expect(state.mainDataHash).to.be.equal(hash, "Processing state main data hash is incorrect");
  expect(state.mainDataSubmitted).to.be.true;
  expect(state.extraDataHash).to.be.equal(extraDataHash, "Processing state extra data hash is incorrect");
  expect(state.extraDataFormat).to.be.equal(extraDataFormat, "Processing state extra data format is incorrect");
  expect(state.extraDataSubmitted).to.be.true;
  expect(state.extraDataItemsCount).to.be.equal(
    extraDataItemsCount,
    "Processing state extra data items count is incorrect",
  );
  expect(state.extraDataItemsSubmitted).to.be.equal(
    extraDataItemsCount,
    "Processing state extra data items submitted is incorrect",
  );

  log.debug("Oracle report pushed", {
    "Ref slot": refSlot,
    "Consensus version": consensusVersion,
    "Report hash": hash,
  });

  return { report, reportTx, extraDataTx };
};

/**
 * Submit reports from all fast lane members to reach consensus on the report.
 */
const reachConsensus = async (
  ctx: ProtocolContext,
  params: {
    refSlot: bigint;
    reportHash: string;
    consensusVersion: bigint;
  },
) => {
  const { hashConsensus } = ctx.contracts;
  const { refSlot, reportHash, consensusVersion } = params;

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

    const tx = await hashConsensus.connect(member).submitReport(refSlot, reportHash, consensusVersion);
    await trace("hashConsensus.submitReport", tx);
  }

  const { consensusReport } = await hashConsensus.getConsensusState();

  log.debug("Reaching consensus", {
    "Consensus report": consensusReport,
    "Report hash": reportHash,
  });

  expect(consensusReport).to.be.equal(reportHash, "Consensus report hash is incorrect");

  return submitter as HardhatEthersSigner;
};

/**
 * Helper function to prepare oracle report data in the required format with hash.
 */
const prepareOracleReport = (report: AccountingOracle.ReportDataStruct) => {
  const items = getReportDataItems(report);
  const hash = calcReportDataHash(items);
  return { report, items, hash };
};

/**
 * Helper function to get report data items in the required order.
 */
const getReportDataItems = (report: AccountingOracle.ReportDataStruct) => [
  report.consensusVersion,
  report.refSlot,
  report.numValidators,
  report.clBalanceGwei,
  report.stakingModuleIdsWithNewlyExitedValidators,
  report.numExitedValidatorsByStakingModule,
  report.withdrawalVaultBalance,
  report.elRewardsVaultBalance,
  report.sharesRequestedToBurn,
  report.withdrawalFinalizationBatches,
  report.simulatedShareRate,
  report.isBunkerMode,
  report.extraDataFormat,
  report.extraDataHash,
  report.extraDataItemsCount,
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
    "uint256", // simulatedShareRate
    "bool", // isBunkerMode
    "uint256", // extraDataFormat
    "bytes32", // extraDataHash
    "uint256", // extraDataItemsCount
  ];

  const data = ethers.AbiCoder.defaultAbiCoder().encode([`(${types.join(",")})`], [items]);
  return ethers.keccak256(data);
};
