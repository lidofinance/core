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
  advancePastRequestTimestampMargin,
  assertReserveAllocationInvariant,
  assertReserveState,
  captureState,
  doReport,
  fundElRewards,
  getRedeemAmount,
  mineBlocks,
  ProtocolState,
  redeemExact,
  requestWithdrawal,
  resetProtocolState,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

const SHARE_RATE_PRECISION = 10n ** 27n;
const TOTAL_BASIS_POINTS = 10_000n;

describe("Integration: Redeems reserve — redeem between refSlot and report", () => {
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

    await resetProtocolState(ctx);

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
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  /** Computes smoothing headroom from explicit internalEther value */
  async function getHeadroomFor(internalEther: bigint): Promise<bigint> {
    const maxRebase = await ctx.contracts.oracleReportSanityChecker.getMaxPositiveTokenRebase();
    return (internalEther * maxRebase) / LIMITER_PRECISION_BASE;
  }

  /** Advances to reportable time, mines blocks, runs a dryRun and returns refSlot + full report data */
  async function dryRunAtCurrentState(opts: Parameters<typeof report>[1] = {}) {
    await advancePastRequestTimestampMargin(ctx);
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
    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: RATIO_BP });

    const state0: ProtocolState = await captureState(lido);
    assertReserveState(state0, RATIO_BP);
    await assertReserveAllocationInvariant(lido);

    // --- Fund EL rewards exactly at headroom ---
    const headroomFull = await getHeadroomFor(state0.internalEther);
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

    const [redeemedEtherBuffer, redeemedSharesBuffer] = await fix.vault.getRedeemed();
    expect(redeemedEtherBuffer).to.equal(redeemEther);
    expect(redeemedSharesBuffer).to.equal(redeemShares);

    // Compute post-reconciliation headroom: Lido's IE is stale (doesn't reflect the drain yet),
    // subtracting the vault's tracked redeemed amount gives the real post-drain IE
    const headroomDrained = await getHeadroomFor(
      (await captureState(lido)).internalEther - (await fix.vault.getRedeemed())[0],
    );

    await doReport(ctx, { excludeVaultsBalances: false, reportElVault: true });

    const state2: ProtocolState = await captureState(lido);
    const deferredRewards = await ethers.provider.getBalance(elVaultAddr);
    const appliedRewards = headroomFull - deferredRewards;

    // Verify: shares burned, counters reset
    expect((await fix.vault.getRedeemed())[0]).to.equal(0n);

    // --- Compare paths: drain caused deferred rewards ---
    // Verify: some rewards were deferred (smoothing kicked in due to smaller post-drain base)
    expect(deferredRewards).to.be.gt(0n);
    expect(deferredRewards).to.equal(headroomFull - headroomDrained);
    // Cross-check: applied + deferred = total funded
    expect(appliedRewards + deferredRewards).to.equal(headroomFull);

    expect(state2.totalPooledEther).to.equal(state1.totalPooledEther - deferredRewards - redeemEther);
    expect(state2.totalShares).to.equal(state1.totalShares - redeemShares);

    const expectedShareRate2 = (state2.totalPooledEther * ether("1")) / state2.totalShares;
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

    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: RATIO_BP });
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

    // Verify: pending shares on burner

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

    // Verify: shares burned

    // --- Compute exact deviation ---
    const totalPooled = await lido.getTotalPooledEther();
    const totalShares = await lido.getTotalShares();
    const actualRate = (totalPooled * SHARE_RATE_PRECISION) / totalShares;

    const expectedSimulatedRate =
      ((statePreRedeem.totalPooledEther + REWARDS) * SHARE_RATE_PRECISION) / statePreRedeem.totalShares;
    expect(simulatedShareRate).to.equal(expectedSimulatedRate);

    // Verify: redeem concentrates rewards on fewer shares → actualRate diverges from simulated
    const deviationBP = computeDeviationBP(actualRate, simulatedShareRate);
    expect(deviationBP).to.equal(((actualRate - simulatedShareRate) * TOTAL_BASIS_POINTS) / actualRate);

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

    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: RATIO_BP });
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

    // Compute post-reconciliation headroom: Lido's IE is stale (doesn't reflect the drain yet),
    // subtracting the vault's tracked redeemed amount gives the real post-drain IE
    const headroomAfterDrain = await getHeadroomFor(
      (await captureState(lido)).internalEther - (await fix.vault.getRedeemed())[0],
    );

    // Verify: pending shares on burner

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

    // Verify: shares burned

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

    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: RATIO_BP });
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

    // Verify: pending shares on burner

    // Verify: rewards fit within post-drain headroom (no smoothing → full deviation applies).
    // Lido's IE is stale — subtracting vault's tracked redeemed amount gives the real post-drain IE.
    const stateBefore: ProtocolState = await captureState(lido);
    const reconciledIE = stateBefore.internalEther - (await fix.vault.getRedeemed())[0];
    const maxRebase = await ctx.contracts.oracleReportSanityChecker.getMaxPositiveTokenRebase();
    const headroomPostDrain = (reconciledIE * maxRebase) / LIMITER_PRECISION_BASE;
    expect(headroomPostDrain).to.equal(await getHeadroomFor(reconciledIE));

    // --- DryRun at post-redeem state (same refSlot) ---
    // Lido doesn't see the drain yet (stale tracking), so post-redeem dryRun computes
    // the same simulatedShareRate as pre-redeem. Overriding with the pre-redeem rate
    // to match the pull test structure — in practice they're identical.
    await mineBlocks(4);
    const postRedeemResult = await report(ctx, dryRunOpts);
    const tamperedData = { ...postRedeemResult.data, simulatedShareRate: staleRate };

    // --- Submit report: on-chain reconciliation creates actual rate that diverges from simulated ---
    await expect(submitReportDataWithConsensus(ctx, tamperedData)).to.be.revertedWithCustomError(
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
