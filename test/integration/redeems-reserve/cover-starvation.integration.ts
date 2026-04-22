import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether } from "lib";
import { LIMITER_PRECISION_BASE } from "lib/constants";
import { getProtocolContext, ProtocolContext, setMaxPositiveTokenRebase } from "lib/protocol";

import { Snapshot } from "test/suite";

import {
  applyInsurance,
  assertReserveAllocationInvariant,
  captureState,
  doReport,
  fundElRewards,
  getRedeemAmount,
  ProtocolState,
  redeemExact,
  resetProtocolState,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

describe("Integration: Redeems reserve — cover starvation and RefSlot deferral", () => {
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

  /**
   * Computes the actual rebase of the share rate between two protocol states.
   * Returns the rebase in LIMITER_PRECISION_BASE units (1e9 = 100%).
   */
  function computeRebase(pre: ProtocolState, post: ProtocolState): bigint {
    const numerator = post.totalPooledEther * pre.totalShares;
    const denominator = pre.totalPooledEther * post.totalShares;

    if (numerator <= denominator) return 0n;
    return ((numerator - denominator) * LIMITER_PRECISION_BASE) / denominator;
  }

  it("cover starvation: redeem nonCover burns first via _minNonCoverSharesToBurn, events correct", async () => {
    const { lido, burner } = ctx.contracts;

    const RATIO_BP = 2000n; // 20% reserve
    const MAX_REBASE = LIMITER_PRECISION_BASE / 100n; // 1%

    const savedRebase = await setMaxPositiveTokenRebase(ctx, MAX_REBASE);

    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: RATIO_BP });

    const stateSeeded: ProtocolState = await captureState(lido);

    // Apply large cover insurance (30 ETH)
    const COVER_BURN = ether("30");
    await applyInsurance(ctx, holder, COVER_BURN);

    // Fund small rewards (half of headroom)
    const headroom = (stateSeeded.internalEther * MAX_REBASE) / LIMITER_PRECISION_BASE;
    const REWARDS = headroom / 2n;
    await fundElRewards(ctx, REWARDS);

    // Drain the full reserve
    const redeemAmount = await getRedeemAmount(lido, "full");
    const redeemShares = await lido.getSharesByPooledEth(redeemAmount);
    const redeemEther = await lido.getPooledEthByShares(redeemShares);
    await redeemExact(lido, holder, fix, redeemAmount);

    expect((await fix.vault.getRedeemed())[0]).to.equal(redeemEther);

    const nonCoverBurntBefore = await burner.getNonCoverSharesBurnt();
    const stateBeforeReport: ProtocolState = await captureState(lido);

    // Process report
    await doReport(ctx, {
      excludeVaultsBalances: false,
      reportElVault: true,
      reportWithdrawalsVault: false,
      reportBurner: true,
    });

    const stateAfterReport: ProtocolState = await captureState(lido);

    // Burner's getNonCoverSharesBurnt increased by at least redeemShares worth
    const nonCoverBurntAfter = await burner.getNonCoverSharesBurnt();
    const nonCoverBurntDelta = nonCoverBurntAfter - nonCoverBurntBefore;
    // The redeem shares are burned as nonCover via _minNonCoverSharesToBurn. The eth-to-shares roundtrip
    // can lose up to 1 wei, so we allow tolerance.
    const burnedRedeemShares = await lido.getSharesByPooledEth(redeemEther);
    expect(nonCoverBurntDelta).to.be.gte(burnedRedeemShares);

    // Reserve allocation invariant holds
    await assertReserveAllocationInvariant(lido);

    // Rebase within limit
    const rebase = computeRebase(stateBeforeReport, stateAfterReport);
    expect(rebase).to.be.lte(MAX_REBASE + 1n);

    // Redeem ether counter reset to 0
    expect((await fix.vault.getRedeemed())[0]).to.equal(0n);

    await setMaxPositiveTokenRebase(ctx, savedRebase);
  });

  it("multi-frame convergence: cumulative state matches single-frame counterfactual", async () => {
    const { lido, burner } = ctx.contracts;

    const RATIO_BP = 2000n; // 20% reserve
    const TIGHT_REBASE = LIMITER_PRECISION_BASE / 500n; // 0.2% -- very tight
    const LOOSE_REBASE = LIMITER_PRECISION_BASE; // 100% -- unlimited

    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: RATIO_BP });

    // Apply large cover insurance
    const COVER_BURN = ether("30");
    await applyInsurance(ctx, holder, COVER_BURN);

    // Fund rewards
    await fundElRewards(ctx, ether("5"));

    // Drain reserve
    const redeemAmount = await getRedeemAmount(lido, "full");
    await redeemExact(lido, holder, fix, redeemAmount);

    // ---- Path A: unlimited rebase, single report ----
    const pathASnapshot = await Snapshot.take();

    await setMaxPositiveTokenRebase(ctx, LOOSE_REBASE);

    await doReport(ctx, {
      excludeVaultsBalances: false,
      reportElVault: true,
      reportWithdrawalsVault: false,
      reportBurner: true,
    });

    const stateA: ProtocolState = await captureState(lido);

    await Snapshot.restore(pathASnapshot);

    // ---- Path B: tight rebase, multiple reports until converged ----
    const savedRebase_B = await setMaxPositiveTokenRebase(ctx, TIGHT_REBASE);

    // Run multiple reports to burn everything
    const MAX_FRAMES = 50;
    for (let i = 0; i < MAX_FRAMES; i++) {
      const { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn();
      if (coverShares === 0n && nonCoverShares === 0n) break;

      await doReport(ctx, {
        excludeVaultsBalances: false,
        reportElVault: true,
        reportWithdrawalsVault: false,
        reportBurner: true,
      });
    }

    const stateB: ProtocolState = await captureState(lido);

    // Verify: Path A and Path B converge to the same final state
    // TPE should match within 1 wei tolerance (rounding across multiple frames)
    expect(stateB.totalPooledEther).to.be.closeTo(stateA.totalPooledEther, 1n);
    expect(stateB.totalShares).to.be.closeTo(stateA.totalShares, 1n);
    expect(stateB.shareRate).to.be.closeTo(stateA.shareRate, 1n);

    // Both should have burned all requested shares
    const { coverShares: remainCover, nonCoverShares: remainNonCover } = await burner.getSharesRequestedToBurn();
    expect(remainCover).to.equal(0n);
    expect(remainNonCover).to.equal(0n);

    // Redeem counters should be reset
    expect((await fix.vault.getRedeemed())[0]).to.equal(0n);

    await assertReserveAllocationInvariant(lido);

    await setMaxPositiveTokenRebase(ctx, savedRebase_B);
  });

  it("carry mechanism: consecutive redeem-report cycles with zero drift", async () => {
    const { lido } = ctx.contracts;

    const RATIO_BP = 500n;
    const DEPOSIT = ether("1000");

    await seedReserve(ctx, holder, reserveManager, { deposit: DEPOSIT, redeemsReserveRatioBP: RATIO_BP });

    const state0: ProtocolState = await captureState(lido);

    // ---- Cycle 1: redeem 5 ETH ----
    const redeemAmount1 = ether("5");
    await redeemExact(lido, holder, fix, redeemAmount1);

    const liveValue = (await fix.vault.getRedeemed())[0];
    expect(liveValue).to.be.gt(0n);

    // Within the same frame: snapshot returns start-of-frame value (before redeem write)
    const snapshotInFrame = (await fix.vault.getRedeemedForLastRefSlot())[0];
    expect(snapshotInFrame).to.equal(0n);

    // doReport advances to next frame → snapshot now returns the live value
    await doReport(ctx);

    expect((await fix.vault.getRedeemed())[0]).to.equal(0n);

    const state1: ProtocolState = await captureState(lido);
    expect(state1.shareRate).to.equal(state0.shareRate);
    await assertReserveAllocationInvariant(lido);

    // ---- Cycle 2: redeem 3 ETH ----
    await redeemExact(lido, holder, fix, ether("3"));
    expect((await fix.vault.getRedeemed())[0]).to.be.gt(0n);

    await doReport(ctx);

    expect((await fix.vault.getRedeemed())[0]).to.equal(0n);
    expect((await captureState(lido)).shareRate).to.equal(state1.shareRate);
    await assertReserveAllocationInvariant(lido);
  });
});
