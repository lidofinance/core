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

const TOTAL_BASIS_POINTS = 10_000n;

describe("Integration: Redeems reserve — smoothing interaction with cover burn", () => {
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
    // shareRate = totalPooledEther / totalShares (per-share value in ether)
    // rebase = postRate / preRate - 1
    // Using cross-multiplication to avoid precision loss:
    // rebase = (postTPE * preTotalShares) / (preTPE * postTotalShares) - 1
    const numerator = post.totalPooledEther * pre.totalShares;
    const denominator = pre.totalPooledEther * post.totalShares;

    if (numerator <= denominator) return 0n;
    return ((numerator - denominator) * LIMITER_PRECISION_BASE) / denominator;
  }

  /**
   * Core scenario: tight rebase limit + large cover burn + large redeem.
   *
   * Without subtracting redeemedShares from the limiter's preInternalShares,
   * the limiter would use a distorted (too low) pre-share-rate, allowing more
   * cover shares to burn than the rebase limit permits. With the fix, the
   * limiter sees a rate-neutral base and correctly sizes the cover burn.
   *
   * The test proves this by comparing two paths:
   *   Path A: report with cover burn only (no redeem) — baseline
   *   Path B: same report but preceded by a full reserve drain
   *
   * With the fix applied:
   *   - Path B rebase does not exceed maxRebase
   *   - Path B burns fewer cover shares (proportional to the reduced base)
   *   - Both paths achieve approximately the same rebase percentage
   */
  it("large redeem does not inflate cover burn beyond rebase limit", async () => {
    const { lido, burner } = ctx.contracts;

    // --- Setup: tight rebase, large reserve, significant cover burn ---
    const RATIO_BP = 2000n; // 20% reserve
    const MAX_REBASE = LIMITER_PRECISION_BASE / 100n; // 1%

    const savedRebase = await setMaxPositiveTokenRebase(ctx, MAX_REBASE);

    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: RATIO_BP });

    const stateSeeded: ProtocolState = await captureState(lido);

    // Apply a large cover burn request (~30 ETH worth — larger than the limiter will allow)
    const COVER_BURN = ether("30");
    await applyInsurance(ctx, holder, COVER_BURN);

    // Fund EL rewards: ~50% of headroom so the limiter has room for share burns but is tight
    const headroom = (stateSeeded.internalEther * MAX_REBASE) / LIMITER_PRECISION_BASE;
    const REWARDS = headroom / 2n;
    await fundElRewards(ctx, REWARDS);

    const stateBeforeReport: ProtocolState = await captureState(lido);

    // ── Path A: report with cover burn, NO redeem (snapshot) ──
    const pathASnapshot = await Snapshot.take();

    const coverBurntBefore_A = await burner.getCoverSharesBurnt();
    await doReport(ctx, {
      excludeVaultsBalances: false,
      reportElVault: true,
      reportWithdrawalsVault: false,
      reportBurner: true,
    });
    const coverBurntAfter_A = await burner.getCoverSharesBurnt();
    const coverBurned_A = coverBurntAfter_A - coverBurntBefore_A;

    const stateAfterReport_A: ProtocolState = await captureState(lido);
    const rebase_A = computeRebase(stateBeforeReport, stateAfterReport_A);
    await assertReserveAllocationInvariant(lido);

    await Snapshot.restore(pathASnapshot);

    // ── Path B: drain reserve THEN same report ──
    const redeemAmount = await getRedeemAmount(lido, "full");
    const redeemShares = await lido.getSharesByPooledEth(redeemAmount);
    const redeemEther = await lido.getPooledEthByShares(redeemShares);
    await redeemExact(lido, holder, fix, redeemAmount);

    // Verify: pending counters
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(redeemShares);
    expect(await fix.vault.getRedeemedEther()).to.equal(redeemEther);

    const coverBurntBefore_B = await burner.getCoverSharesBurnt();
    await doReport(ctx, {
      excludeVaultsBalances: false,
      reportElVault: true,
      reportWithdrawalsVault: false,
      reportBurner: true,
    });
    const coverBurntAfter_B = await burner.getCoverSharesBurnt();
    const coverBurned_B = coverBurntAfter_B - coverBurntBefore_B;

    const stateAfterReport_B: ProtocolState = await captureState(lido);
    const rebase_B = computeRebase(stateBeforeReport, stateAfterReport_B);
    await assertReserveAllocationInvariant(lido);

    // Verify: all redeem shares burned, counters reset
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(0n);
    expect(await fix.vault.getRedeemedEther()).to.equal(0n);

    // ── Assertions ──

    // 1. Both paths hit the rebase limit (rewards + cover burn together exceed headroom)
    expect(rebase_A).to.be.gt(0n, "Path A should have positive rebase");
    expect(rebase_B).to.be.gt(0n, "Path B should have positive rebase");

    // 2. Path B rebase does NOT exceed the configured limit
    //    (with 1 wei tolerance for rounding)
    expect(rebase_B).to.be.lte(MAX_REBASE + 1n, "Path B rebase must not exceed maxRebase");

    // 3. Path B burns FEWER cover shares than Path A
    //    (because the limiter correctly operates on a smaller share base)
    expect(coverBurned_B).to.be.lt(coverBurned_A, "Path B should burn fewer cover shares due to reduced limiter base");

    // 4. The reduction is stronger than the simple share ratio because
    //    the same absolute rewards consume a larger fraction of the smaller
    //    base's headroom, leaving less room for cover burns.
    //    coverBurned_B / coverBurned_A < (totalShares - redeemShares) / totalShares
    const simpleShareRatio =
      ((stateBeforeReport.totalShares - redeemShares) * TOTAL_BASIS_POINTS) / stateBeforeReport.totalShares;
    const actualRatio = (coverBurned_B * TOTAL_BASIS_POINTS) / coverBurned_A;
    expect(actualRatio).to.be.lt(
      simpleShareRatio,
      "Cover burn reduction should be stronger than the simple share ratio " +
        "(rewards consume more headroom on the smaller base)",
    );
    expect(actualRatio).to.be.gt(0n, "Some cover shares should still be burned");

    await setMaxPositiveTokenRebase(ctx, savedRebase);
  });

  /**
   * Complementary scenario: when there is headroom to burn ALL cover shares,
   * the redeem should not affect the burn amount.
   */
  it("small cover burn fully consumed regardless of redeem when headroom is sufficient", async () => {
    const { lido, burner } = ctx.contracts;

    const RATIO_BP = 1000n; // 10%
    const MAX_REBASE = LIMITER_PRECISION_BASE / 10n; // 10% — very loose

    const savedRebase = await setMaxPositiveTokenRebase(ctx, MAX_REBASE);

    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: RATIO_BP });

    // Small cover burn — easily fits in the headroom
    const COVER_BURN = ether("1");
    await applyInsurance(ctx, holder, COVER_BURN);
    const coverSharesRequested = await lido.getSharesByPooledEth(COVER_BURN);

    // Small rewards
    await fundElRewards(ctx, ether("0.5"));

    // ── Path A: no redeem ──
    const pathASnapshot = await Snapshot.take();

    const coverBurntBefore_A = await burner.getCoverSharesBurnt();
    await doReport(ctx, { excludeVaultsBalances: false, reportElVault: true, reportBurner: true });
    const coverBurned_A = (await burner.getCoverSharesBurnt()) - coverBurntBefore_A;

    await Snapshot.restore(pathASnapshot);

    // ── Path B: full redeem then report ──
    const redeemAmount = await getRedeemAmount(lido, "full");
    await redeemExact(lido, holder, fix, redeemAmount);

    const coverBurntBefore_B = await burner.getCoverSharesBurnt();
    await doReport(ctx, { excludeVaultsBalances: false, reportElVault: true, reportBurner: true });
    const coverBurned_B = (await burner.getCoverSharesBurnt()) - coverBurntBefore_B;

    // Both paths should burn ALL cover shares (limiter is loose enough)
    expect(coverBurned_A).to.equal(coverSharesRequested, "Path A should burn all cover shares");
    expect(coverBurned_B).to.equal(coverSharesRequested, "Path B should burn all cover shares too");

    await setMaxPositiveTokenRebase(ctx, savedRebase);
  });
});
