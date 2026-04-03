import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether, getCurrentBlockTimestamp } from "lib";
import { getProtocolContext, ProtocolContext, report } from "lib/protocol";

import { Snapshot } from "test/suite";

import {
  advancePastRequestTimestampMargin,
  assertReserveAllocationInvariant,
  assertReserveState,
  captureState,
  doReport,
  expectedReserveTarget,
  getAmountOfETHLocked,
  ProtocolState,
  redeemExact,
  requestWithdrawal,
  resetProtocolState,
  setupVault,
  VaultFixture,
} from "./helpers";

const RATIO_BP = 500n;

describe("Integration: Redeems reserve — full circle", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let reserveManager: HardhatEthersSigner;

  let fix: VaultFixture;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [reserveManager] = await ethers.getSigners();

    await resetProtocolState(ctx);

    const { acl, lido } = ctx.contracts;
    const agent = await ctx.getSigner("agent");
    const role = await lido.BUFFER_RESERVE_MANAGER_ROLE();
    const hasRole = await acl["hasPermission(address,address,bytes32)"](reserveManager.address, lido.address, role);
    if (!hasRole) {
      await acl.connect(agent).grantPermission(reserveManager.address, lido.address, role);
    }
  });

  beforeEach(async () => {
    await ethers.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    testSnapshot = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  it("happy path", async () => {
    const { lido, burner, withdrawalQueue } = ctx.contracts;
    const [, alice, bob] = await ethers.getSigners();

    fix = await setupVault(ctx, reserveManager, [alice]);

    // --- Alice and Bob deposit 500 ETH each, set ratio, process report ---
    await lido.connect(alice).submit(ZeroAddress, { value: ether("500") });
    await lido.connect(bob).submit(ZeroAddress, { value: ether("500") });
    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(RATIO_BP);
    await lido.connect(reserveManager).setDepositsReserveTarget(0n);
    await doReport(ctx);

    const state0: ProtocolState = await captureState(lido);

    assertReserveState(state0, RATIO_BP);
    await assertReserveAllocationInvariant(lido);

    // --- Alice redeems 10 ETH ---
    const redeemShares1 = await lido.getSharesByPooledEth(ether("10"));
    const redeemEther1 = await lido.getPooledEthByShares(redeemShares1);

    await redeemExact(lido, alice, fix, ether("10"));

    // Verify: stale state (burn deferred), rate preserved, pending shares on burner
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(redeemShares1);
    expect(await lido.getPooledEthByShares(ether("1"))).to.equal(state0.shareRate);
    await assertReserveAllocationInvariant(lido);

    // --- Bob requests 100 ETH WQ withdrawal ---
    const requestId = await requestWithdrawal(ctx, bob, ether("100"));

    // --- Reconciliation report: burn redeem shares before WQ processing ---
    await doReport(ctx);
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(0n);

    const state1: ProtocolState = await captureState(lido);

    // Verify: reconciliation applied — TPE and shares reflect the redeem, rate preserved
    expect(state1.totalPooledEther).to.equal(state0.totalPooledEther - redeemEther1);
    expect(state1.totalShares).to.equal(state0.totalShares - redeemShares1);
    expect(state1.shareRate).to.equal(state0.shareRate);

    // --- Process report with WQ finalization ---
    await advancePastRequestTimestampMargin(ctx);
    const reportResult = await doReport(ctx, { skipWithdrawals: false, excludeVaultsBalances: true });

    const state2: ProtocolState = await captureState(lido);
    const ethLocked = await getAmountOfETHLocked(ctx, reportResult);
    const [requestStatus] = await withdrawalQueue.getWithdrawalStatus([requestId]);

    // Verify: WQ finalized, reserve refilled
    expect(requestStatus.isFinalized).to.equal(true);
    expect(await withdrawalQueue.unfinalizedStETH()).to.equal(0n);
    expect(state2.internalEther).to.equal(state1.internalEther - ethLocked);
    assertReserveState(state2, RATIO_BP);
    expect(state2.reserveTarget).to.equal(expectedReserveTarget(state1.internalEther - ethLocked, RATIO_BP));
    await assertReserveAllocationInvariant(lido);

    // --- Alice redeems 5 ETH ---
    const redeemShares2 = await lido.getSharesByPooledEth(ether("5"));
    const redeemEther2 = await lido.getPooledEthByShares(redeemShares2);
    const aliceEthBefore = await ethers.provider.getBalance(alice.address);

    await redeemExact(lido, alice, fix, ether("5"));

    const state3: ProtocolState = await captureState(lido);

    // Verify: stale reserve, pending shares, alice received ETH
    expect(state3.reserve).to.equal(state2.reserve);
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(redeemShares2);
    expect(await ethers.provider.getBalance(alice.address)).to.equal(aliceEthBefore + redeemEther2);
    await assertReserveAllocationInvariant(lido);
  });

  it("full exit", async () => {
    const { lido, burner, withdrawalQueue } = ctx.contracts;
    const [, alice, bob, carol, dave, eve] = await ethers.getSigners();
    const DEPOSIT = ether("200");

    fix = await setupVault(ctx, reserveManager, [alice, dave]);

    // --- 5 users deposit 200 ETH each, set ratio, pause staking, process report ---
    for (const user of [alice, bob, carol, dave, eve]) {
      await lido.connect(user).submit(ZeroAddress, { value: DEPOSIT });
    }

    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(RATIO_BP);
    await lido.connect(reserveManager).setDepositsReserveTarget(0n);

    const agent = await ctx.getSigner("agent");
    const { acl } = ctx.contracts;
    const pauseRole = await lido.STAKING_PAUSE_ROLE();
    const hasPauseRole = await acl["hasPermission(address,address,bytes32)"](
      agent.address,
      lido.getAddress(),
      pauseRole,
    );
    if (!hasPauseRole) {
      await acl.connect(agent).grantPermission(agent.address, lido.getAddress(), pauseRole);
    }
    await lido.connect(agent).pauseStaking();

    await doReport(ctx);

    const state0: ProtocolState = await captureState(lido);
    assertReserveState(state0, RATIO_BP);
    await assertReserveAllocationInvariant(lido);

    // --- Wave 1: Alice redeems 30 ETH, Bob and Carol full WQ withdrawal ---
    await redeemExact(lido, alice, fix, ether("30"));
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(await lido.getSharesByPooledEth(ether("30")));

    for (const user of [bob, carol]) {
      const balance = await lido.balanceOf(user.address);
      await requestWithdrawal(ctx, user, balance);
    }

    // Reconciliation report before WQ processing to avoid bunker detection from stale vault delta
    await doReport(ctx);

    await advancePastRequestTimestampMargin(ctx);
    await doReport(ctx, { skipWithdrawals: false, excludeVaultsBalances: true });

    const state1: ProtocolState = await captureState(lido);

    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(0n);
    expect(await withdrawalQueue.unfinalizedStETH()).to.equal(0n);
    assertReserveState(state1, RATIO_BP);
    await assertReserveAllocationInvariant(lido);

    // --- Wave 2: Alice WQ remainder, Dave redeems 20 ETH, Eve full WQ ---
    const aliceRemainder = await lido.balanceOf(alice.address);
    await requestWithdrawal(ctx, alice, aliceRemainder);

    await redeemExact(lido, dave, fix, ether("20"));
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(await lido.getSharesByPooledEth(ether("20")));

    const eveBalance = await lido.balanceOf(eve.address);
    await requestWithdrawal(ctx, eve, eveBalance);

    // Reconciliation report before WQ processing
    await doReport(ctx);

    await advancePastRequestTimestampMargin(ctx);
    await doReport(ctx, { skipWithdrawals: false, excludeVaultsBalances: true });

    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(0n);
    await assertReserveAllocationInvariant(lido);

    // --- Wave 3: Dave requests WQ for remainder ---
    const daveRemainder = await lido.balanceOf(dave.address);
    const daveRequestId = await requestWithdrawal(ctx, dave, daveRemainder);

    // --- Loop reports until finalization stalls ---
    let prevFinalized = await withdrawalQueue.getLastFinalizedRequestId();

    for (let i = 0; i < 10; i++) {
      await advancePastRequestTimestampMargin(ctx);
      await doReport(ctx, { skipWithdrawals: false, excludeVaultsBalances: true });
      await assertReserveAllocationInvariant(lido);

      const lastFinalized = await withdrawalQueue.getLastFinalizedRequestId();
      if (lastFinalized === prevFinalized && i > 0) break;
      prevFinalized = lastFinalized;
    }

    // Verify: Dave is stuck, reserve holds priority over WQ budget
    const [daveStatus] = await withdrawalQueue.getWithdrawalStatus([daveRequestId]);
    expect(daveStatus.isFinalized).to.equal(false);

    const reserve = await lido.getRedeemsReserve();
    expect(reserve).to.equal(await lido.getRedeemsReserveTarget());
    await assertReserveAllocationInvariant(lido);

    // --- Daemon override: force-finalize with full buffered budget ---
    // Verify: reserve is at target before override (will be drained to zero after)
    const reserveBeforeOverride = await lido.getRedeemsReserve();
    expect(reserveBeforeOverride).to.equal(await lido.getRedeemsReserveTarget());

    const buffered = await lido.getBufferedEther();
    const totalPooled = await lido.getTotalPooledEther();
    const totalShares = await lido.getTotalShares();
    const simulatedShareRate = (totalPooled * 10n ** 27n) / totalShares;

    const { requestTimestampMargin } = await ctx.contracts.oracleReportSanityChecker.getOracleReportLimits();
    const maxTimestamp = (await getCurrentBlockTimestamp()) - requestTimestampMargin;

    const batchesState = await withdrawalQueue.calculateFinalizationBatches(simulatedShareRate, maxTimestamp, 1000n, {
      remainingEthBudget: buffered,
      finished: false,
      batches: Array(36).fill(0n),
      batchesLength: 0n,
    });
    const overrideBatches = [...batchesState.batches].filter((x) => x > 0n);

    // --- Process report with override batches ---
    await report(ctx, {
      clDiff: 0n,
      excludeVaultsBalances: true,
      sharesRequestedToBurn: 0n,
      skipWithdrawals: false,
      withdrawalFinalizationBatches: overrideBatches,
      simulatedShareRate,
    });

    expect(await withdrawalQueue.unfinalizedStETH()).to.equal(0n);

    // Verify: reserve drained to zero after override (full buffer used for WQ; 1 wei rounding)
    expect(await lido.getRedeemsReserve()).to.be.closeTo(0n, 1n);

    const [daveStatusFinal] = await withdrawalQueue.getWithdrawalStatus([daveRequestId]);
    expect(daveStatusFinal.isFinalized).to.equal(true);

    // --- Dave claims withdrawal ---
    const lastCheckpoint = await withdrawalQueue.getLastCheckpointIndex();
    const hints = [...(await withdrawalQueue.findCheckpointHints([daveRequestId], 1n, lastCheckpoint))];
    const [claimable] = await withdrawalQueue.getClaimableEther([daveRequestId], hints);
    expect(claimable).to.be.closeTo(daveRemainder, 100n);

    const ethBefore = await ethers.provider.getBalance(dave.address);
    const tx = await withdrawalQueue.connect(dave).claimWithdrawals([daveRequestId], hints);
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    expect(await ethers.provider.getBalance(dave.address)).to.equal(ethBefore + claimable - gasCost);
  });
});
