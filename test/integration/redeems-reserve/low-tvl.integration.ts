import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

import {
  assertReserveAllocationInvariant,
  assertReserveState,
  captureState,
  doReport,
  fundElRewards,
  getAmountOfETHLocked,
  getRedeemAmount,
  ProtocolState,
  redeemExact,
  requestWithdrawal,
  resetProtocolState,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

const ALICE_DEPOSIT = ether("100");
const BOB_DEPOSIT = ether("100");
const RATIO_BP = 500n;
const EL_REWARDS = ether("1");

describe("Integration: Redeems reserve — low TVL impact", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let reserveManager: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  let fix: VaultFixture;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [alice, bob] = await ethers.getSigners();
    reserveManager = alice;

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

  it("small TVL: redeem + WQ + rebase with two holders", async () => {
    const { lido, withdrawalQueue, locator } = ctx.contracts;
    const elVaultAddr = await locator.elRewardsVault();

    // --- Alice and Bob deposit 100 ETH each, set ratio, process report ---
    await seedReserve(ctx, alice, reserveManager, { deposit: ALICE_DEPOSIT, redeemsReserveRatioBP: RATIO_BP });
    await lido.connect(bob).submit(ZeroAddress, { value: BOB_DEPOSIT });
    await doReport(ctx);

    const state0: ProtocolState = await captureState(lido);

    assertReserveState(state0, RATIO_BP);
    await assertReserveAllocationInvariant(lido);

    // --- Alice redeems entire reserve ---
    const redeemAmount = await getRedeemAmount(lido, "full");
    const redeemShares = await lido.getSharesByPooledEth(redeemAmount);
    const redeemEther = await lido.getPooledEthByShares(redeemShares);

    await redeemExact(lido, alice, fix, redeemAmount);

    const state1: ProtocolState = await captureState(lido);

    // Verify: pending shares on burner, available reserve ≈ 0 (tracked reserve stale, vault drained)
    expect(state1.reserve - (await fix.vault.getRedeemed())[0]).to.be.closeTo(0n, 10n);
    expect(state1.shareRate).to.equal(state0.shareRate);
    await assertReserveAllocationInvariant(lido);

    // --- Bob requests full WQ withdrawal ---
    const bobBalance = await lido.balanceOf(bob.address);
    const requestId = await requestWithdrawal(ctx, bob, bobBalance);

    // --- Fund EL rewards, process report with WQ finalization ---
    await fundElRewards(ctx, EL_REWARDS);

    const reportResult = await doReport(ctx, {
      excludeVaultsBalances: false,
      reportElVault: true,
      skipWithdrawals: false,
    });

    const state2: ProtocolState = await captureState(lido);
    const ethLocked = await getAmountOfETHLocked(ctx, reportResult);
    const [requestStatus] = await withdrawalQueue.getWithdrawalStatus([requestId]);
    const deferredRewards = await ethers.provider.getBalance(elVaultAddr);
    const appliedRewards = EL_REWARDS - deferredRewards;

    // Verify: shares burned, counters reset
    expect((await fix.vault.getRedeemed())[0]).to.equal(0n);

    expect(requestStatus.isFinalized).to.equal(true);
    expect(await withdrawalQueue.unfinalizedStETH()).to.equal(0n);

    // Verify: reserve refilled on smaller base
    // state1.internalEther is stale (overcounted by redeemEther), subtract to get reconciled value
    expect(state2.internalEther).to.equal(state1.internalEther - redeemEther + appliedRewards - ethLocked);
    assertReserveState(state2, RATIO_BP);
    await assertReserveAllocationInvariant(lido);

    // Verify: reserveTarget shrunk proportionally to internalEther drop
    const internalEtherDrop = state0.internalEther - state2.internalEther;
    expect(state0.reserveTarget - state2.reserveTarget).to.be.closeTo((RATIO_BP * internalEtherDrop) / 10_000n, 10n);

    // Verify: shareRate increased from EL rewards on smaller post-WQ base
    const expectedShareRate0 = (state0.totalPooledEther * ether("1")) / state0.totalShares;
    const expectedShareRate2 = (state2.totalPooledEther * ether("1")) / state2.totalShares;
    expect(state2.shareRate - state0.shareRate).to.equal(expectedShareRate2 - expectedShareRate0);

    // --- Second report: deferred rewards picked up, reserve reaches final target ---
    await doReport(ctx, {
      excludeVaultsBalances: false,
      reportElVault: true,
    });

    const state3: ProtocolState = await captureState(lido);
    const elVaultAfter = await ethers.provider.getBalance(elVaultAddr);

    expect(state3.internalEther).to.be.closeTo(state2.internalEther + deferredRewards, 10n);
    expect(elVaultAfter).to.equal(0n);
    assertReserveState(state3, RATIO_BP);
    await assertReserveAllocationInvariant(lido);
  });
});
