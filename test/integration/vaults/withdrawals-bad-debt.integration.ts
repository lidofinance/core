import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { advanceChainTime, ether } from "lib";
import { LIMITER_PRECISION_BASE } from "lib/constants";
import {
  getProtocolContext,
  ProtocolContext,
  queueBadDebtInternalization,
  removeStakingLimit,
  report,
  setupLidoForVaults,
  setupVaultWithBadDebt,
  upDefaultTierShareLimit,
} from "lib/protocol";

import { Snapshot } from "test/suite";
import { SHARE_RATE_PRECISION } from "test/suite/constants";

describe("Integration: Withdrawals finalization with bad debt internalization", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  // Helper to capture protocol state
  const captureState = async () => {
    const { lido, vaultHub, burner, elRewardsVault, withdrawalVault, withdrawalQueue } = ctx.contracts;

    const totalPooledEther = await lido.getTotalPooledEther();
    const totalShares = await lido.getTotalShares();
    const externalShares = await lido.getExternalShares();
    const externalEther = await lido.getExternalEther();
    const internalEther = totalPooledEther - externalEther;
    const internalShares = totalShares - externalShares;
    const unfinalizedSTETH = await withdrawalQueue.unfinalizedStETH();
    const unfinalizedRequestNumber = await withdrawalQueue.unfinalizedRequestNumber();
    const lastFinalizedRequestId = await withdrawalQueue.getLastFinalizedRequestId();
    const badDebtToInternalize = await vaultHub.badDebtToInternalize();
    const [coverShares, nonCoverShares] = await burner.getSharesRequestedToBurn();
    const elRewardsVaultBalance = await ethers.provider.getBalance(elRewardsVault);
    const withdrawalVaultBalance = await ethers.provider.getBalance(withdrawalVault);
    const withdrawalQueueBalance = await ethers.provider.getBalance(withdrawalQueue);

    return {
      totalPooledEther,
      totalShares,
      externalShares,
      externalEther,
      internalEther,
      internalShares,
      badDebtToInternalize,
      burnerShares: coverShares + nonCoverShares,
      elRewardsVaultBalance,
      withdrawalVaultBalance,
      withdrawalQueueBalance,
      unfinalizedSTETH,
      unfinalizedRequestNumber,
      lastFinalizedRequestId,
      shareRate: totalShares > 0n ? (totalPooledEther * SHARE_RATE_PRECISION) / totalShares : 0n,
    };
  };

  // Helper to calculate the bad debt amount that would trigger smoothen token rebase
  const calculateBadDebtToTriggerSmoothing = async () => {
    const { lido, oracleReportSanityChecker } = ctx.contracts;
    const state = await captureState();

    // Get shares to finalize for WQ
    const sharesToFinalize = await lido.getSharesByPooledEth(state.unfinalizedSTETH);

    // Total shares that need to be burned
    const totalSharesToBurn = sharesToFinalize + state.burnerShares;

    // Get rebase limit
    const limits = await oracleReportSanityChecker.getOracleReportLimits();
    const maxPositiveTokenRebase = limits.maxPositiveTokenRebase;
    const rebaseLimitPlus1 = maxPositiveTokenRebase + LIMITER_PRECISION_BASE;

    // Current share rate (this is batchShareRate in prefinalize)
    const currentShareRate = state.shareRate;

    // Calculate maxSharesToBurn for a given badDebtShares amount
    const calculateMaxSharesToBurn = (badDebtShares: bigint): bigint => {
      // Step 1: Calculate simulatedShareRate (simulation without WQ finalization)
      const postInternalShares = state.internalShares + badDebtShares;
      const postExternalShares = state.externalShares - badDebtShares;
      const postInternalEther = state.internalEther; // postInternalEther = preInternalEther (no WQ finalization in simulation)
      const postExternalEther = (postExternalShares * postInternalEther) / postInternalShares;
      const postTotalPooledEther = postInternalEther + postExternalEther;
      const postTotalShares = postInternalShares + postExternalShares;
      const simulatedShareRate = (postTotalPooledEther * SHARE_RATE_PRECISION) / postTotalShares;

      // Step 2: Calculate etherToLock in prefinalize
      let etherToLock: bigint;
      if (currentShareRate > simulatedShareRate) {
        etherToLock = (sharesToFinalize * simulatedShareRate) / SHARE_RATE_PRECISION;
      } else {
        etherToLock = state.unfinalizedSTETH;
      }

      // Step 3: Calculate maxSharesToBurn in smoothenTokenRebase
      const currentTotalPooledEther = state.internalEther - etherToLock;
      const pooledEtherRate = (currentTotalPooledEther * LIMITER_PRECISION_BASE) / state.internalEther;
      const maxSharesToBurn = (state.internalShares * (rebaseLimitPlus1 - pooledEtherRate)) / rebaseLimitPlus1;

      return maxSharesToBurn;
    };

    // Convert ether to shares for calculation
    const etherToShares = (etherAmount: bigint): bigint => {
      return (etherAmount * state.totalShares) / state.totalPooledEther;
    };

    // Check if smoothening already triggers without bad debt
    const maxSharesToBurnWithoutBadDebt = calculateMaxSharesToBurn(0n);
    expect(maxSharesToBurnWithoutBadDebt).to.be.gt(0n, "Smoothening already triggers without bad debt");

    // Binary search to find the threshold
    let low = 0n;
    let high = state.externalShares; // Bad debt can't exceed external shares

    while (high - low > etherToShares(ether("0.01"))) {
      const mid = (low + high) / 2n;
      const maxSharesToBurn = calculateMaxSharesToBurn(mid);

      if (totalSharesToBurn > maxSharesToBurn) {
        // Smoothening triggers, try lower bad debt
        high = mid;
      } else {
        // Smoothening doesn't trigger, try higher bad debt
        low = mid;
      }
    }

    // Return shares (not ether) since internalizeBadDebt expects shares
    return {
      minBadDebtToTrigger: high,
      maxBadDebtWithoutTrigger: low,
    };
  };

  // Helper to put withdrawal requests in the queue
  const requestWithdrawals = async (requestAmount = ether("1000"), requestCount = 10n) => {
    const { lido, withdrawalQueue } = ctx.contracts;
    const requestsSum = requestAmount * requestCount;

    // Submit enough ETH
    await removeStakingLimit(ctx);
    await setBalance(stranger.address, requestsSum + ether("1")); // Some extra for gas
    await lido.connect(stranger).submit(ZeroAddress, { value: requestsSum });

    // Approve WQ to spend stETH
    await lido.connect(stranger).approve(withdrawalQueue.address, requestsSum);

    // Make withdrawal requests
    const requests = Array(parseInt(requestCount.toString())).fill(requestAmount);
    await withdrawalQueue.connect(stranger).requestWithdrawals(requests, stranger.address);
  };

  // Helper to report with withdrawals finalization
  const finalizeWithdrawals = async () => {
    const { withdrawalQueue, oracleReportSanityChecker } = ctx.contracts;

    const stateBefore = await captureState();

    // Advance time to ensure request can be finalized
    const limits = await oracleReportSanityChecker.getOracleReportLimits();
    await advanceChainTime(limits.requestTimestampMargin + 1n);

    // Perform report which will finalize withdrawals
    const { reportTx } = await report(ctx, {
      clDiff: 0n,
      excludeVaultsBalances: false,
      skipWithdrawals: false,
      waitNextReportTime: true,
    });

    const receipt = await reportTx!.wait();

    // Verify WithdrawalsFinalized event emitted
    await expect(reportTx).to.emit(withdrawalQueue, "WithdrawalsFinalized");

    // Extract WithdrawalsFinalized event
    const events = ctx.getEvents(receipt!, "WithdrawalsFinalized");
    expect(events.length).to.equal(1, "No WithdrawalsFinalized event found");
    const finalizedEvent = events[0];

    const stateAfter = await captureState();

    return { reportTx, finalizedEvent, stateBefore, stateAfter };
  };

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    [, owner, nodeOperator, , , stranger] = await ethers.getSigners();

    await setupLidoForVaults(ctx);
    await upDefaultTierShareLimit(ctx, ether("1000"));

    // Make the sanity checker more sensitive to the activation of smoothen token rebase
    const maxPositiveTokenRebase = 1000n;
    const agent = await ctx.getSigner("agent");
    const { oracleReportSanityChecker } = ctx.contracts;
    await oracleReportSanityChecker
      .connect(agent)
      .grantRole(await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(), agent);
    await oracleReportSanityChecker.connect(agent).setMaxPositiveTokenRebase(maxPositiveTokenRebase);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Withdrawals finalization with bad debt internalization", () => {
    it("Should finalize withdrawals even there's bad debt to internalize", async () => {
      // Setup staking vault with bad debt and internalize it
      const setup = await setupVaultWithBadDebt(ctx, owner, nodeOperator);
      await queueBadDebtInternalization(ctx, setup.stakingVault, setup.badDebtShares);

      // Request withdrawals and finalize them
      await requestWithdrawals();
      const { stateBefore, stateAfter } = await finalizeWithdrawals();

      // Verify withdrawals were finalized
      expect(stateBefore.unfinalizedRequestNumber).to.be.gt(
        stateAfter.unfinalizedRequestNumber,
        "Unfinalized request number should decrease after finalization",
      );
      expect(stateBefore.unfinalizedSTETH).to.be.gt(
        stateAfter.unfinalizedSTETH,
        "Unfinalized stETH should decrease after finalization",
      );

      // Verify bad debt was internalized
      expect(stateBefore.badDebtToInternalize).to.be.gt(0n, "There should be bad debt to internalize before report");
      expect(stateAfter.badDebtToInternalize).to.equal(0n, "There should be no bad debt to internalize after report");
    });

    it("Bad debt internalization should affect finalization share rate", async () => {
      const beforeReportSnapshot = await Snapshot.take();

      // 1. Finalize withdrawals without bad debt internalization
      await requestWithdrawals();
      const withoutBadDebt = await finalizeWithdrawals();

      // Restore to before report state
      await Snapshot.restore(beforeReportSnapshot);

      // 2. Finalize withdrawals with bad debt internalization
      const setup = await setupVaultWithBadDebt(ctx, owner, nodeOperator);
      await queueBadDebtInternalization(ctx, setup.stakingVault, setup.badDebtShares);
      await requestWithdrawals();
      const withBadDebt = await finalizeWithdrawals();

      // Second stETH share rate should be lower due to bad debt internalization
      expect(withoutBadDebt.stateAfter.shareRate).to.be.gt(
        withBadDebt.stateAfter.shareRate,
        "Share rate should be higher when no bad debt is internalized",
      );

      const [, , amountOfETHLocked1, sharesToBurn1] = withoutBadDebt.finalizedEvent.args;
      const [, , amountOfETHLocked2, sharesToBurn2] = withBadDebt.finalizedEvent.args;

      expect(amountOfETHLocked1).to.be.gt(
        amountOfETHLocked2,
        "Amount of ETH locked should be higher when no bad debt is internalized",
      );
      expect(sharesToBurn1).to.be.eq(
        sharesToBurn2,
        "Shares to burn should be equal regardless of bad debt internalization",
      );
    });

    it("Verify bad debt smoothing thresholds calculation", async () => {
      await requestWithdrawals();
      await setupVaultWithBadDebt(ctx, owner, nodeOperator, ether("200000"), ether("1"));

      const { minBadDebtToTrigger, maxBadDebtWithoutTrigger } = await calculateBadDebtToTriggerSmoothing();

      expect(minBadDebtToTrigger).to.be.gt(0n, "Minimum bad debt to trigger should be greater than zero");
      expect(maxBadDebtWithoutTrigger).to.be.gt(0n, "Maximum bad debt without trigger should be greater than zero");
      expect(minBadDebtToTrigger).to.be.gt(maxBadDebtWithoutTrigger, "Calculated thresholds are inconsistent");
    });

    it("Small bad debt internalization should not trigger smoothen token rebase", async () => {
      await requestWithdrawals();

      // Calculate the threshold for smoothening
      const setup = await setupVaultWithBadDebt(ctx, owner, nodeOperator, ether("200000"), ether("1"));
      const { maxBadDebtWithoutTrigger } = await calculateBadDebtToTriggerSmoothing();
      expect(maxBadDebtWithoutTrigger).to.be.lte(setup.badDebtShares, "Bad debt shares should be sufficient");

      await queueBadDebtInternalization(ctx, setup.stakingVault, maxBadDebtWithoutTrigger);
      const { stateBefore, stateAfter } = await finalizeWithdrawals();

      expect(stateBefore.burnerShares).to.be.gte(
        stateAfter.burnerShares,
        "Shares to burn should not increase after finalization",
      );
    });

    it("Big bad debt internalization should trigger smoothen token rebase", async () => {
      await requestWithdrawals();

      // Calculate the threshold for smoothening
      const setup = await setupVaultWithBadDebt(ctx, owner, nodeOperator, ether("200000"), ether("1"));
      const { minBadDebtToTrigger } = await calculateBadDebtToTriggerSmoothing();
      expect(minBadDebtToTrigger).to.be.lte(setup.badDebtShares, "Bad debt shares should be sufficient");

      await queueBadDebtInternalization(ctx, setup.stakingVault, minBadDebtToTrigger);
      const { stateBefore, stateAfter } = await finalizeWithdrawals();

      expect(stateBefore.burnerShares).to.be.lt(
        stateAfter.burnerShares,
        "Shares to burn should increase after finalization",
      );
    });

    it("Smoothen token rebase do not affect finalization", async () => {
      await requestWithdrawals();

      // Calculate the threshold for smoothening
      const setup = await setupVaultWithBadDebt(ctx, owner, nodeOperator, ether("200000"), ether("1"));
      const { minBadDebtToTrigger } = await calculateBadDebtToTriggerSmoothing();
      expect(minBadDebtToTrigger).to.be.lte(setup.badDebtShares, "Bad debt shares should be sufficient");

      await queueBadDebtInternalization(ctx, setup.stakingVault, minBadDebtToTrigger);
      const { stateBefore, stateAfter } = await finalizeWithdrawals();

      expect(stateBefore.burnerShares).to.be.lt(
        stateAfter.burnerShares,
        "Smoothing should have triggered and increased shares to burn",
      );

      // Verify finalized requests have claimable ETH
      const { withdrawalQueue } = ctx.contracts;
      const ethForWithdrawals = stateAfter.withdrawalQueueBalance - stateBefore.withdrawalQueueBalance;

      const from = stateBefore.lastFinalizedRequestId + 1n;
      const to = stateAfter.lastFinalizedRequestId;
      expect(from).to.be.lte(to, "No new requests finalized");

      const lastCheckpointIndex = await withdrawalQueue.getLastCheckpointIndex();
      const requestsCount = Number(to - from + 1n);
      const requestIds = Array.from({ length: requestsCount }, (_, i) => from + BigInt(i));

      const chunkSize = 100;
      let totalClaimable = 0n;

      for (let i = 0; i < requestIds.length; i += chunkSize) {
        const chunk = requestIds.slice(i, i + chunkSize);
        const hints = Array(chunk.length).fill(lastCheckpointIndex);

        const claimableChunk = await withdrawalQueue.getClaimableEther(chunk, hints);
        for (const amount of claimableChunk) totalClaimable += amount;
      }

      expect(totalClaimable).to.be.gt(0n, "Finalized requests should have claimable ETH");
      expect(totalClaimable).to.be.lte(ethForWithdrawals, "Claimable ETH must not exceed funds moved to WQ");
    });
  });
});
