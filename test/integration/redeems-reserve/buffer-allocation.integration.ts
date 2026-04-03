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
  BufferState,
  captureBufferState,
  captureState,
  doReport,
  fundElRewards,
  getRedeemAmount,
  redeemExact,
  resetProtocolState,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

const DEFAULT_DEPOSIT = ether("1000");
const SECOND_DEPOSIT = DEFAULT_DEPOSIT / 10n;
const DEFAULT_RATIO_BP = 500n;
const DEPOSITS_RESERVE_TARGET = ether("100");

const SPLIT_RATIO_BP = 5000n;
const SPLIT_DEPOSIT = ether("1000");
const GROWTH_SHARE_ZERO = 0n;
const GROWTH_SHARE_EIGHTY = 8000n;

/** Queues withdrawal requests and asserts that unfinalized demand increased by the total requested amount */
async function requestWithdrawals({
  ctx,
  from,
  amounts,
}: {
  ctx: ProtocolContext;
  from: HardhatEthersSigner;
  amounts: readonly bigint[];
}): Promise<bigint[]> {
  const { lido, withdrawalQueue } = ctx.contracts;
  const totalRequested = amounts.reduce((sum, amount) => sum + amount, 0n);
  const unfinalizedBefore = await withdrawalQueue.unfinalizedStETH();
  const lastRequestIdBefore = await withdrawalQueue.getLastRequestId();

  await lido.connect(from).approve(withdrawalQueue, totalRequested);
  await withdrawalQueue.connect(from).requestWithdrawals([...amounts], from.address);

  const lastRequestIdAfter = await withdrawalQueue.getLastRequestId();
  expect(lastRequestIdAfter).to.equal(lastRequestIdBefore + BigInt(amounts.length));
  expect(await withdrawalQueue.unfinalizedStETH()).to.equal(unfinalizedBefore + totalRequested);
  return amounts.map((_, index) => lastRequestIdBefore + BigInt(index) + 1n);
}

/** Computes the currently unreserved part of the buffer after all reserves are accounted for */
function getUnreserved(state: BufferState) {
  return state.buffered - state.reserve - state.depositsReserve - state.withdrawalsReserve;
}

describe("Integration: Redeems reserve — buffer allocation", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let reserveManager: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let secondHolder: HardhatEthersSigner;

  let fix: VaultFixture;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [holder, secondHolder] = await ethers.getSigners();
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

  it("protects redeems reserve from WQ finalization and keeps depositable equal to deposits reserve plus unreserved", async () => {
    const { lido } = ctx.contracts;

    // --- Seed reserve, second holder deposits, process report ---
    await seedReserve(ctx, holder, reserveManager, {
      deposit: DEFAULT_DEPOSIT,
      redeemsReserveRatioBP: DEFAULT_RATIO_BP,
      depositsReserveTarget: DEPOSITS_RESERVE_TARGET,
    });
    await lido.connect(secondHolder).submit(ZeroAddress, { value: SECOND_DEPOSIT });
    await doReport(ctx, { excludeVaultsBalances: true, skipWithdrawals: true });

    const protocol0 = await captureState(lido);

    await assertReserveAllocationInvariant(lido);
    assertReserveState(protocol0, DEFAULT_RATIO_BP);

    // --- Request withdrawals exceeding unreserved buffer ---
    const firstAmount = DEFAULT_DEPOSIT - ether("100");
    const secondAmount = SECOND_DEPOSIT;
    const [firstRequestId] = await requestWithdrawals({ ctx, from: holder, amounts: [firstAmount] });
    const [secondRequestId] = await requestWithdrawals({ ctx, from: secondHolder, amounts: [secondAmount] });

    // Verify: total requested exceeds available for WQ (not all can be finalized in one report)
    const preReport = await captureBufferState(ctx);
    const availableForWQ = preReport.buffered - preReport.reserve - preReport.depositsReserve;
    expect(firstAmount + secondAmount).to.be.gt(availableForWQ);

    // --- Process report with WQ finalization ---
    await doReport(ctx, { skipWithdrawals: false, excludeVaultsBalances: true });

    const state1 = await captureBufferState(ctx);
    const protocol1 = await captureState(lido);
    const statuses = await ctx.contracts.withdrawalQueue.getWithdrawalStatus([firstRequestId, secondRequestId]);

    await assertReserveAllocationInvariant(lido);
    assertReserveState(protocol1, DEFAULT_RATIO_BP);

    expect(state1.reserve).to.equal(state1.reserveTarget);
    expect(statuses[0].isFinalized).to.equal(true);
    expect(statuses[1].isFinalized).to.equal(false);
    expect(state1.unfinalizedStETH).to.equal(statuses[1].amountOfStETH);
    expect(getUnreserved(state1)).to.equal(0n);
    expect(state1.withdrawalsReserve).to.equal(state1.buffered - state1.reserve - state1.depositsReserve);
    expect(state1.depositable).to.equal(state1.depositsReserve + getUnreserved(state1));
    expect(state1.depositsReserve).to.equal(DEPOSITS_RESERVE_TARGET);
  });

  it("splits shared buffer between reserve growth and WQ according to growthShareBP", async () => {
    const { lido } = ctx.contracts;

    // --- Seed reserve with 50% ratio, growthShare = 0 ---
    await seedReserve(ctx, holder, reserveManager, {
      deposit: SPLIT_DEPOSIT,
      redeemsReserveRatioBP: SPLIT_RATIO_BP,
      growthShareBP: GROWTH_SHARE_ZERO,
    });

    // --- Redeem to create reserve deficit, request WQ withdrawal ---
    const redeemAmount = await getRedeemAmount(lido, "huge");
    const redeemShares = await lido.getSharesByPooledEth(redeemAmount);
    const redeemEther = await lido.getPooledEthByShares(redeemShares);
    await redeemExact(lido, holder, fix, redeemAmount);

    // Verify: redeem shares pending on burner
    const { burner } = ctx.contracts;
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(redeemShares);
    expect(await fix.vault.getRedeemedEther()).to.equal(redeemEther);

    // --- Reconciliation report: burn redeem shares before capturing buffer state ---
    await doReport(ctx);

    // Verify: all redeem shares burned, counters reset
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(0n);
    expect(await fix.vault.getRedeemedEther()).to.equal(0n);

    const afterRedeem = await captureBufferState(ctx);
    await assertReserveAllocationInvariant(lido);

    const requestAmount = await lido.balanceOf(holder.address);
    await requestWithdrawals({ ctx, from: holder, amounts: [requestAmount] });

    const beforeReport = await captureBufferState(ctx);
    const restorePoint = await Snapshot.take();
    const sharedAllocationBefore = beforeReport.withdrawalsReserve + getUnreserved(beforeReport);

    // --- Path A: report with growthShare = 0 ---
    await doReport(ctx, { skipWithdrawals: true, excludeVaultsBalances: true });

    const growthZero = await captureBufferState(ctx);
    await assertReserveAllocationInvariant(lido);

    expect(afterRedeem.reserve).to.equal(beforeReport.reserve);
    expect(afterRedeem.depositable).to.equal(afterRedeem.depositsReserve + getUnreserved(afterRedeem));
    expect(getUnreserved(beforeReport)).to.equal(0n);
    expect(sharedAllocationBefore).to.equal(beforeReport.withdrawalsReserve);
    expect(growthZero.reserve).to.equal(beforeReport.reserve);
    expect(growthZero.withdrawalsReserve).to.equal(beforeReport.withdrawalsReserve);
    expect(growthZero.unfinalizedStETH).to.equal(beforeReport.unfinalizedStETH);
    expect(growthZero.unfinalizedStETH).to.equal(requestAmount);

    // Verify: EL rewards go to withdrawalsReserve, redeems reserve stays unchanged (growthShare=0)
    const EL_REWARDS = ether("1");
    await fundElRewards(ctx, EL_REWARDS);
    await doReport(ctx, { skipWithdrawals: true, excludeVaultsBalances: false, reportElVault: true });

    const withRewards = await captureBufferState(ctx);
    await assertReserveAllocationInvariant(lido);
    expect(withRewards.reserve).to.equal(growthZero.reserve);
    expect(withRewards.withdrawalsReserve).to.equal(growthZero.withdrawalsReserve + EL_REWARDS);

    await Snapshot.restore(restorePoint);

    // --- Path B: report with growthShare = 80% ---
    await lido.connect(reserveManager).setRedeemsReserveGrowthShare(GROWTH_SHARE_EIGHTY);
    await doReport(ctx, { skipWithdrawals: true, excludeVaultsBalances: true });

    const growthEighty = await captureBufferState(ctx);
    await assertReserveAllocationInvariant(lido);

    const minGrowth = (sharedAllocationBefore * GROWTH_SHARE_EIGHTY) / 10_000n;
    const growth =
      beforeReport.reserve + minGrowth < beforeReport.reserveTarget
        ? minGrowth
        : beforeReport.reserveTarget - beforeReport.reserve;

    expect(growthEighty.reserve).to.equal(beforeReport.reserve + growth);
    expect(growthEighty.withdrawalsReserve).to.equal(beforeReport.withdrawalsReserve - growth);
    expect(growthEighty.unfinalizedStETH).to.equal(beforeReport.unfinalizedStETH);
    expect(growthEighty.unfinalizedStETH).to.equal(requestAmount);
    expect(growthEighty.depositable).to.equal(growthEighty.depositsReserve + getUnreserved(growthEighty));
  });
});
