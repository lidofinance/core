import { expect } from "chai";
import { Result } from "ethers";
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
  trace,
} from "lib";

import { ProtocolContext } from "../types";

export type OracleReportOptions = {
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

export type OracleReportPushOptions = {
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
const MIN_MEMBERS_COUNT = 3n;

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
  } = {} as Partial<OracleReportOptions>,
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

  log.debug("Beacon", {
    "Beacon validators": postBeaconValidators,
    "Beacon balance": ethers.formatEther(postCLBalance),
  });

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
      simulatedShareRate,
      isBunkerMode,
      extraDataFormat,
      extraDataHash,
      extraDataItemsCount,
    } as AccountingOracle.ReportDataStruct;

    log.debug("Final Report (Dry Run)", {
      "Consensus version": reportData.consensusVersion,
      "Ref slot": reportData.refSlot,
      "CL balance": reportData.clBalanceGwei,
      "Num validators": reportData.numValidators,
      "Withdrawal vault balance": reportData.withdrawalVaultBalance,
      "EL rewards vault balance": reportData.elRewardsVaultBalance,
      "Shares requested to burn": reportData.sharesRequestedToBurn,
      "Withdrawal finalization batches": reportData.withdrawalFinalizationBatches,
      "Simulated share rate": reportData.simulatedShareRate,
      "Is bunker mode": reportData.isBunkerMode,
      "Extra data format": reportData.extraDataFormat,
      "Extra data hash": reportData.extraDataHash,
      "Extra data items count": reportData.extraDataItemsCount,
    });

    return { report: reportData, reportTx: undefined, extraDataTx: undefined };
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

  return submitReport(ctx, reportParams);
};

/**
 * Wait for the next available report time.
 */
export const waitNextAvailableReportTime = async (ctx: ProtocolContext): Promise<void> => {
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

  expect(nextFrame.refSlot).to.equal(refSlot + slotsPerFrame, "Next frame refSlot is incorrect");
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
};

export const handleOracleReport = async (
  ctx: ProtocolContext,
  params: {
    beaconValidators: bigint;
    clBalance: bigint;
    sharesRequestedToBurn: bigint;
    withdrawalVaultBalance: bigint;
    elRewardsVaultBalance: bigint;
  },
): Promise<void> => {
  const { hashConsensus, accountingOracle, lido } = ctx.contracts;
  const { beaconValidators, clBalance, sharesRequestedToBurn, withdrawalVaultBalance, elRewardsVaultBalance } = params;

  const { refSlot } = await hashConsensus.getCurrentFrame();
  const { genesisTime, secondsPerSlot } = await hashConsensus.getChainConfig();
  const reportTimestamp = genesisTime + refSlot * secondsPerSlot;

  const accountingOracleAccount = await impersonate(accountingOracle.address, ether("100"));

  try {
    log.debug("Handle oracle report", {
      "Ref Slot": refSlot,
      "Beacon Validators": beaconValidators,
      "CL Balance": ethers.formatEther(clBalance),
      "Withdrawal Vault Balance": ethers.formatEther(withdrawalVaultBalance),
      "El Rewards Vault Balance": ethers.formatEther(elRewardsVaultBalance),
    });

    const handleReportTx = await lido
      .connect(accountingOracleAccount)
      .handleOracleReport(
        reportTimestamp,
        1n * 24n * 60n * 60n, // 1 day
        beaconValidators,
        clBalance,
        withdrawalVaultBalance,
        elRewardsVaultBalance,
        sharesRequestedToBurn,
        [],
        0n,
      );

    await trace("lido.handleOracleReport", handleReportTx);
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
export const submitReport = async (
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

  const data = {
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
  } as AccountingOracle.ReportDataStruct;

  const items = getReportDataItems(data);
  const hash = calcReportDataHash(items);

  const submitter = await reachConsensus(ctx, {
    refSlot,
    reportHash: hash,
    consensusVersion,
  });

  log.debug("Pushing oracle report", data);

  const reportTx = await accountingOracle.connect(submitter).submitReportData(data, oracleVersion);
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

  return { report, reportTx, extraDataTx };
};

/**
 * Ensure that the oracle committee has the required number of members.
 */
export const ensureOracleCommitteeMembers = async (
  ctx: ProtocolContext,
  minMembersCount = MIN_MEMBERS_COUNT,
) => {
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
    const addTx = await hashConsensus.connect(agentSigner).addMember(address, minMembersCount);
    await trace("hashConsensus.addMember", addTx);

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

export const ensureHashConsensusInitialEpoch = async (ctx: ProtocolContext) => {
  const { hashConsensus } = ctx.contracts;

  const { initialEpoch } = await hashConsensus.getFrameConfig();
  if (initialEpoch === HASH_CONSENSUS_FAR_FUTURE_EPOCH) {
    log.warning("Initializing hash consensus epoch...");

    const latestBlockTimestamp = await getCurrentBlockTimestamp();
    const { genesisTime, secondsPerSlot, slotsPerEpoch } = await hashConsensus.getChainConfig();
    const updatedInitialEpoch = (latestBlockTimestamp - genesisTime) / (slotsPerEpoch * secondsPerSlot);

    const agentSigner = await ctx.getSigner("agent");

    const tx = await hashConsensus.connect(agentSigner).updateInitialEpoch(updatedInitialEpoch);
    await trace("hashConsensus.updateInitialEpoch", tx);

    log.success("Hash consensus epoch initialized");
  }
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
  data.simulatedShareRate,
  data.isBunkerMode,
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
    "uint256", // simulatedShareRate
    "bool", // isBunkerMode
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
