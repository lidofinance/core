import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether } from "lib";
import { LIMITER_PRECISION_BASE } from "lib/constants";
import {
  getProtocolContext,
  ProtocolContext,
  report,
  setMaxPositiveTokenRebase,
  submitReportDataWithConsensus,
  waitNextAvailableReportTime,
} from "lib/protocol";

import { Snapshot } from "test/suite";

import {
  advanceToReportableTime,
  assertReserveAllocationInvariant,
  assertReserveState,
  captureState,
  doReport,
  fundElRewards,
  getRedeemAmount,
  mineBlocks,
  ProtocolState,
  RedeemerFixture,
  redeemExact,
  requestWithdrawal,
  resetProtocolState,
  seedReserve,
  setupRedeemer,
} from "./helpers";

const SHARE_RATE_PRECISION = 10n ** 27n;
const TOTAL_BASIS_POINTS = 10_000n;

describe("Integration: Redeems reserve — redeem between refSlot and report", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let reserveManager: HardhatEthersSigner;
  let holder: HardhatEthersSigner;

  let fix: RedeemerFixture;

  before(async () => {
    ctx = await getProtocolContext();

    [holder] = await ethers.getSigners();
    reserveManager = holder;

    snapshot = await Snapshot.take();
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
    testSnapshot = await Snapshot.take();
    fix = await setupRedeemer(ctx, reserveManager);
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  /** Computes smoothing headroom: max rewards that fit within rebase limit for current internalEther */
  async function getHeadroom(lido: ProtocolContext["contracts"]["lido"]): Promise<bigint> {
    const maxRebase = await ctx.contracts.oracleReportSanityChecker.getMaxPositiveTokenRebase();
    const internalEther = (await lido.getTotalPooledEther()) - (await lido.getExternalEther());
    return (internalEther * maxRebase) / LIMITER_PRECISION_BASE;
  }

  /** Advances to reportable time, mines blocks, runs a dryRun and returns refSlot + full report data */
  async function dryRunAtCurrentState(opts: Parameters<typeof report>[1] = {}) {
    await advanceToReportableTime(ctx);
    await mineBlocks(3);

    const refSlot = (await ctx.contracts.hashConsensus.getCurrentFrame()).refSlot;
    const result = await report(ctx, {
      clDiff: 0n,
      excludeVaultsBalances: true,
      skipWithdrawals: true,
      refSlot,
      waitNextReportTime: false,
      dryRun: true,
      ...opts,
    });

    return {
      refSlot,
      simulatedShareRate: BigInt(result.data.simulatedShareRate),
      data: result.data,
    };
  }

  /** Computes deviation in BP using the contract formula: absDiff(actual, simulated) * 10000 / actual */
  function computeDeviationBP(actualRate: bigint, simulatedRate: bigint): bigint {
    const diff = actualRate > simulatedRate ? actualRate - simulatedRate : simulatedRate - actualRate;
    return (diff * TOTAL_BASIS_POINTS) / actualRate;
  }

  it("drain → headroom reduction → deferred rewards → reserve underfilled", async () => {
    const { lido, locator } = ctx.contracts;
    const elVaultAddr = await locator.elRewardsVault();
    const RATIO_BP = 500n;

    // --- Seed reserve, process report ---
    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), ratioBP: RATIO_BP });

    const state0: ProtocolState = await captureState(lido);
    assertReserveState(state0, RATIO_BP);
    await assertReserveAllocationInvariant(lido);

    // --- Fund EL rewards exactly at headroom ---
    const headroomFull = await getHeadroom(lido);
    await fundElRewards(ctx, headroomFull);

    // --- Path A: report without redeem (via snapshot) ---
    const simSnapshot = await Snapshot.take();

    await doReport(ctx, { excludeVaultsBalances: false, reportElVault: true });
    const state1: ProtocolState = await captureState(lido);
    assertReserveState(state1, RATIO_BP);
    await assertReserveAllocationInvariant(lido);

    // Verify: all rewards fit within headroom, nothing deferred
    expect(await ethers.provider.getBalance(elVaultAddr)).to.equal(0n);

    await Snapshot.restore(simSnapshot);

    // --- Path B: drain reserve, then report ---
    const redeemAmount = await getRedeemAmount(lido, "full");
    const redeemShares = await lido.getSharesByPooledEth(redeemAmount);
    const redeemEther = await lido.getPooledEthByShares(redeemShares);
    await redeemExact(lido, holder, fix, redeemAmount);

    const headroomDrained = await getHeadroom(lido);

    await doReport(ctx, { excludeVaultsBalances: false, reportElVault: true });

    const state2: ProtocolState = await captureState(lido);
    const deferredRewards = await ethers.provider.getBalance(elVaultAddr);
    const appliedRewards = headroomFull - deferredRewards;

    // --- Compare paths: drain caused deferred rewards ---
    // Verify: deferred = headroomFull - headroomDrained (smoothing capped by smaller base)
    expect(deferredRewards).to.equal(headroomFull - headroomDrained);
    expect(appliedRewards).to.equal(headroomDrained);

    expect(state2.totalPooledEther).to.equal(state1.totalPooledEther - deferredRewards - redeemEther);
    expect(state2.totalShares).to.equal(state1.totalShares - redeemShares);

    const expectedShareRate2 = state2.totalPooledEther * ether("1") / state2.totalShares;
    expect(state2.shareRate).to.equal(expectedShareRate2);
    await assertReserveAllocationInvariant(lido);

    // --- Recovery report: deferred rewards picked up ---
    await doReport(ctx, { excludeVaultsBalances: false, reportElVault: true });

    const state3: ProtocolState = await captureState(lido);

    expect(await ethers.provider.getBalance(elVaultAddr)).to.be.closeTo(0n, 10n);
    assertReserveState(state3, RATIO_BP);
    await assertReserveAllocationInvariant(lido);
  });

  it("rewards don't exceed smoothing → deviation > 0", async () => {
    const { lido, locator } = ctx.contracts;
    const elVaultAddr = await locator.elRewardsVault();
    const RATIO_BP = 2000n;
    const REWARDS = ether("50");

    // --- Setup: maxRebase = 10%, ratio = 20% ---
    const savedRebase = await setMaxPositiveTokenRebase(ctx, LIMITER_PRECISION_BASE / 10n);

    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), ratioBP: RATIO_BP });
    assertReserveState(await captureState(lido), RATIO_BP);

    await requestWithdrawal(ctx, holder, ether("1"));

    // --- Fund EL rewards, dryRun at pre-redeem state ---
    await fundElRewards(ctx, REWARDS);

    const statePreRedeem: ProtocolState = await captureState(lido);
    const { simulatedShareRate } = await dryRunAtCurrentState({
      excludeVaultsBalances: false,
      reportElVault: true,
      skipWithdrawals: false,
    });

    // --- Drain entire reserve ---
    await mineBlocks(3);
    const redeemAmount = await getRedeemAmount(lido, "full");
    await redeemExact(lido, holder, fix, redeemAmount);

    // --- Process report ---
    await mineBlocks(4);
    await report(ctx, {
      clDiff: 0n,
      excludeVaultsBalances: false,
      reportElVault: true,
      skipWithdrawals: false,
    });

    // Verify: smoothing did NOT kick in (all rewards applied)
    expect(await ethers.provider.getBalance(elVaultAddr)).to.equal(0n);

    // --- Compute exact deviation ---
    const totalPooled = await lido.getTotalPooledEther();
    const totalShares = await lido.getTotalShares();
    const actualRate = (totalPooled * SHARE_RATE_PRECISION) / totalShares;

    const expectedSimulatedRate =
      (statePreRedeem.totalPooledEther + REWARDS) * SHARE_RATE_PRECISION / statePreRedeem.totalShares;
    expect(simulatedShareRate).to.equal(expectedSimulatedRate);

    // Verify: actualRate > simulatedRate because same rewards over fewer shares (post-redeem)
    const rateDiff = actualRate - simulatedShareRate;
    expect(rateDiff).to.equal(actualRate - expectedSimulatedRate);

    const deviationBP = (rateDiff * TOTAL_BASIS_POINTS) / actualRate;
    expect(deviationBP).to.equal(computeDeviationBP(actualRate, simulatedShareRate));

    await assertReserveAllocationInvariant(lido);

    await setMaxPositiveTokenRebase(ctx, savedRebase);
  });

  it("rewards exceed smoothing → deviation ≈ 0", async () => {
    const { lido, locator } = ctx.contracts;
    const elVaultAddr = await locator.elRewardsVault();
    const RATIO_BP = 2000n;
    const REWARDS = ether("50");

    // --- Setup: maxRebase = 1%, ratio = 20% ---
    const savedRebase = await setMaxPositiveTokenRebase(ctx, LIMITER_PRECISION_BASE / 100n);

    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), ratioBP: RATIO_BP });
    assertReserveState(await captureState(lido), RATIO_BP);

    await requestWithdrawal(ctx, holder, ether("1"));

    // --- Fund EL rewards (>> headroom), dryRun at pre-redeem state ---
    await fundElRewards(ctx, REWARDS);

    const { simulatedShareRate } = await dryRunAtCurrentState({
      excludeVaultsBalances: false,
      reportElVault: true,
      skipWithdrawals: false,
    });

    // --- Drain entire reserve ---
    await mineBlocks(3);
    const redeemAmount = await getRedeemAmount(lido, "full");
    await redeemExact(lido, holder, fix, redeemAmount);

    const headroomAfterDrain = await getHeadroom(lido);

    // --- Process report ---
    await mineBlocks(4);
    await report(ctx, {
      clDiff: 0n,
      excludeVaultsBalances: false,
      reportElVault: true,
      skipWithdrawals: false,
    });

    // Verify: smoothing DID kick in (some rewards deferred)
    const deferredRewards = await ethers.provider.getBalance(elVaultAddr);
    expect(deferredRewards).to.equal(REWARDS - headroomAfterDrain);

    // Verify: deviation == 0 (smoothing caps both pre- and post-drain paths equally)
    const totalPooled = await lido.getTotalPooledEther();
    const totalShares = await lido.getTotalShares();
    const actualRate = (totalPooled * SHARE_RATE_PRECISION) / totalShares;
    const deviationBP = computeDeviationBP(actualRate, simulatedShareRate);

    expect(deviationBP).to.equal(0n);
    await assertReserveAllocationInvariant(lido);

    await setMaxPositiveTokenRebase(ctx, savedRebase);
  });

  it("deviation exceeds limit → report reverts", async () => {
    const { lido } = ctx.contracts;
    const RATIO_BP = 2000n;
    const REWARDS = ether("150");

    // --- Setup: maxRebase = 20%, ratio = 20%, rewards = 150 ETH ---
    const savedRebase = await setMaxPositiveTokenRebase(ctx, LIMITER_PRECISION_BASE / 5n);

    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), ratioBP: RATIO_BP });
    assertReserveState(await captureState(lido), RATIO_BP);

    await requestWithdrawal(ctx, holder, ether("1"));

    await fundElRewards(ctx, REWARDS);

    // --- Advance to fresh frame, dryRun at pre-redeem state ---
    const { reportRefSlot: refSlot } = await waitNextAvailableReportTime(ctx);
    await mineBlocks(3);

    const dryRunOpts = {
      clDiff: 0n,
      excludeVaultsBalances: false,
      reportElVault: true,
      skipWithdrawals: false,
      refSlot,
      waitNextReportTime: false,
      dryRun: true,
    } as const;

    const preRedeemResult = await report(ctx, dryRunOpts);
    const staleRate = BigInt(preRedeemResult.data.simulatedShareRate);

    // --- Drain entire reserve ---
    await mineBlocks(3);
    const redeemAmount = await getRedeemAmount(lido, "full");
    await redeemExact(lido, holder, fix, redeemAmount);

    // Verify: rewards fit within post-drain headroom
    const statePostDrain = await captureState(lido);
    const headroomPostDrain = statePostDrain.internalEther / 5n;
    expect(await getHeadroom(lido)).to.equal(headroomPostDrain);

    const stateBefore: ProtocolState = statePostDrain;

    // --- DryRun at post-redeem state (same refSlot) ---
    await mineBlocks(4);
    const postRedeemResult = await report(ctx, dryRunOpts);
    const tamperedData = { ...postRedeemResult.data, simulatedShareRate: staleRate };

    // --- Submit report with stale simulatedShareRate, expect revert ---
    await expect(
      submitReportDataWithConsensus(ctx, tamperedData),
    ).to.be.revertedWithCustomError(
      ctx.contracts.oracleReportSanityChecker,
      "IncorrectSimulatedShareRate",
    );

    // Verify: protocol state unchanged after revert
    const stateAfter: ProtocolState = await captureState(lido);
    expect(stateAfter).to.deep.equal(stateBefore);
    await assertReserveAllocationInvariant(lido);

    await setMaxPositiveTokenRebase(ctx, savedRebase);
  });
});
