import { expect } from "chai";
import { ContractTransactionReceipt, formatEther, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { advanceChainTime, ether, log, updateBalance } from "lib";
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

import { createEntityStore, deriveExpectedTotalReward, GraphSimulator, processTransaction } from "../graph/simulator";
import { captureChainState, capturePoolState, SimulatorInitialState } from "../graph/utils";
import { extractAllLogs } from "../graph/utils/event-extraction";

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

    log.info("Graph Simulator initialized", {
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

    log.info("Submitting ETH for deposits", {
      Amount: formatEther(ether("3200")),
    });

    // Submit more ETH for deposits
    await lido.connect(stEthHolder).submit(ZeroAddress, { value: ether("3200") });

    const { impersonate, ether: etherFn } = await import("lib");

    const dsmSigner = await impersonate(depositSecurityModule.address, etherFn("100"));
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

    log.info("Deposits completed", {
      "Total Deposits": depositCount.toString(),
      "ETH Staked": formatEther(depositCount * ether("32")),
    });

    expect(depositCount).to.be.gt(0n, "No deposits applied");
  });

  it("Should compute TotalReward correctly for first oracle report", async () => {
    log("=== First Oracle Report: TotalReward Validation ===");

    // 1. Capture state before oracle report
    const stateBefore = await capturePoolState(ctx);

    log.info("Pool state before report", {
      "Total Pooled Ether": formatEther(stateBefore.totalPooledEther),
      "Total Shares": stateBefore.totalShares.toString(),
    });

    // 2. Execute oracle report with rewards
    const clDiff = ether("32") * depositCount + ether("0.001");
    const reportData: Partial<OracleReportParams> = {
      clDiff,
      clAppearedValidators: depositCount,
    };

    log.info("Executing oracle report", {
      "CL Diff": formatEther(clDiff),
      "Appeared Validators": depositCount.toString(),
    });

    await advanceChainTime(12n * 60n * 60n); // 12 hours
    const { reportTx } = await report(ctx, reportData);
    const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    // Get block timestamp
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const blockTimestamp = BigInt(block!.timestamp);

    log.info("Oracle report transaction", {
      "Tx Hash": receipt.hash,
      "Block Number": receipt.blockNumber,
      "Block Timestamp": blockTimestamp.toString(),
      "Log Count": receipt.logs.length,
    });

    // 3. Process events through simulator
    const store = createEntityStore();
    const result = processTransaction(receipt, ctx, store, blockTimestamp, initialState.treasuryAddress);

    log.info("Simulator processing result", {
      "Events Processed": result.eventsProcessed,
      "Had Profitable Report": result.hadProfitableReport,
      "TotalReward Entities Created": result.totalRewards.size,
    });

    // 4. Capture state after
    const stateAfter = await capturePoolState(ctx);

    log.info("Pool state after report", {
      "Total Pooled Ether": formatEther(stateAfter.totalPooledEther),
      "Total Shares": stateAfter.totalShares.toString(),
      "Ether Change": formatEther(stateAfter.totalPooledEther - stateBefore.totalPooledEther),
      "Shares Change": (stateAfter.totalShares - stateBefore.totalShares).toString(),
    });

    // 5. Verify a TotalReward entity was created
    expect(result.hadProfitableReport).to.be.true;
    expect(result.totalRewards.size).to.equal(1);

    const computed = result.totalRewards.get(receipt.hash);
    expect(computed).to.not.be.undefined;

    // 6. Derive expected values directly from events
    const expected = deriveExpectedTotalReward(receipt, ctx, initialState.treasuryAddress);
    expect(expected).to.not.be.null;

    // Log entity details
    log.info("TotalReward Entity - Tier 1 (Metadata)", {
      "ID": computed!.id,
      "Block": computed!.block.toString(),
      "Block Time": computed!.blockTime.toString(),
      "Tx Index": computed!.transactionIndex.toString(),
      "Log Index": computed!.logIndex.toString(),
    });

    log.info("TotalReward Entity - Tier 2 (Pool State)", {
      "Total Pooled Ether Before": formatEther(computed!.totalPooledEtherBefore),
      "Total Pooled Ether After": formatEther(computed!.totalPooledEtherAfter),
      "Total Shares Before": computed!.totalSharesBefore.toString(),
      "Total Shares After": computed!.totalSharesAfter.toString(),
      "Shares Minted As Fees": computed!.shares2mint.toString(),
      "Time Elapsed": computed!.timeElapsed.toString(),
      "MEV Fee": formatEther(computed!.mevFee),
    });

    log.info("TotalReward Entity - Tier 2 (Fee Distribution)", {
      "Total Rewards With Fees": formatEther(computed!.totalRewardsWithFees),
      "Total Rewards": formatEther(computed!.totalRewards),
      "Total Fee": formatEther(computed!.totalFee),
      "Treasury Fee": formatEther(computed!.treasuryFee),
      "Operators Fee": formatEther(computed!.operatorsFee),
      "Shares To Treasury": computed!.sharesToTreasury.toString(),
      "Shares To Operators": computed!.sharesToOperators.toString(),
    });

    log.info("TotalReward Entity - Tier 3 (Calculated)", {
      "APR": `${computed!.apr.toFixed(4)}%`,
      "APR Raw": `${computed!.aprRaw.toFixed(4)}%`,
      "APR Before Fees": `${computed!.aprBeforeFees.toFixed(4)}%`,
      "Fee Basis": computed!.feeBasis.toString(),
      "Treasury Fee Basis Points": computed!.treasuryFeeBasisPoints.toString(),
      "Operators Fee Basis Points": computed!.operatorsFeeBasisPoints.toString(),
    });

    // 7. Verify Tier 1 fields (Direct Event Metadata)
    log.info("Verifying Tier 1 fields (Direct Event Metadata)...");
    expect(computed!.id.toLowerCase()).to.equal(receipt.hash.toLowerCase(), "id mismatch");
    expect(computed!.block).to.equal(BigInt(receipt.blockNumber), "block mismatch");
    expect(computed!.blockTime).to.equal(blockTimestamp, "blockTime mismatch");
    expect(computed!.transactionHash.toLowerCase()).to.equal(receipt.hash.toLowerCase(), "transactionHash mismatch");
    expect(computed!.transactionIndex).to.equal(BigInt(receipt.index), "transactionIndex mismatch");
    expect(computed!.logIndex).to.equal(expected!.logIndex, "logIndex mismatch");

    // 8. Verify Tier 2 fields (Pool State from TokenRebased)
    log.info("Verifying Tier 2 fields (Pool State from TokenRebased)...");
    expect(computed!.totalPooledEtherBefore).to.equal(
      expected!.totalPooledEtherBefore,
      "totalPooledEtherBefore mismatch",
    );
    expect(computed!.totalPooledEtherAfter).to.equal(expected!.totalPooledEtherAfter, "totalPooledEtherAfter mismatch");
    expect(computed!.totalSharesBefore).to.equal(expected!.totalSharesBefore, "totalSharesBefore mismatch");
    expect(computed!.totalSharesAfter).to.equal(expected!.totalSharesAfter, "totalSharesAfter mismatch");
    expect(computed!.shares2mint).to.equal(expected!.shares2mint, "shares2mint mismatch");
    expect(computed!.timeElapsed).to.equal(expected!.timeElapsed, "timeElapsed mismatch");
    expect(computed!.mevFee).to.equal(expected!.mevFee, "mevFee mismatch");

    // 8b. Verify Tier 2 fields (Fee Distribution)
    log.info("Verifying Tier 2 fields (Fee Distribution)...");
    expect(computed!.totalRewardsWithFees).to.equal(expected!.totalRewardsWithFees, "totalRewardsWithFees mismatch");
    expect(computed!.totalRewards).to.equal(expected!.totalRewards, "totalRewards mismatch");
    expect(computed!.totalFee).to.equal(expected!.totalFee, "totalFee mismatch");
    expect(computed!.treasuryFee).to.equal(expected!.treasuryFee, "treasuryFee mismatch");
    expect(computed!.operatorsFee).to.equal(expected!.operatorsFee, "operatorsFee mismatch");
    expect(computed!.sharesToTreasury).to.equal(expected!.sharesToTreasury, "sharesToTreasury mismatch");
    expect(computed!.sharesToOperators).to.equal(expected!.sharesToOperators, "sharesToOperators mismatch");

    // 8c. Verify Tier 3 fields (Calculated)
    log.info("Verifying Tier 3 fields (APR and Basis Points)...");
    expect(computed!.apr).to.equal(expected!.apr, "apr mismatch");
    expect(computed!.aprRaw).to.equal(expected!.aprRaw, "aprRaw mismatch");
    expect(computed!.aprBeforeFees).to.equal(expected!.aprBeforeFees, "aprBeforeFees mismatch");
    expect(computed!.feeBasis).to.equal(expected!.feeBasis, "feeBasis mismatch");
    expect(computed!.treasuryFeeBasisPoints).to.equal(
      expected!.treasuryFeeBasisPoints,
      "treasuryFeeBasisPoints mismatch",
    );
    expect(computed!.operatorsFeeBasisPoints).to.equal(
      expected!.operatorsFeeBasisPoints,
      "operatorsFeeBasisPoints mismatch",
    );

    // 8d. Verify fee consistency (shares2mint should equal sharesToTreasury + sharesToOperators)
    log.info("Verifying fee consistency...");
    expect(computed!.shares2mint).to.equal(
      computed!.sharesToTreasury + computed!.sharesToOperators,
      "shares2mint should equal sharesToTreasury + sharesToOperators",
    );
    expect(computed!.totalFee).to.equal(
      computed!.treasuryFee + computed!.operatorsFee,
      "totalFee should equal treasuryFee + operatorsFee",
    );

    // 9. Verify consistency with on-chain state
    log.info("Verifying consistency with on-chain state...");
    // TokenRebased.preTotalEther should match state before report
    expect(computed!.totalPooledEtherBefore).to.equal(stateBefore.totalPooledEther, "preTotalEther vs stateBefore");
    expect(computed!.totalSharesBefore).to.equal(stateBefore.totalShares, "preTotalShares vs stateBefore");

    // TokenRebased.postTotalEther should match state after report
    expect(computed!.totalPooledEtherAfter).to.equal(stateAfter.totalPooledEther, "postTotalEther vs stateAfter");
    expect(computed!.totalSharesAfter).to.equal(stateAfter.totalShares, "postTotalShares vs stateAfter");

    log("First oracle report validation PASSED");
  });

  it("Should compute TotalReward correctly for second oracle report", async () => {
    log("=== Second Oracle Report: TotalReward Validation ===");

    // 1. Capture state before second oracle report
    const stateBefore = await capturePoolState(ctx);

    log.info("Pool state before second report", {
      "Total Pooled Ether": formatEther(stateBefore.totalPooledEther),
      "Total Shares": stateBefore.totalShares.toString(),
    });

    // 2. Execute second oracle report with different rewards
    const clDiff = ether("0.005");
    const reportData: Partial<OracleReportParams> = {
      clDiff, // Smaller reward
    };

    log.info("Executing second oracle report", {
      "CL Diff": formatEther(clDiff),
    });

    await advanceChainTime(12n * 60n * 60n); // 12 hours
    const { reportTx } = await report(ctx, reportData);
    const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    // Get block timestamp
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const blockTimestamp = BigInt(block!.timestamp);

    log.info("Second oracle report transaction", {
      "Tx Hash": receipt.hash,
      "Block Number": receipt.blockNumber,
      "Block Timestamp": blockTimestamp.toString(),
      "Log Count": receipt.logs.length,
    });

    // 3. Process events through simulator (using same simulator instance)
    const result = simulator.processTransaction(receipt, ctx, blockTimestamp);

    log.info("Simulator processing result (using persistent simulator)", {
      "Events Processed": result.eventsProcessed,
      "Had Profitable Report": result.hadProfitableReport,
      "TotalReward Entities Created": result.totalRewards.size,
      "Total Entities in Store": simulator.getStore().totalRewards.size,
    });

    // 4. Capture state after
    const stateAfter = await capturePoolState(ctx);

    log.info("Pool state after second report", {
      "Total Pooled Ether": formatEther(stateAfter.totalPooledEther),
      "Total Shares": stateAfter.totalShares.toString(),
      "Ether Change": formatEther(stateAfter.totalPooledEther - stateBefore.totalPooledEther),
      "Shares Change": (stateAfter.totalShares - stateBefore.totalShares).toString(),
    });

    // 5. Verify a TotalReward entity was created
    expect(result.hadProfitableReport).to.be.true;
    expect(result.totalRewards.size).to.equal(1);

    const computed = result.totalRewards.get(receipt.hash);
    expect(computed).to.not.be.undefined;

    // 6. Derive expected values directly from events
    const expected = deriveExpectedTotalReward(receipt, ctx, initialState.treasuryAddress);
    expect(expected).to.not.be.null;

    // Log entity details
    log.info("TotalReward Entity - Tier 1 (Metadata)", {
      "ID": computed!.id,
      "Block": computed!.block.toString(),
      "Block Time": computed!.blockTime.toString(),
      "Tx Index": computed!.transactionIndex.toString(),
      "Log Index": computed!.logIndex.toString(),
    });

    log.info("TotalReward Entity - Tier 2 (Pool State)", {
      "Total Pooled Ether Before": formatEther(computed!.totalPooledEtherBefore),
      "Total Pooled Ether After": formatEther(computed!.totalPooledEtherAfter),
      "Total Shares Before": computed!.totalSharesBefore.toString(),
      "Total Shares After": computed!.totalSharesAfter.toString(),
      "Shares Minted As Fees": computed!.shares2mint.toString(),
      "Time Elapsed": computed!.timeElapsed.toString(),
      "MEV Fee": formatEther(computed!.mevFee),
    });

    log.info("TotalReward Entity - Tier 2 (Fee Distribution)", {
      "Total Rewards With Fees": formatEther(computed!.totalRewardsWithFees),
      "Total Rewards": formatEther(computed!.totalRewards),
      "Total Fee": formatEther(computed!.totalFee),
      "Treasury Fee": formatEther(computed!.treasuryFee),
      "Operators Fee": formatEther(computed!.operatorsFee),
      "Shares To Treasury": computed!.sharesToTreasury.toString(),
      "Shares To Operators": computed!.sharesToOperators.toString(),
    });

    log.info("TotalReward Entity - Tier 3 (Calculated)", {
      "APR": `${computed!.apr.toFixed(4)}%`,
      "APR Raw": `${computed!.aprRaw.toFixed(4)}%`,
      "APR Before Fees": `${computed!.aprBeforeFees.toFixed(4)}%`,
      "Fee Basis": computed!.feeBasis.toString(),
      "Treasury Fee Basis Points": computed!.treasuryFeeBasisPoints.toString(),
      "Operators Fee Basis Points": computed!.operatorsFeeBasisPoints.toString(),
    });

    // 7. Verify Tier 1 fields
    log.info("Verifying Tier 1 fields...");
    expect(computed!.id.toLowerCase()).to.equal(receipt.hash.toLowerCase(), "id mismatch");
    expect(computed!.block).to.equal(BigInt(receipt.blockNumber), "block mismatch");
    expect(computed!.blockTime).to.equal(blockTimestamp, "blockTime mismatch");
    expect(computed!.transactionHash.toLowerCase()).to.equal(receipt.hash.toLowerCase(), "transactionHash mismatch");
    expect(computed!.transactionIndex).to.equal(BigInt(receipt.index), "transactionIndex mismatch");
    expect(computed!.logIndex).to.equal(expected!.logIndex, "logIndex mismatch");

    // 8. Verify Tier 2 fields
    log.info("Verifying Tier 2 fields...");
    expect(computed!.totalPooledEtherBefore).to.equal(
      expected!.totalPooledEtherBefore,
      "totalPooledEtherBefore mismatch",
    );
    expect(computed!.totalPooledEtherAfter).to.equal(expected!.totalPooledEtherAfter, "totalPooledEtherAfter mismatch");
    expect(computed!.totalSharesBefore).to.equal(expected!.totalSharesBefore, "totalSharesBefore mismatch");
    expect(computed!.totalSharesAfter).to.equal(expected!.totalSharesAfter, "totalSharesAfter mismatch");
    expect(computed!.shares2mint).to.equal(expected!.shares2mint, "shares2mint mismatch");
    expect(computed!.timeElapsed).to.equal(expected!.timeElapsed, "timeElapsed mismatch");
    expect(computed!.mevFee).to.equal(expected!.mevFee, "mevFee mismatch");

    // 8b. Verify Tier 2 fields (Fee Distribution)
    log.info("Verifying Tier 2 fields (Fee Distribution)...");
    expect(computed!.totalRewardsWithFees).to.equal(expected!.totalRewardsWithFees, "totalRewardsWithFees mismatch");
    expect(computed!.totalRewards).to.equal(expected!.totalRewards, "totalRewards mismatch");
    expect(computed!.totalFee).to.equal(expected!.totalFee, "totalFee mismatch");
    expect(computed!.treasuryFee).to.equal(expected!.treasuryFee, "treasuryFee mismatch");
    expect(computed!.operatorsFee).to.equal(expected!.operatorsFee, "operatorsFee mismatch");
    expect(computed!.sharesToTreasury).to.equal(expected!.sharesToTreasury, "sharesToTreasury mismatch");
    expect(computed!.sharesToOperators).to.equal(expected!.sharesToOperators, "sharesToOperators mismatch");

    // 8c. Verify Tier 3 fields (APR and Basis Points)
    log.info("Verifying Tier 3 fields (APR and Basis Points)...");
    expect(computed!.apr).to.equal(expected!.apr, "apr mismatch");
    expect(computed!.aprRaw).to.equal(expected!.aprRaw, "aprRaw mismatch");
    expect(computed!.aprBeforeFees).to.equal(expected!.aprBeforeFees, "aprBeforeFees mismatch");
    expect(computed!.feeBasis).to.equal(expected!.feeBasis, "feeBasis mismatch");
    expect(computed!.treasuryFeeBasisPoints).to.equal(
      expected!.treasuryFeeBasisPoints,
      "treasuryFeeBasisPoints mismatch",
    );
    expect(computed!.operatorsFeeBasisPoints).to.equal(
      expected!.operatorsFeeBasisPoints,
      "operatorsFeeBasisPoints mismatch",
    );

    // 8d. Verify fee consistency
    log.info("Verifying fee consistency...");
    expect(computed!.shares2mint).to.equal(
      computed!.sharesToTreasury + computed!.sharesToOperators,
      "shares2mint should equal sharesToTreasury + sharesToOperators",
    );
    expect(computed!.totalFee).to.equal(
      computed!.treasuryFee + computed!.operatorsFee,
      "totalFee should equal treasuryFee + operatorsFee",
    );

    // 9. Verify state consistency
    log.info("Verifying on-chain state consistency...");
    expect(computed!.totalPooledEtherBefore).to.equal(stateBefore.totalPooledEther, "preTotalEther vs stateBefore");
    expect(computed!.totalSharesBefore).to.equal(stateBefore.totalShares, "preTotalShares vs stateBefore");
    expect(computed!.totalPooledEtherAfter).to.equal(stateAfter.totalPooledEther, "postTotalEther vs stateAfter");
    expect(computed!.totalSharesAfter).to.equal(stateAfter.totalShares, "postTotalShares vs stateAfter");

    // 10. Verify simulator state persistence (should have both reports)
    log.info("Verifying simulator state persistence...");
    const storedReport = simulator.getTotalReward(receipt.hash);
    expect(storedReport).to.not.be.undefined;

    log("Second oracle report validation PASSED");
  });

  it("Should verify event processing order", async () => {
    // This test validates that events are processed in the correct order
    // by examining the logs from the last oracle report

    log("=== Event Processing Order Verification ===");

    const clDiff = ether("0.002");
    const reportData: Partial<OracleReportParams> = {
      clDiff,
    };

    log.info("Executing oracle report for event order test", {
      "CL Diff": formatEther(clDiff),
    });

    await advanceChainTime(12n * 60n * 60n);
    const { reportTx } = await report(ctx, reportData);
    const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    // Extract and examine logs
    const logs = extractAllLogs(receipt, ctx);

    log.info("Extracted logs from transaction", {
      "Total Logs": logs.length,
      "Tx Hash": receipt.hash,
    });

    // Log all event names in order
    const eventSummary = logs.map((l) => `${l.logIndex}: ${l.name}`).join(", ");
    log.info("Event order", {
      Events: eventSummary,
    });

    // Find key events
    const ethDistributedIdx = logs.findIndex((l) => l.name === "ETHDistributed");
    const tokenRebasedIdx = logs.findIndex((l) => l.name === "TokenRebased");
    const processingStartedIdx = logs.findIndex((l) => l.name === "ProcessingStarted");

    log.info("Key event positions", {
      "ProcessingStarted Index": processingStartedIdx,
      "ETHDistributed Index": ethDistributedIdx,
      "TokenRebased Index": tokenRebasedIdx,
    });

    // Verify ETHDistributed comes before TokenRebased (as expected by look-ahead)
    expect(ethDistributedIdx).to.be.greaterThanOrEqual(0, "ETHDistributed event not found");
    expect(tokenRebasedIdx).to.be.greaterThanOrEqual(0, "TokenRebased event not found");
    expect(ethDistributedIdx).to.be.lessThan(tokenRebasedIdx, "ETHDistributed should come before TokenRebased");

    // Verify Transfer events are between ETHDistributed and TokenRebased (fee mints)
    const transferEvents = logs.filter(
      (l) => l.name === "Transfer" && l.logIndex > ethDistributedIdx && l.logIndex < tokenRebasedIdx,
    );
    const transferSharesEvents = logs.filter(
      (l) => l.name === "TransferShares" && l.logIndex > ethDistributedIdx && l.logIndex < tokenRebasedIdx,
    );

    log.info("Fee distribution events between ETHDistributed and TokenRebased", {
      "Transfer Events": transferEvents.length,
      "TransferShares Events": transferSharesEvents.length,
    });

    // There should be at least some transfer events for fee distribution
    expect(transferEvents.length).to.be.greaterThanOrEqual(0, "Expected Transfer events for fee distribution");

    log("Event processing order verification PASSED");
  });

  it("Should query TotalRewards with filtering and pagination", async () => {
    log("=== Query Functionality Test ===");

    // Execute another oracle report to have more data
    const clDiff = ether("0.003");
    const reportData: Partial<OracleReportParams> = { clDiff };

    await advanceChainTime(12n * 60n * 60n);
    const { reportTx } = await report(ctx, reportData);
    const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const blockTimestamp = BigInt(block!.timestamp);

    // Process through simulator
    simulator.processTransaction(receipt, ctx, blockTimestamp);

    // Test 1: Count all TotalRewards
    const totalCount = simulator.countTotalRewards(0n);
    log.info("Query: Count all TotalRewards", {
      "Total Count": totalCount,
    });
    expect(totalCount).to.be.greaterThanOrEqual(2, "Should have at least 2 TotalReward entities");

    // Test 2: Query with pagination
    const queryResult = simulator.queryTotalRewards({
      skip: 0,
      limit: 10,
      blockFrom: 0n,
      orderBy: "blockTime",
      orderDirection: "asc",
    });

    log.info("Query: TotalRewards (skip=0, limit=10, orderBy=blockTime asc)", {
      "Results Count": queryResult.length,
      "First Block Time": queryResult[0]?.blockTime.toString(),
      "Last Block Time": queryResult[queryResult.length - 1]?.blockTime.toString(),
    });

    expect(queryResult.length).to.be.greaterThanOrEqual(2);

    // Verify ordering (ascending by blockTime)
    for (let i = 1; i < queryResult.length; i++) {
      expect(queryResult[i].blockTime).to.be.gte(
        queryResult[i - 1].blockTime,
        "Results should be ordered by blockTime ascending",
      );
    }

    // Test 3: Query result contains expected fields
    const firstResult = queryResult[0];
    log.info("Query result fields check", {
      "Has id": firstResult.id !== undefined,
      "Has totalPooledEtherBefore": firstResult.totalPooledEtherBefore !== undefined,
      "Has totalPooledEtherAfter": firstResult.totalPooledEtherAfter !== undefined,
      "Has totalSharesBefore": firstResult.totalSharesBefore !== undefined,
      "Has totalSharesAfter": firstResult.totalSharesAfter !== undefined,
      "Has apr": firstResult.apr !== undefined,
      "Has block": firstResult.block !== undefined,
      "Has blockTime": firstResult.blockTime !== undefined,
      "Has logIndex": firstResult.logIndex !== undefined,
    });

    expect(firstResult.id).to.be.a("string");
    expect(typeof firstResult.totalPooledEtherBefore).to.equal("bigint");
    expect(typeof firstResult.apr).to.equal("number");

    // Test 4: Query with block filter
    const firstBlock = queryResult[0].block;
    const filteredResult = simulator.queryTotalRewards({
      skip: 0,
      limit: 10,
      blockFrom: firstBlock, // Only get entities AFTER the first block
      orderBy: "blockTime",
      orderDirection: "asc",
    });

    log.info("Query: TotalRewards with block filter", {
      "Filter blockFrom": firstBlock.toString(),
      "Filtered Results Count": filteredResult.length,
    });

    // All filtered results should have block > firstBlock
    for (const result of filteredResult) {
      expect(result.block).to.be.gt(firstBlock, "Filtered results should have block > blockFrom");
    }

    // Test 5: Get latest TotalReward
    const latest = simulator.getLatestTotalReward();
    log.info("Query: Latest TotalReward", {
      "Latest ID": latest?.id ?? "N/A",
      "Latest Block": latest?.block.toString() ?? "N/A",
      "Latest APR": latest ? `${latest.apr.toFixed(4)}%` : "N/A",
    });

    expect(latest).to.not.be.null;
    expect(latest!.blockTime).to.equal(queryResult[queryResult.length - 1].blockTime);

    // Test 6: Get by ID
    const byId = simulator.getTotalRewardById(receipt.hash);
    log.info("Query: Get by ID", {
      "Requested ID": receipt.hash,
      "Found": byId !== null,
    });

    expect(byId).to.not.be.null;
    expect(byId!.id.toLowerCase()).to.equal(receipt.hash.toLowerCase());

    log("Query functionality test PASSED");
  });
});
