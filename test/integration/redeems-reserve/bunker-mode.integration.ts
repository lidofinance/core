import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

import {
  advancePastRequestTimestampMargin,
  assertReserveState,
  captureValidatedBunkerCheckpoint,
  doReport,
  enterBunkerMode,
  exitBunkerMode,
  expectRedeemBlockedInBunker,
  getAmountOfETHLocked,
  getRedeemAmount,
  processNegativeReportInBunker,
  redeemAfterBunkerExit,
  redeemExact,
  requestWithdrawal,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

const DEPOSIT = ether("1000");
const RATIO_BP = 500n;
const BUNKER_CL_DIFF = ether("-10");
const BUNKER_FOLLOWUP_CL_DIFF = ether("-1");
const EXIT_BUNKER_CL_DIFF = ether("0.0001");
const WQ_AMOUNT_BEFORE_BUNKER = ether("100");
const WQ_AMOUNT_IN_BUNKER = ether("50");
const WQ_AMOUNT_AFTER_BUNKER = ether("25");

/**
 * Verifies exact bunker report effects on internal ether, reserve target, TPE, and share rate.
 *
 * `pendingVaultDelta` accounts for push-specific stale tracking: when state0 is captured
 * before the report that reconciles a prior redeem, internalEther in state0 overcounts
 * by the redeemed ETH amount. Pass redeemEther for the first report after redeem, 0 after.
 */
function expectBunkerReportState({
  current,
  previous,
  effectiveClDiff,
  amountOfETHLocked,
  pendingVaultDelta = 0n,
}: {
  current: Awaited<ReturnType<typeof captureValidatedBunkerCheckpoint>>;
  previous: Awaited<ReturnType<typeof captureValidatedBunkerCheckpoint>>;
  effectiveClDiff: bigint;
  amountOfETHLocked: bigint;
  pendingVaultDelta?: bigint;
}) {
  expect(current.bunkerMode).to.equal(true);
  expect(current.protocol.reserve).to.equal(current.protocol.reserveTarget);
  expect(current.protocol.internalEther).to.equal(
    previous.protocol.internalEther - pendingVaultDelta + effectiveClDiff - amountOfETHLocked,
  );

  const expectedTotalPooledEther =
    current.protocol.internalEther + (current.externalShares * current.protocol.internalEther) / current.internalShares;
  const expectedShareRate = (expectedTotalPooledEther * ether("1")) / current.protocol.totalShares;

  expect(current.protocol.totalPooledEther).to.equal(expectedTotalPooledEther);
  expect(current.protocol.shareRate).to.equal(expectedShareRate);
}

describe("Integration: Redeems reserve — bunker mode", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let reserveManager: HardhatEthersSigner;
  let holder: HardhatEthersSigner;

  let fix: VaultFixture;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [holder] = await ethers.getSigners();
    reserveManager = holder;

    const { acl, lido } = ctx.contracts;
    const agent = await ctx.getSigner("agent");
    const role = await lido.BUFFER_RESERVE_MANAGER_ROLE();
    const hasRole = await acl["hasPermission(address,address,bytes32)"](reserveManager.address, lido.address, role);
    if (!hasRole) {
      await acl.connect(agent).grantPermission(reserveManager.address, lido.address, role);
    }

    fix = await setupVault(ctx, reserveManager);
  });

  beforeEach(async () => {
    await ethers.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    testSnapshot = await Snapshot.take();

    await seedReserve(ctx, holder, reserveManager, { deposit: DEPOSIT, redeemsReserveRatioBP: RATIO_BP });
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  it("negative bunker reports keep redeem blocked, preserve reserve sync, and finish the full WQ backlog by recovery", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;
    const initialRedeemAmount = await getRedeemAmount(lido, "small");

    // --- Initial redeem and WQ request before bunker ---
    const redeemShares = await lido.getSharesByPooledEth(initialRedeemAmount);
    const redeemEther = await lido.getPooledEthByShares(redeemShares);
    await redeemExact(lido, holder, fix, initialRedeemAmount);

    // Verify: redeem shares pending on burner (will be burned on next report inside enterBunkerMode)
    const { burner } = ctx.contracts;
    expect(await fix.vault.getRedeemedShares()).to.equal(redeemShares);
    expect(await fix.vault.getRedeemedEther()).to.equal(redeemEther);

    const firstRequestId = await requestWithdrawal(ctx, holder, WQ_AMOUNT_BEFORE_BUNKER);
    await advancePastRequestTimestampMargin(ctx);
    const state0 = await captureValidatedBunkerCheckpoint(ctx);

    // --- Enter bunker mode with CL loss ---
    const bunkerEntryReport = await enterBunkerMode(ctx, {
      effectiveClDiff: BUNKER_CL_DIFF,
    });

    const state1 = await captureValidatedBunkerCheckpoint(ctx);
    assertReserveState(state1.protocol, RATIO_BP);

    // --- Verify redeem blocked, submit WQ request in bunker ---
    await expectRedeemBlockedInBunker(ctx, holder, fix, ether("1"));
    const secondRequestId = await requestWithdrawal(ctx, holder, WQ_AMOUNT_IN_BUNKER);
    const [secondRequestStatusBeforeFollowup] = await withdrawalQueue.getWithdrawalStatus([secondRequestId]);
    expect(secondRequestStatusBeforeFollowup.isFinalized).to.equal(false);
    expect(secondRequestStatusBeforeFollowup.amountOfStETH).to.equal(WQ_AMOUNT_IN_BUNKER);

    expectBunkerReportState({
      current: state1,
      previous: state0,
      effectiveClDiff: BUNKER_CL_DIFF,
      amountOfETHLocked: await getAmountOfETHLocked(ctx, bunkerEntryReport),
      pendingVaultDelta: redeemEther,
    });

    // --- Follow-up negative report while still in bunker ---
    await processNegativeReportInBunker(ctx, BUNKER_FOLLOWUP_CL_DIFF);

    const state2 = await captureValidatedBunkerCheckpoint(ctx);
    assertReserveState(state2.protocol, RATIO_BP);

    await expectRedeemBlockedInBunker(ctx, holder, fix, ether("1"));

    expectBunkerReportState({
      current: state2,
      previous: state1,
      effectiveClDiff: BUNKER_FOLLOWUP_CL_DIFF,
      amountOfETHLocked: 0n,
    });
    const [secondRequestStatusAfterFollowup] = await withdrawalQueue.getWithdrawalStatus([secondRequestId]);
    expect(secondRequestStatusAfterFollowup.isFinalized).to.equal(false);
    expect(secondRequestStatusAfterFollowup.amountOfStETH).to.equal(WQ_AMOUNT_IN_BUNKER);

    // --- Exit bunker mode (skip withdrawals to keep WQ backlog) ---
    await exitBunkerMode(ctx, {
      effectiveClDiff: EXIT_BUNKER_CL_DIFF,
      reportParams: { skipWithdrawals: true },
    });

    const state3 = await captureValidatedBunkerCheckpoint(ctx);
    expect(state3.bunkerMode).to.equal(false);
    expect(state3.lastFinalizedRequestId).to.equal(state2.lastFinalizedRequestId);
    expect(state3.unfinalizedStETH).to.equal(state2.unfinalizedStETH);

    // --- Redeem after exit, submit post-bunker WQ request ---
    const exitRedeemAmount = await getRedeemAmount(lido, "small");
    const exitRedeemShares = await lido.getSharesByPooledEth(exitRedeemAmount);
    const exitRedeemEther = await lido.getPooledEthByShares(exitRedeemShares);
    await redeemAfterBunkerExit(lido, holder, fix, exitRedeemAmount);

    // Verify: redeem shares pending on burner
    expect(await fix.vault.getRedeemedShares()).to.equal(exitRedeemShares);
    expect(await fix.vault.getRedeemedEther()).to.equal(exitRedeemEther);

    // --- Reconciliation report: burn redeem shares and refill vault before WQ processing ---
    await doReport(ctx);

    // Verify: all redeem shares burned, counters reset
    expect(await fix.vault.getRedeemedShares()).to.equal(0n);
    expect(await fix.vault.getRedeemedEther()).to.equal(0n);

    const thirdRequestId = await requestWithdrawal(ctx, holder, WQ_AMOUNT_AFTER_BUNKER);

    // --- Final report: finalize all pending WQ requests ---
    await doReport(ctx, { skipWithdrawals: false, excludeVaultsBalances: true });

    const state4 = await captureValidatedBunkerCheckpoint(ctx);
    assertReserveState(state4.protocol, RATIO_BP);
    const statuses = await withdrawalQueue.getWithdrawalStatus([firstRequestId, secondRequestId, thirdRequestId]);

    expect(state4.bunkerMode).to.equal(false);
    expect(state4.lastFinalizedRequestId).to.equal(thirdRequestId);
    expect(state4.unfinalizedStETH).to.equal(0n);
    expect(state4.protocol.reserve).to.equal(state4.protocol.reserveTarget);
    expect(statuses[0].isFinalized).to.equal(true);
    expect(statuses[1].isFinalized).to.equal(true);
    expect(statuses[2].isFinalized).to.equal(true);
  });
});
