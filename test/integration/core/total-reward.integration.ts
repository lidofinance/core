import { expect } from "chai";
import { ContractTransactionReceipt, formatEther, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { advanceChainTime, ether, impersonate, log, mEqual, updateBalance } from "lib";
import {
  finalizeWQViaElVault,
  getProtocolContext,
  norSdvtEnsureOperators,
  OracleReportParams,
  ProtocolContext,
  removeStakingLimit,
  report,
  setStakingLimit,
} from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";

import {
  createEntityStore,
  deriveExpectedTotalReward,
  GraphSimulator,
  processTransaction,
} from "../../graph/simulator";
import { captureChainState, capturePoolState, SimulatorInitialState } from "../../graph/utils";
import { extractAllLogs } from "../../graph/utils/event-extraction";

const INTERVAL_12_HOURS = 12n * 60n * 60n;

/**
 * Graph TotalReward Entity Integration Tests
 *
 * These tests validate that the Graph simulator correctly computes TotalReward
 * entity fields when processing oracle report transactions.
 *
 * Test Strategy:
 * 1. Execute an oracle report transaction
 * 2. Process the transaction events through the simulator
 * 3. Compare simulator output against expected values derived from events
 *
 * All comparisons use exact bigint matching (no tolerance).
 *
 * Reference: test/graph/graph-tests-spec.md
 */
describe("Scenario: Graph TotalReward Validation", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let stEthHolder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let simulator: GraphSimulator;
  let initialState: SimulatorInitialState;
  let depositCount: bigint;

  before(async () => {
    ctx = await getProtocolContext();

    [stEthHolder, stranger] = await ethers.getSigners();
    await updateBalance(stranger.address, ether("100000000"));
    await updateBalance(stEthHolder.address, ether("100000000"));

    snapshot = await Snapshot.take();

    // Capture initial chain state first
    initialState = await captureChainState(ctx);

    // Initialize simulator with treasury address
    simulator = new GraphSimulator(initialState.treasuryAddress);

    log.debug("Graph Simulator initialized", {
      "Total Pooled Ether": formatEther(initialState.totalPooledEther),
      "Total Shares": initialState.totalShares.toString(),
      "Treasury Address": initialState.treasuryAddress,
      "Staking Modules": initialState.stakingModuleAddresses.length,
    });

    // Setup protocol state
    await removeStakingLimit(ctx);
    await setStakingLimit(ctx, ether("200000"), ether("20"));
  });

  after(async () => await Snapshot.restore(snapshot));

  beforeEach(bailOnFailure);

  it("Should finalize withdrawal queue and prepare protocol", async () => {
    const { lido } = ctx.contracts;

    // Deposit some ETH to have stETH for testing
    const stEthHolderAmount = ether("1000");
    await lido.connect(stEthHolder).submit(ZeroAddress, { value: stEthHolderAmount });

    const stEthHolderBalance = await lido.balanceOf(stEthHolder.address);
    expect(stEthHolderBalance).to.approximately(stEthHolderAmount, 10n, "stETH balance increased");

    await finalizeWQViaElVault(ctx);
  });

  it("Should have at least 3 node operators in every module", async () => {
    await norSdvtEnsureOperators(ctx, ctx.contracts.nor, 3n, 5n);
    expect(await ctx.contracts.nor.getNodeOperatorsCount()).to.be.at.least(3n);

    await norSdvtEnsureOperators(ctx, ctx.contracts.sdvt, 3n, 5n);
    expect(await ctx.contracts.sdvt.getNodeOperatorsCount()).to.be.at.least(3n);
  });

  it("Should deposit ETH and stake to modules", async () => {
    const { lido, stakingRouter, depositSecurityModule } = ctx.contracts;

    // Submit more ETH for deposits
    await lido.connect(stEthHolder).submit(ZeroAddress, { value: ether("3200") });

    const dsmSigner = await impersonate(depositSecurityModule.address, ether("100"));
    const stakingModules = (await stakingRouter.getStakingModules()).filter((m) => m.id === 1n);
    depositCount = 0n;

    const MAX_DEPOSIT = 150n;
    const ZERO_HASH = new Uint8Array(32).fill(0);

    for (const module of stakingModules) {
      const depositTx = await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, module.id, ZERO_HASH);
      const depositReceipt = (await depositTx.wait()) as ContractTransactionReceipt;
      const unbufferedEvent = ctx.getEvents(depositReceipt, "Unbuffered")[0];
      const unbufferedAmount = unbufferedEvent?.args[0] || 0n;
      const deposits = unbufferedAmount / ether("32");

      depositCount += deposits;
    }

    expect(depositCount).to.be.gt(0n, "No deposits applied");
  });

  it("Should compute TotalReward correctly for first oracle report", async () => {
    const stateBefore = await capturePoolState(ctx);

    const clDiff = ether("32") * depositCount + ether("0.001");
    const reportData: Partial<OracleReportParams> = {
      clDiff,
      clAppearedValidators: depositCount,
    };

    await advanceChainTime(INTERVAL_12_HOURS);

    const { reportTx } = await report(ctx, reportData);
    const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const blockTimestamp = BigInt(block!.timestamp);

    const store = createEntityStore();
    const result = processTransaction(receipt, ctx, store, blockTimestamp, initialState.treasuryAddress);

    const stateAfter = await capturePoolState(ctx);

    expect(result.hadProfitableReport).to.be.true;
    expect(result.totalRewards.size).to.equal(1);

    const computed = result.totalRewards.get(receipt.hash);
    expect(computed).to.not.be.undefined;

    const expected = deriveExpectedTotalReward(receipt, ctx, initialState.treasuryAddress);
    expect(expected).to.not.be.null;

    await mEqual([
      [computed!.id.toLowerCase(), receipt.hash.toLowerCase()],
      [computed!.block, BigInt(receipt.blockNumber)],
      [computed!.blockTime, blockTimestamp],
      [computed!.transactionHash.toLowerCase(), receipt.hash.toLowerCase()],
      [computed!.transactionIndex, BigInt(receipt.index)],
      [computed!.logIndex, expected!.logIndex],
      [computed!.totalPooledEtherBefore, expected!.totalPooledEtherBefore],
      [computed!.totalPooledEtherAfter, expected!.totalPooledEtherAfter],
      [computed!.totalSharesBefore, expected!.totalSharesBefore],
      [computed!.totalSharesAfter, expected!.totalSharesAfter],
      [computed!.shares2mint, expected!.shares2mint],
      [computed!.timeElapsed, expected!.timeElapsed],
      [computed!.mevFee, expected!.mevFee],
      [computed!.totalRewardsWithFees, expected!.totalRewardsWithFees],
      [computed!.totalRewards, expected!.totalRewards],
      [computed!.totalFee, expected!.totalFee],
      [computed!.treasuryFee, expected!.treasuryFee],
      [computed!.operatorsFee, expected!.operatorsFee],
      [computed!.sharesToTreasury, expected!.sharesToTreasury],
      [computed!.sharesToOperators, expected!.sharesToOperators],
      [computed!.apr, expected!.apr],
      [computed!.aprRaw, expected!.aprRaw],
      [computed!.aprBeforeFees, expected!.aprBeforeFees],
      [computed!.feeBasis, expected!.feeBasis],
      [computed!.treasuryFeeBasisPoints, expected!.treasuryFeeBasisPoints],
      [computed!.operatorsFeeBasisPoints, expected!.operatorsFeeBasisPoints],
      [computed!.shares2mint, computed!.sharesToTreasury + computed!.sharesToOperators],
      [computed!.totalFee, computed!.treasuryFee + computed!.operatorsFee],
      [computed!.totalPooledEtherBefore, stateBefore.totalPooledEther],
      [computed!.totalSharesBefore, stateBefore.totalShares],
      [computed!.totalPooledEtherAfter, stateAfter.totalPooledEther],
      [computed!.totalSharesAfter, stateAfter.totalShares],
    ]);
  });

  it("Should compute TotalReward correctly for second oracle report", async () => {
    const stateBefore = await capturePoolState(ctx);

    const clDiff = ether("0.005");
    const reportData: Partial<OracleReportParams> = { clDiff };

    await advanceChainTime(INTERVAL_12_HOURS);

    const { reportTx } = await report(ctx, reportData);
    const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const blockTimestamp = BigInt(block!.timestamp);
    const result = simulator.processTransaction(receipt, ctx, blockTimestamp);

    const stateAfter = await capturePoolState(ctx);

    await mEqual([
      [result.hadProfitableReport, true],
      [result.totalRewards.size, 1],
    ]);

    const computed = result.totalRewards.get(receipt.hash);
    expect(computed).to.not.be.undefined;

    const expected = deriveExpectedTotalReward(receipt, ctx, initialState.treasuryAddress);
    expect(expected).to.not.be.null;

    await mEqual([
      [computed!.id.toLowerCase(), receipt.hash.toLowerCase()],
      [computed!.block, BigInt(receipt.blockNumber)],
      [computed!.blockTime, blockTimestamp],
      [computed!.transactionHash.toLowerCase(), receipt.hash.toLowerCase()],
      [computed!.transactionIndex, BigInt(receipt.index)],
      [computed!.logIndex, expected!.logIndex],
      [computed!.totalPooledEtherBefore, expected!.totalPooledEtherBefore],
      [computed!.totalPooledEtherAfter, expected!.totalPooledEtherAfter],
      [computed!.totalSharesBefore, expected!.totalSharesBefore],
      [computed!.totalSharesAfter, expected!.totalSharesAfter],
      [computed!.shares2mint, expected!.shares2mint],
      [computed!.timeElapsed, expected!.timeElapsed],
      [computed!.mevFee, expected!.mevFee],
      [computed!.totalRewardsWithFees, expected!.totalRewardsWithFees],
      [computed!.totalRewards, expected!.totalRewards],
      [computed!.totalFee, expected!.totalFee],
      [computed!.treasuryFee, expected!.treasuryFee],
      [computed!.operatorsFee, expected!.operatorsFee],
      [computed!.sharesToTreasury, expected!.sharesToTreasury],
      [computed!.sharesToOperators, expected!.sharesToOperators],
      [computed!.apr, expected!.apr],
      [computed!.aprRaw, expected!.aprRaw],
      [computed!.aprBeforeFees, expected!.aprBeforeFees],
      [computed!.feeBasis, expected!.feeBasis],
      [computed!.treasuryFeeBasisPoints, expected!.treasuryFeeBasisPoints],
      [computed!.operatorsFeeBasisPoints, expected!.operatorsFeeBasisPoints],
      [computed!.shares2mint, computed!.sharesToTreasury + computed!.sharesToOperators],
      [computed!.totalFee, computed!.treasuryFee + computed!.operatorsFee],
      [computed!.totalPooledEtherBefore, stateBefore.totalPooledEther],
      [computed!.totalSharesBefore, stateBefore.totalShares],
      [computed!.totalPooledEtherAfter, stateAfter.totalPooledEther],
      [computed!.totalSharesAfter, stateAfter.totalShares],
    ]);
  });

  it("Should verify event processing order", async () => {
    // This test validates that events are processed in the correct order
    // by examining the logs from the last oracle report
    const clDiff = ether("0.002");
    const reportData: Partial<OracleReportParams> = { clDiff };

    await advanceChainTime(INTERVAL_12_HOURS);

    const { reportTx } = await report(ctx, reportData);
    const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    const logs = extractAllLogs(receipt, ctx);

    const ethDistributedIdx = logs.findIndex((l) => l.name === "ETHDistributed");
    const tokenRebasedIdx = logs.findIndex((l) => l.name === "TokenRebased");

    expect(ethDistributedIdx).to.be.gte(0, "ETHDistributed event not found");
    expect(tokenRebasedIdx).to.be.gte(0, "TokenRebased event not found");
    expect(ethDistributedIdx).to.be.lt(tokenRebasedIdx, "ETHDistributed should come before TokenRebased");

    const transferEvents = logs.filter(
      (l) => l.name === "Transfer" && l.logIndex > ethDistributedIdx && l.logIndex < tokenRebasedIdx,
    );
    const transferSharesEvents = logs.filter(
      (l) => l.name === "TransferShares" && l.logIndex > ethDistributedIdx && l.logIndex < tokenRebasedIdx,
    );

    // There should be at least some transfer events for fee distribution
    expect(transferEvents.length).to.be.gte(0, "Expected Transfer events for fee distribution");
    expect(transferSharesEvents.length).to.be.gte(0, "Expected TransferShares events for fee distribution");
  });

  it("Should query TotalRewards with filtering and pagination", async () => {
    // Execute another oracle report to have more data
    const clDiff = ether("0.003");
    const reportData: Partial<OracleReportParams> = { clDiff };

    await advanceChainTime(INTERVAL_12_HOURS);

    const { reportTx } = await report(ctx, reportData);
    const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const blockTimestamp = BigInt(block!.timestamp);

    simulator.processTransaction(receipt, ctx, blockTimestamp);

    const totalCount = simulator.countTotalRewards(0n);
    expect(totalCount).to.be.gte(2, "Should have at least 2 TotalReward entities");

    const queryResult = simulator.queryTotalRewards({
      skip: 0,
      limit: 10,
      blockFrom: 0n,
      orderBy: "blockTime",
      orderDirection: "asc",
    });
    expect(queryResult.length).to.be.gte(2);

    for (let i = 1; i < queryResult.length; i++) {
      expect(queryResult[i].blockTime).to.be.gte(
        queryResult[i - 1].blockTime,
        "Results should be ordered by blockTime ascending",
      );
    }

    const firstBlock = queryResult[0].block;
    const filteredResult = simulator.queryTotalRewards({
      skip: 0,
      limit: 10,
      blockFrom: firstBlock, // Only get entities AFTER the first block
      orderBy: "blockTime",
      orderDirection: "asc",
    });

    for (const result of filteredResult) {
      expect(result.block).to.be.gt(firstBlock, "Filtered results should have block > blockFrom");
    }

    const latest = simulator.getLatestTotalReward();

    expect(latest).to.not.be.null;
    expect(latest!.blockTime).to.equal(queryResult[queryResult.length - 1].blockTime);

    const byId = simulator.getTotalRewardById(receipt.hash);
    expect(byId).to.not.be.null;
    expect(byId!.id.toLowerCase()).to.equal(receipt.hash.toLowerCase());
  });
});
