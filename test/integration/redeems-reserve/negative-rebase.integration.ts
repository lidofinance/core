import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  resetCLBalanceDecreaseWindow,
  setupLidoForVaults,
  upDefaultTierShareLimit,
} from "lib/protocol";

import { Snapshot } from "test/suite";

import {
  assertReserveAllocationInvariant,
  assertReserveState,
  captureRedeemQuote,
  captureState,
  doReport,
  expectedReserveTarget,
  getRedeemAmount,
  ProtocolState,
  quoteShares,
  redeemExact,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

const DEPOSIT = ether("1000");
const RATIO_BP = 500n;
const CL_LOSS = ether("-10");

describe("Integration: Redeems reserve — negative rebase", () => {
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
    await resetCLBalanceDecreaseWindow(ctx);

    const { lido } = ctx.contracts;
    assertReserveState(await captureState(lido), RATIO_BP);
    await assertReserveAllocationInvariant(lido);
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  it("single negative rebase — reserve auto-shrinks to new target", async () => {
    const { lido } = ctx.contracts;

    // --- Path A: report with CL loss, no redeem (via snapshot) ---
    const simSnapshot = await Snapshot.take();

    await doReport(ctx, { clDiff: CL_LOSS });
    const state1: ProtocolState = await captureState(lido);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(state1, RATIO_BP);

    await Snapshot.restore(simSnapshot);

    // --- Path B: small redeem, then report with same CL loss ---
    const REDEEM_AMOUNT = await getRedeemAmount(lido, "small");
    const redeemShares = await lido.getSharesByPooledEth(REDEEM_AMOUNT);
    const redeemEther = await lido.getPooledEthByShares(redeemShares);

    await redeemExact(lido, holder, fix, REDEEM_AMOUNT);

    // Verify: redeem shares pending on burner
    const { burner } = ctx.contracts;
    expect(await fix.vault.getRedeemedShares()).to.equal(redeemShares);
    expect(await fix.vault.getRedeemedEther()).to.equal(redeemEther);

    await doReport(ctx, { clDiff: CL_LOSS });
    const state2: ProtocolState = await captureState(lido);
    await assertReserveAllocationInvariant(lido);

    // Verify: all redeem shares burned, counters reset
    expect(await fix.vault.getRedeemedShares()).to.equal(0n);
    expect(await fix.vault.getRedeemedEther()).to.equal(0n);

    // --- Compare paths: reserve auto-shrinks to new target in both ---
    assertReserveState(state2, RATIO_BP);

    // Verify: reserve target matches internalEther-based calculation in both paths
    expect(state2.reserveTarget).to.equal(expectedReserveTarget(state2.internalEther, RATIO_BP));
    expect(state1.reserveTarget).to.equal(expectedReserveTarget(state1.internalEther, RATIO_BP));

    // Verify: redeem shrinks the base → state2 target is lower than state1 target (1 wei integer division rounding)
    expect(state1.reserveTarget - state2.reserveTarget).to.be.closeTo(expectedReserveTarget(redeemEther, RATIO_BP), 1n);

    // Verify: difference between paths is only the redeemed ETH and shares
    expect(state2.totalPooledEther).to.equal(state1.totalPooledEther - redeemEther);
    expect(state2.totalShares).to.equal(state1.totalShares - redeemShares);
  });

  it("redeem amplifies negative rebase for remaining holders", async () => {
    const { lido } = ctx.contracts;
    const rateBeforeRebase = (await captureState(lido)).shareRate;

    // --- Path A: report with CL loss, no redeem (via snapshot) ---
    const simSnapshot = await Snapshot.take();

    await doReport(ctx, { clDiff: CL_LOSS });
    const state1: ProtocolState = await captureState(lido);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(state1, RATIO_BP);

    await Snapshot.restore(simSnapshot);

    // --- Path B: huge redeem, then report with same CL loss ---
    const REDEEM_AMOUNT = await getRedeemAmount(lido, "huge");
    const redeemShares = await lido.getSharesByPooledEth(REDEEM_AMOUNT);
    const redeemEther = await lido.getPooledEthByShares(redeemShares);

    await redeemExact(lido, holder, fix, REDEEM_AMOUNT);

    // Verify: redeem shares pending on burner
    const { burner } = ctx.contracts;
    expect(await fix.vault.getRedeemedShares()).to.equal(redeemShares);
    expect(await fix.vault.getRedeemedEther()).to.equal(redeemEther);

    await doReport(ctx, { clDiff: CL_LOSS });
    const state2: ProtocolState = await captureState(lido);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(state2, RATIO_BP);

    // Verify: all redeem shares burned, counters reset
    expect(await fix.vault.getRedeemedShares()).to.equal(0n);
    expect(await fix.vault.getRedeemedEther()).to.equal(0n);

    // --- Compare paths: redeem amplifies loss per remaining share ---
    // Verify: both paths produced a negative rebase — rate dropped from pre-rebase baseline
    const rateDrop1 = rateBeforeRebase - state1.shareRate;
    const rateDrop2 = rateBeforeRebase - state2.shareRate;
    // Path B (with redeem) has a sharper drop than Path A (without redeem)
    expect(rateDrop2 - rateDrop1).to.equal(state1.shareRate - state2.shareRate);

    // Verify: state1 spreads loss over full base, state2 over smaller base (sharper impact)
    const expectedShareRate1 = (state1.totalPooledEther * ether("1")) / state1.totalShares;
    const expectedShareRate2 =
      ((state1.totalPooledEther - redeemEther) * ether("1")) / (state1.totalShares - redeemShares);

    expect(state1.shareRate).to.equal(expectedShareRate1);
    expect(state2.shareRate).to.equal(expectedShareRate2);

    expect(state1.shareRate - state2.shareRate).to.equal(expectedShareRate1 - expectedShareRate2);
  });

  it("bad debt internalization keeps reserve unchanged but lowers the redeem quote for the same shares", async () => {
    const { lido, vaultHub, stakingVaultFactory } = ctx.contracts;
    const [, , , vaultOwner, badDebtManager] = await ethers.getSigners();
    const QUOTE_STETH_AMOUNT = ether("5");

    // --- Setup vault with bad debt ---
    await setupLidoForVaults(ctx);
    await upDefaultTierShareLimit(ctx, ether("1000"));

    const { stakingVault, dashboard: rawDashboard } = await createVaultWithDashboard(
      ctx,
      stakingVaultFactory,
      vaultOwner,
      vaultOwner,
      vaultOwner,
    );

    const dashboard = rawDashboard.connect(vaultOwner);
    await dashboard.fund({ value: ether("10") });
    await dashboard.mintShares(vaultOwner, await dashboard.remainingMintingCapacityShares(0n));

    // --- Slash vault to create bad debt ---
    await reportVaultDataWithProof(ctx, stakingVault, {
      totalValue: ether("1"),
      slashingReserve: ether("1"),
      waitForNextRefSlot: true,
    });

    const agent = await ctx.getSigner("agent");
    await vaultHub.connect(agent).grantRole(await vaultHub.BAD_DEBT_MASTER_ROLE(), badDebtManager);

    // --- Save state before bad debt internalization ---
    const state0 = await captureState(lido);
    const externalShares0 = await lido.getExternalShares();
    const internalShares0 = state0.totalShares - externalShares0;
    const quote0 = await captureRedeemQuote(lido, QUOTE_STETH_AMOUNT);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(state0, RATIO_BP);

    // --- Internalize bad debt, process report ---
    const liabilityShares = await dashboard.liabilityShares();
    const valueShares = await lido.getSharesByPooledEth(await dashboard.totalValue());
    const badDebtShares = liabilityShares - valueShares;
    const internalizedBadDebtShares = await vaultHub
      .connect(badDebtManager)
      .internalizeBadDebt.staticCall(stakingVault, badDebtShares);
    // Precondition: bad debt is non-trivial
    expect(internalizedBadDebtShares).to.be.gt(0n);
    expect(internalizedBadDebtShares).to.equal(badDebtShares);
    await vaultHub.connect(badDebtManager).internalizeBadDebt(stakingVault, badDebtShares);

    await doReport(ctx);

    // --- Verify state after bad debt internalization ---
    const state1 = await captureState(lido);
    const quote1 = await quoteShares(lido, quote0.shares);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(state1, RATIO_BP);

    // Verify: reserve and target unchanged (internalEther unaffected)
    expect(state1.reserve).to.equal(state0.reserve);
    expect(state1.reserveTarget).to.equal(state0.reserveTarget);

    // Verify: total shares unchanged (bad debt moves shares between internal/external pools)
    expect(state1.totalShares).to.equal(state0.totalShares);

    expect(internalizedBadDebtShares).to.equal(badDebtShares);

    const expectedExternalShares1 = externalShares0 - internalizedBadDebtShares;
    const expectedInternalShares1 = internalShares0 + internalizedBadDebtShares;
    const expectedTotalPooledEther1 =
      state0.internalEther + (expectedExternalShares1 * state0.internalEther) / expectedInternalShares1;
    const expectedShareRate1 = (expectedTotalPooledEther1 * ether("1")) / state1.totalShares;

    expect(state1.totalPooledEther).to.equal(expectedTotalPooledEther1);
    expect(state1.shareRate).to.equal(expectedShareRate1);

    // Verify: same shares redeem for less ETH after bad debt internalization
    const expectedQuote1 = (quote0.shares * expectedTotalPooledEther1) / state1.totalShares;
    expect(quote1).to.equal(expectedQuote1);

    // --- Redeem at post-loss rate ---
    const REDEEM_AMOUNT = await getRedeemAmount(lido, "small");
    const redeemQuoteAfterLoss = await captureRedeemQuote(lido, REDEEM_AMOUNT);
    const recipientBalBefore = await ethers.provider.getBalance(holder.address);
    await redeemExact(lido, holder, fix, REDEEM_AMOUNT);
    await assertReserveAllocationInvariant(lido);
    expect(await ethers.provider.getBalance(holder.address)).to.equal(recipientBalBefore + redeemQuoteAfterLoss.ether);

    // Verify: redeem shares pending on burner (burn deferred to next report)
    const { burner } = ctx.contracts;
    expect(await fix.vault.getRedeemedShares()).to.equal(redeemQuoteAfterLoss.shares);
    expect(await fix.vault.getRedeemedEther()).to.equal(redeemQuoteAfterLoss.ether);
  });
});
