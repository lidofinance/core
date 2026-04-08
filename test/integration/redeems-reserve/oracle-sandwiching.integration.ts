import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext, resetCLBalanceDecreaseWindow } from "lib/protocol";

import { Snapshot } from "test/suite";

import {
  assertReserveAllocationInvariant,
  assertReserveState,
  captureRedeemQuote,
  captureState,
  doReport,
  fundElRewards,
  getRedeemAmount,
  redeemExact,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

const DEPOSIT = ether("1000");
const RATIO_BP = 500n;
const REWARDS = ether("1");
const CL_LOSS = ether("-10");
const ATTACKER_STETH = ether("100");
const ROUNDING_TOLERANCE = 10n;

describe("Integration: Redeems reserve — oracle report sandwiching", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let reserveManager: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  let fix: VaultFixture;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [holder, attacker] = await ethers.getSigners();
    reserveManager = holder;

    const { acl, lido } = ctx.contracts;
    const agent = await ctx.getSigner("agent");
    const role = await lido.BUFFER_RESERVE_MANAGER_ROLE();
    const hasRole = await acl["hasPermission(address,address,bytes32)"](reserveManager.address, lido.address, role);
    if (!hasRole) {
      await acl.connect(agent).grantPermission(reserveManager.address, lido.address, role);
    }

    fix = await setupVault(ctx, reserveManager, [attacker]);
  });

  beforeEach(async () => {
    await ethers.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    testSnapshot = await Snapshot.take();

    await seedReserve(ctx, holder, reserveManager, { deposit: DEPOSIT, redeemsReserveRatioBP: RATIO_BP });

    const { lido } = ctx.contracts;
    await assertReserveAllocationInvariant(lido);
    assertReserveState(await captureState(lido), RATIO_BP);
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  it("redeem before positive rebase then re-enter after returns fewer shares than were burned", async () => {
    const { lido, burner } = ctx.contracts;

    await transferStETH({ lido, from: holder, to: attacker, amount: ATTACKER_STETH });

    // --- Attacker redeems before positive rebase ---
    const attackerSharesBefore = await lido.sharesOf(attacker.address);

    const redeemAmount = await lido.balanceOf(attacker.address);
    const redeemQuote = await captureRedeemQuote(lido, redeemAmount);

    await redeemExact(lido, attacker, fix, redeemAmount);

    // Verify: pending shares on burner
    expect(await fix.vault.getRedeemedShares()).to.equal(redeemQuote.shares);

    // state0 is stale in push: TPE and totalShares unchanged (burn deferred to report)
    const state0 = await captureState(lido);

    // --- Report with EL rewards: burns redeem shares + applies rewards ---
    await fundElRewards(ctx, REWARDS);
    await doReport(ctx, { excludeVaultsBalances: false, reportElVault: true, reportWithdrawalsVault: false });

    const state1 = await captureState(lido);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(state1, RATIO_BP);

    // Verify: shares burned
    expect(await fix.vault.getRedeemedShares()).to.equal(0n);

    // --- Attacker re-enters at higher share rate ---
    const reenter = await submitEther({ lido, from: attacker, amount: redeemQuote.ether });

    // Report reconciled stale state: TPE decreased by redeemEther, totalShares decreased by redeemShares
    expect(state1.totalPooledEther).to.equal(state0.totalPooledEther - redeemQuote.ether + REWARDS);
    expect(state1.totalShares).to.equal(state0.totalShares - redeemQuote.shares);

    const expectedShareRate1 =
      ((state0.totalPooledEther - redeemQuote.ether + REWARDS) * ether("1")) /
      (state0.totalShares - redeemQuote.shares);
    expect(state1.shareRate).to.equal(expectedShareRate1);

    const expectedSharesBack = (redeemQuote.ether * state1.totalShares) / state1.totalPooledEther;
    const expectedSharesLost = redeemQuote.shares - expectedSharesBack;

    expect(reenter.shares).to.equal(expectedSharesBack);
    expect(redeemQuote.shares - reenter.shares).to.equal(expectedSharesLost);

    // Verify: attacker ended up with fewer shares — sandwich unprofitable
    const attackerSharesAfter = await lido.sharesOf(attacker.address);
    expect(attackerSharesBefore - attackerSharesAfter).to.equal(expectedSharesLost);
  });

  it("deposit before rebase then redeem after captures profit and leaves a lower share rate than the clean baseline", async () => {
    const { lido, burner } = ctx.contracts;

    // --- Path A: clean report without attacker deposit (via snapshot) ---
    await fundElRewards(ctx, REWARDS);

    const simSnapshot = await Snapshot.take();
    await doReport(ctx, { excludeVaultsBalances: false, reportElVault: true, reportWithdrawalsVault: false });
    const state1 = await captureState(lido);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(state1, RATIO_BP);
    await Snapshot.restore(simSnapshot);

    // --- Path B: attacker deposits before rebase, redeems after ---
    const attackerDepositAmount = await getRedeemAmount(lido, "huge");
    const attackDeposit = await submitEther({ lido, from: attacker, amount: attackerDepositAmount });

    await doReport(ctx, { excludeVaultsBalances: false, reportElVault: true, reportWithdrawalsVault: false });
    const postAttackReport = await captureState(lido);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(postAttackReport, RATIO_BP);

    const attackerBalance = await lido.balanceOf(attacker.address);
    const attackerRedeemQuote = await captureRedeemQuote(lido, attackerBalance);
    const attackerEthBefore = await ethers.provider.getBalance(attacker.address);

    await redeemExact(lido, attacker, fix, attackerBalance);

    // Verify: pending shares on burner (state2 is stale — TPE and shares unchanged)
    expect(await fix.vault.getRedeemedShares()).to.equal(attackerRedeemQuote.shares);

    const state2 = await captureState(lido);
    await assertReserveAllocationInvariant(lido);

    // --- Compare paths: attacker diluted the pool ---
    const expectedBaselineShareRate = (state1.totalPooledEther * ether("1")) / state1.totalShares;
    const expectedAttackShareRate = (postAttackReport.totalPooledEther * ether("1")) / postAttackReport.totalShares;
    const expectedRedeemPayout =
      (attackDeposit.shares * postAttackReport.totalPooledEther) / postAttackReport.totalShares;
    const expectedProfit = expectedRedeemPayout - attackerDepositAmount;

    // Verify: attacker received ETH from vault (gasPrice=0)
    expect(await ethers.provider.getBalance(attacker.address)).to.equal(attackerEthBefore + attackerRedeemQuote.ether);

    expect(state1.shareRate).to.equal(expectedBaselineShareRate);
    expect(postAttackReport.shareRate).to.equal(expectedAttackShareRate);
    expect(attackerRedeemQuote.shares).to.be.closeTo(attackDeposit.shares, 1n);
    expect(attackerRedeemQuote.ether).to.be.closeTo(expectedRedeemPayout, 1n);
    expect(attackerRedeemQuote.ether - attackerDepositAmount).to.be.closeTo(expectedProfit, 1n);

    // Stale state: TPE and shares unchanged after push redeem (burn deferred)
    expect(state2.totalPooledEther).to.equal(postAttackReport.totalPooledEther);
    expect(state2.totalShares).to.equal(postAttackReport.totalShares);
    expect(state2.shareRate).to.equal(postAttackReport.shareRate);

    // Verify: baseline (clean) share rate is higher than post-attack rate
    const baselineAdvantage = expectedBaselineShareRate - expectedAttackShareRate;
    expect(state1.shareRate - state2.shareRate).to.equal(baselineAdvantage);

    // Verify: attacker ends with 0 stETH
    expect(await lido.sharesOf(attacker.address)).to.be.closeTo(0n, 1n);
  });

  it("redeem before negative rebase then re-deposit after restores pooled ether and returns more shares than were burned", async () => {
    const { lido, burner } = ctx.contracts;

    await resetCLBalanceDecreaseWindow(ctx);
    await transferStETH({ lido, from: holder, to: attacker, amount: ATTACKER_STETH });

    // --- Save attacker state, simulate clean loss path (via snapshot) ---
    const attackerSharesBefore = await lido.sharesOf(attacker.address);

    const simSnapshot = await Snapshot.take();
    await doReport(ctx, { clDiff: CL_LOSS });
    const state1 = await captureState(lido);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(state1, RATIO_BP);
    await Snapshot.restore(simSnapshot);

    // --- Attacker redeems before negative rebase, re-deposits after ---
    const redeemAmount = await lido.balanceOf(attacker.address);
    const redeemQuote = await captureRedeemQuote(lido, redeemAmount);

    await redeemExact(lido, attacker, fix, redeemAmount);

    // Verify: pending shares on burner
    expect(await fix.vault.getRedeemedShares()).to.equal(redeemQuote.shares);

    await doReport(ctx, { clDiff: CL_LOSS });
    const lossPathState = await captureState(lido);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(lossPathState, RATIO_BP);

    // Verify: shares burned
    expect(await fix.vault.getRedeemedShares()).to.equal(0n);

    const reenter = await submitEther({ lido, from: attacker, amount: redeemQuote.ether });
    const state2 = await captureState(lido);
    await assertReserveAllocationInvariant(lido);

    const expectedSharesAfter = (redeemQuote.ether * lossPathState.totalShares) / lossPathState.totalPooledEther;
    const expectedState2TotalPooledEther = state1.totalPooledEther;
    const expectedState2TotalShares = state1.totalShares - redeemQuote.shares + expectedSharesAfter;
    const expectedState2ShareRate = (expectedState2TotalPooledEther * ether("1")) / expectedState2TotalShares;
    const expectedEscapedShares = expectedSharesAfter - redeemQuote.shares;

    expect(reenter.shares).to.equal(expectedSharesAfter);
    expect(reenter.shares - redeemQuote.shares).to.equal(expectedEscapedShares);
    expect(state2.totalPooledEther).to.equal(expectedState2TotalPooledEther);
    expect(state2.totalShares).to.equal(expectedState2TotalShares);
    expect(state2.shareRate).to.equal(expectedState2ShareRate);
    expect(state2.shareRate).to.equal(lossPathState.shareRate);

    // Verify: attacker ended up with more shares — escape sandwich profitable
    const attackerSharesAfter = await lido.sharesOf(attacker.address);
    expect(attackerSharesAfter - attackerSharesBefore).to.equal(expectedEscapedShares);
  });
});

type SubmitResult = {
  shares: bigint;
  stETH: bigint;
};

/** Mints stETH via submit and verifies exact share and stETH balance deltas */
async function submitEther({
  lido,
  from,
  amount,
}: {
  lido: ProtocolContext["contracts"]["lido"];
  from: HardhatEthersSigner;
  amount: bigint;
}): Promise<SubmitResult> {
  const sharesBefore = await lido.sharesOf(from.address);
  const balanceBefore = await lido.balanceOf(from.address);

  await lido.connect(from).submit(ZeroAddress, { value: amount });

  const sharesAfter = await lido.sharesOf(from.address);
  const balanceAfter = await lido.balanceOf(from.address);
  const shares = sharesAfter - sharesBefore;
  const stETH = balanceAfter - balanceBefore;

  expect(shares).to.equal(await lido.getSharesByPooledEth(amount));
  expect(stETH).to.be.closeTo(await lido.getPooledEthByShares(shares), ROUNDING_TOLERANCE);

  return { shares, stETH };
}

/** Transfers stETH and verifies the recipient exact balance delta */
async function transferStETH({
  lido,
  from,
  to,
  amount,
}: {
  lido: ProtocolContext["contracts"]["lido"];
  from: HardhatEthersSigner;
  to: HardhatEthersSigner;
  amount: bigint;
}) {
  const balanceBefore = await lido.balanceOf(to.address);

  await lido.connect(from).transfer(to.address, amount);

  expect(await lido.balanceOf(to.address)).to.be.closeTo(balanceBefore + amount, ROUNDING_TOLERANCE);
}
