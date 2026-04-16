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

  it("large redeem does not inflate rebase beyond limit", async () => {
    const { lido, burner } = ctx.contracts;

    const RATIO_BP = 2000n; // 20% reserve
    const MAX_REBASE = LIMITER_PRECISION_BASE / 100n; // 1%

    const savedRebase = await setMaxPositiveTokenRebase(ctx, MAX_REBASE);

    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: RATIO_BP });

    const stateSeeded: ProtocolState = await captureState(lido);

    const COVER_BURN = ether("30");
    await applyInsurance(ctx, holder, COVER_BURN);

    const headroom = (stateSeeded.internalEther * MAX_REBASE) / LIMITER_PRECISION_BASE;
    const REWARDS = headroom / 2n;
    await fundElRewards(ctx, REWARDS);

    const stateBeforeReport: ProtocolState = await captureState(lido);

    // ── Path A: report with cover burn, NO redeem ──
    const pathASnapshot = await Snapshot.take();

    const coverBurntBefore_A = await burner.getCoverSharesBurnt();
    await doReport(ctx, {
      excludeVaultsBalances: false,
      reportElVault: true,
      reportWithdrawalsVault: false,
      reportBurner: true,
    });
    const coverBurned_A = (await burner.getCoverSharesBurnt()) - coverBurntBefore_A;

    const stateAfterReport_A: ProtocolState = await captureState(lido);
    const rebase_A = computeRebase(stateBeforeReport, stateAfterReport_A);
    await assertReserveAllocationInvariant(lido);

    // Path A: limiter caps cover burn
    expect(coverBurned_A).to.be.gt(0n);
    expect(coverBurned_A).to.be.lt(await lido.getSharesByPooledEth(COVER_BURN));

    await Snapshot.restore(pathASnapshot);

    // ── Path B: drain reserve THEN same report ──
    const redeemAmount = await getRedeemAmount(lido, "full");
    const redeemShares = await lido.getSharesByPooledEth(redeemAmount);
    const redeemEther = await lido.getPooledEthByShares(redeemShares);
    await redeemExact(lido, holder, fix, redeemAmount);

    expect(await fix.vault.getRedeemedEther()).to.equal(redeemEther);

    const coverBurntBefore_B = await burner.getCoverSharesBurnt();
    await doReport(ctx, {
      excludeVaultsBalances: false,
      reportElVault: true,
      reportWithdrawalsVault: false,
      reportBurner: true,
    });
    const coverBurned_B = (await burner.getCoverSharesBurnt()) - coverBurntBefore_B;

    const stateAfterReport_B: ProtocolState = await captureState(lido);
    const rebase_B = computeRebase(stateBeforeReport, stateAfterReport_B);
    await assertReserveAllocationInvariant(lido);

    expect(await fix.vault.getRedeemedEther()).to.equal(0n);

    // ── Assertions ──

    // 1. Both paths have positive rebase, neither exceeds the limit
    expect(rebase_A).to.be.gt(0n);
    expect(rebase_B).to.be.gt(0n);
    expect(rebase_A).to.be.lte(MAX_REBASE + 1n);
    expect(rebase_B).to.be.lte(MAX_REBASE + 1n);

    // 2. Path B burns LESS cover — redeem shares are guaranteed from nonCover
    //    via _guaranteedNonCover parameter, so cover budget is not expanded by redeems.
    //    Cover insurance application is deferred to subsequent frames.
    expect(coverBurned_B).to.be.lt(coverBurned_A);

    await setMaxPositiveTokenRebase(ctx, savedRebase);
  });

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
    expect(coverBurned_A).to.equal(coverSharesRequested);
    expect(coverBurned_B).to.equal(coverSharesRequested);

    await setMaxPositiveTokenRebase(ctx, savedRebase);
  });
});
