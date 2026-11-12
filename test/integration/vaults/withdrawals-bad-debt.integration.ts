import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { advanceChainTime, ether } from "lib";
import {
  finalizeWQViaElVault,
  getProtocolContext,
  ProtocolContext,
  queueBadDebtInternalization,
  removeStakingLimit,
  reportWithoutClActivation,
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
  const DEPOSITS_RESERVE_TARGET = ether("100");

  const captureState = async () => {
    const { lido, vaultHub, elRewardsVault, withdrawalVault, withdrawalQueue } = ctx.contracts;
    return {
      badDebtToInternalize: await vaultHub.badDebtToInternalize(),
      unfinalizedSTETH: await withdrawalQueue.unfinalizedStETH(),
      unfinalizedRequestNumber: await withdrawalQueue.unfinalizedRequestNumber(),
      lastFinalizedRequestId: await withdrawalQueue.getLastFinalizedRequestId(),
      withdrawalVaultBalance: await ethers.provider.getBalance(withdrawalVault),
      elRewardsVaultBalance: await ethers.provider.getBalance(elRewardsVault),
      depositsReserveTarget: await lido.getDepositsReserveTarget(),
      depositsReserve: await lido.getDepositsReserve(),
      withdrawalsReserve: await lido.getWithdrawalsReserve(),
      bufferedEther: await lido.getBufferedEther(),
      depositableEther: await lido.getDepositableEther(),
    };
  };

  const requestWithdrawals = async (requestAmount = ether("1000"), requestCount = 10n) => {
    const { lido, withdrawalQueue } = ctx.contracts;
    const requestsSum = requestAmount * requestCount;

    await removeStakingLimit(ctx);
    await setBalance(stranger.address, requestsSum + ether("1"));
    await lido.connect(stranger).submit(ZeroAddress, { value: requestsSum });
    await lido.connect(stranger).approve(withdrawalQueue.address, requestsSum);

    const requests = Array(Number(requestCount)).fill(requestAmount);
    await withdrawalQueue.connect(stranger).requestWithdrawals(requests, stranger.address);
  };

  const finalizeWithdrawals = async () => {
    const { withdrawalQueue, oracleReportSanityChecker } = ctx.contracts;
    const stateBefore = await captureState();

    const limits = await oracleReportSanityChecker.getOracleReportLimits();
    // The next reference slot can fall up to one slot before the current time, so wait one slot past the margin.
    const { secondsPerSlot } = await ctx.contracts.hashConsensus.getChainConfig();
    await advanceChainTime(limits.requestTimestampMargin + secondsPerSlot + 1n);

    const { reportTx } = await reportWithoutClActivation(ctx, {
      reportElVault: false,
      skipWithdrawals: false,
      reportBurner: false,
    });
    const receipt = await reportTx!.wait();

    await expect(reportTx).to.emit(withdrawalQueue, "WithdrawalsFinalized");
    const finalizedEvents = ctx.getEvents(receipt!, "WithdrawalsFinalized");
    expect(finalizedEvents.length).to.equal(1, "No WithdrawalsFinalized event found");

    const stateAfter = await captureState();
    expect(stateAfter.depositableEther).to.equal(stateAfter.bufferedEther - stateAfter.withdrawalsReserve);
    expect(stateAfter.depositsReserveTarget).to.equal(DEPOSITS_RESERVE_TARGET);
    expect(stateAfter.depositsReserve).to.be.lte(stateAfter.depositsReserveTarget);

    const [, , amountOfETHLocked] = finalizedEvents[0].args;
    const availableEthForFinalization =
      stateBefore.withdrawalVaultBalance + stateBefore.elRewardsVaultBalance + stateBefore.withdrawalsReserve;
    expect(amountOfETHLocked).to.be.lte(availableEthForFinalization);

    return { finalizedEvent: finalizedEvents[0], stateBefore, stateAfter };
  };

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();
    [, owner, nodeOperator, , , stranger] = await ethers.getSigners();

    await setupLidoForVaults(ctx);

    const { operatorGrid, lido, vaultHub } = ctx.contracts;
    const totalShares = await lido.getTotalShares();
    const maxRelativeShareLimit = await vaultHub.MAX_RELATIVE_SHARE_LIMIT_BP();
    const existingTierParams = await operatorGrid.tier(await operatorGrid.DEFAULT_TIER_ID());
    const maxLimit = (totalShares * maxRelativeShareLimit) / 10_000n;
    await upDefaultTierShareLimit(ctx, maxLimit - existingTierParams.shareLimit);

    const agent = await ctx.getSigner("agent");
    await lido.connect(agent).setDepositsReserveTarget(DEPOSITS_RESERVE_TARGET);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  it("finalizes withdrawals while internalizing queued bad debt", async () => {
    const setup = await setupVaultWithBadDebt(ctx, owner, nodeOperator);
    await queueBadDebtInternalization(ctx, setup.stakingVault, setup.badDebtShares);

    await requestWithdrawals();
    const { stateBefore, stateAfter } = await finalizeWithdrawals();

    expect(stateBefore.unfinalizedRequestNumber).to.be.gt(stateAfter.unfinalizedRequestNumber);
    expect(stateBefore.unfinalizedSTETH).to.be.gt(stateAfter.unfinalizedSTETH);
    expect(stateBefore.badDebtToInternalize).to.be.gt(0n);
    expect(stateAfter.badDebtToInternalize).to.equal(0n);
  });

  it("finalizes requests at the share rate after the queued bad debt is internalized", async () => {
    const { lido, withdrawalQueue, vaultHub } = ctx.contracts;
    // Finalization is FIFO, and the report that finalizes live requests would also internalize the debt queued below.
    if ((await withdrawalQueue.getLastFinalizedRequestId()) !== (await withdrawalQueue.getLastRequestId())) {
      await finalizeWQViaElVault(ctx);
    }
    const setup = await setupVaultWithBadDebt(ctx, owner, nodeOperator);
    await queueBadDebtInternalization(ctx, setup.stakingVault, setup.badDebtShares);
    await requestWithdrawals();

    // Nothing else changes in the report: internal ether stays, and the bad debt shares become internal.
    const totalShares = await lido.getTotalShares();
    const externalShares = (await lido.getExternalShares()) - (await vaultHub.badDebtToInternalize());
    const internalEther = (await lido.getTotalPooledEther()) - (await lido.getExternalEther());
    const totalEther = internalEther + (externalShares * internalEther) / (totalShares - externalShares);
    const shareRate = (totalEther * SHARE_RATE_PRECISION) / totalShares;

    const { finalizedEvent, stateBefore, stateAfter } = await finalizeWithdrawals();
    const [, , amountOfETHLocked] = finalizedEvent.args;
    const from = stateBefore.lastFinalizedRequestId + 1n;
    const requestIds = Array.from(
      { length: Number(stateAfter.lastFinalizedRequestId - from + 1n) },
      (_, index) => from + BigInt(index),
    );
    const requests = await withdrawalQueue.getWithdrawalStatus(requestIds);
    const hints = Array(requestIds.length).fill(await withdrawalQueue.getLastCheckpointIndex());

    // The requests were filed at the higher pre-report rate, so each is discounted to the new rate.
    const requestedShares = requests.reduce((acc, { amountOfShares }) => acc + amountOfShares, 0n);
    expect(amountOfETHLocked).to.equal((requestedShares * shareRate) / SHARE_RATE_PRECISION);
    expect([...(await withdrawalQueue.getClaimableEther(requestIds, hints))]).to.deep.equal(
      requests.map(({ amountOfShares }) => (amountOfShares * shareRate) / SHARE_RATE_PRECISION),
    );
  });
});
