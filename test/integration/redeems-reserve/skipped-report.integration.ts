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
  expectedReserveTarget,
  ProtocolState,
  redeemExact,
  resetProtocolState,
  seedReserve,
  setupVault,
  skipReport,
  VaultFixture,
} from "./helpers";

const DEPOSIT = ether("1000");
const RATIO_BP = 500n;
const REDEEM_1 = ether("20");
const REDEEM_2 = ether("15");
const NEW_USER_DEPOSIT = ether("200");

describe("Integration: Redeems reserve — skipped report", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let reserveManager: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let newUser: HardhatEthersSigner;

  let fix: VaultFixture;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [holder, newUser] = await ethers.getSigners();
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

  it("skip → drain → deposit → recovery", async () => {
    const { lido, burner } = ctx.contracts;

    // --- Seed reserve, process report ---
    await seedReserve(ctx, holder, reserveManager, { deposit: DEPOSIT, redeemsReserveRatioBP: RATIO_BP });

    const state0: ProtocolState = await captureState(lido);
    const depositable0 = await lido.getDepositableEther();
    assertReserveState(state0, RATIO_BP);
    await assertReserveAllocationInvariant(lido);

    // --- Skip report, verify state unchanged ---
    await skipReport(ctx);

    expect(await captureState(lido)).to.deep.equal(state0);
    expect(await lido.getDepositableEther()).to.equal(depositable0);
    await assertReserveAllocationInvariant(lido);

    // --- Redeem 20 ETH ---
    const redeemShares1 = await lido.getSharesByPooledEth(REDEEM_1);
    const redeemEther1 = await lido.getPooledEthByShares(redeemShares1);

    await redeemExact(lido, holder, fix, REDEEM_1);

    const state1: ProtocolState = await captureState(lido);

    // Verify: push-specific — TPE and totalShares stale, rate preserved, depositable unchanged
    expect(state1.totalPooledEther).to.equal(state0.totalPooledEther);
    expect(state1.totalShares).to.equal(state0.totalShares);
    expect(state1.shareRate).to.equal(state0.shareRate);
    expect(await lido.getDepositableEther()).to.equal(depositable0);
    await assertReserveAllocationInvariant(lido);

    // Verify: redeem shares pending on burner
    expect(await fix.vault.getRedeemedShares()).to.equal(redeemShares1);
    expect(await fix.vault.getRedeemedEther()).to.equal(redeemEther1);

    // --- Report to refill reserve ---
    await doReport(ctx);

    const state2: ProtocolState = await captureState(lido);

    // Verify: shares burned, counters reset, reserve refilled
    expect(await fix.vault.getRedeemedShares()).to.equal(0n);
    expect(await fix.vault.getRedeemedEther()).to.equal(0n);
    expect(state2.totalPooledEther).to.equal(state0.totalPooledEther - redeemEther1);
    expect(state2.totalShares).to.equal(state0.totalShares - redeemShares1);
    expect(state2.shareRate).to.equal(state0.shareRate);
    assertReserveState(state2, RATIO_BP);
    await assertReserveAllocationInvariant(lido);

    // --- Skip report again, verify state unchanged ---
    await skipReport(ctx);

    expect(await captureState(lido)).to.deep.equal(state2);
    await assertReserveAllocationInvariant(lido);

    // --- New user submits 200 ETH ---
    const targetBeforeDeposit = state2.reserveTarget;
    const depositableBeforeDeposit = await lido.getDepositableEther();

    await lido.connect(newUser).submit(ZeroAddress, { value: NEW_USER_DEPOSIT });

    const state3: ProtocolState = await captureState(lido);
    const targetAfterDeposit = expectedReserveTarget(state3.internalEther, RATIO_BP);

    // Verify: reserveTarget grew proportionally, reserve unchanged, depositable grew
    expect(state3.reserveTarget).to.equal(targetAfterDeposit);
    expect(targetAfterDeposit - targetBeforeDeposit).to.equal(
      expectedReserveTarget(state3.internalEther - state2.internalEther, RATIO_BP),
    );
    expect(state3.reserve).to.equal(state2.reserve);
    expect(await lido.getDepositableEther()).to.equal(depositableBeforeDeposit + NEW_USER_DEPOSIT);
    await assertReserveAllocationInvariant(lido);

    // --- Redeem 15 ETH ---
    const redeemShares2 = await lido.getSharesByPooledEth(REDEEM_2);
    const redeemEther2 = await lido.getPooledEthByShares(redeemShares2);
    const depositableBeforeRedeem2 = await lido.getDepositableEther();

    await redeemExact(lido, holder, fix, REDEEM_2);

    const state4: ProtocolState = await captureState(lido);

    // Verify: push-specific — reserve stale, depositable unchanged
    expect(state4.reserve).to.equal(state3.reserve);
    expect(state4.totalPooledEther).to.equal(state3.totalPooledEther);
    expect(state4.totalShares).to.equal(state3.totalShares);
    expect(state4.shareRate).to.equal(state3.shareRate);
    expect(await lido.getDepositableEther()).to.equal(depositableBeforeRedeem2);
    await assertReserveAllocationInvariant(lido);

    // Verify: redeem shares pending on burner
    expect(await fix.vault.getRedeemedShares()).to.equal(redeemShares2);
    expect(await fix.vault.getRedeemedEther()).to.equal(redeemEther2);

    // --- Report to refill reserve to new higher target ---
    await doReport(ctx);

    const state5: ProtocolState = await captureState(lido);

    // Verify: shares burned, counters reset, reserve refilled to new target
    expect(await fix.vault.getRedeemedShares()).to.equal(0n);
    expect(await fix.vault.getRedeemedEther()).to.equal(0n);
    assertReserveState(state5, RATIO_BP);
    expect(state5.reserveTarget).to.be.closeTo(targetAfterDeposit - expectedReserveTarget(redeemEther2, RATIO_BP), 10n);
    await assertReserveAllocationInvariant(lido);
  });
});
