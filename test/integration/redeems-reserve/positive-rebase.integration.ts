import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

import {
  applyInsurance,
  assertReserveAllocationInvariant,
  assertReserveState,
  captureState,
  doReport,
  fundElRewards,
  getRedeemAmount,
  ProtocolState,
  RedeemerFixture,
  redeemExact,
  resetProtocolState,
  seedReserve,
  setupRedeemer,
} from "./helpers";

const DEPOSIT = ether("1000");
const RATIO_BP = 500n;
const REWARDS = ether("1");

describe("Integration: Redeems reserve — positive rebase", () => {
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

    await seedReserve(ctx, holder, reserveManager, { deposit: DEPOSIT, redeemsReserveRatioBP: RATIO_BP });

    const { lido } = ctx.contracts;
    expect(await lido.getRedeemsReserve()).to.equal(await lido.getRedeemsReserveTarget());
    await assertReserveAllocationInvariant(lido);
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  it("EL rewards positive rebase on a smaller post-redeem base changes share rate while reserve stays at target", async () => {
    const { lido } = ctx.contracts;

    // --- Fund EL rewards, save pre-report state ---
    await fundElRewards(ctx, REWARDS);
    const state0: ProtocolState = await captureState(lido);

    // --- Path A: report without redeem (via snapshot) ---
    const simSnapshot = await Snapshot.take();

    await doReport(ctx, { excludeVaultsBalances: false, reportElVault: true, reportWithdrawalsVault: false });
    const state1: ProtocolState = await captureState(lido);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(state1, RATIO_BP);

    await Snapshot.restore(simSnapshot);

    // --- Path B: redeem, then report ---
    const REDEEM_AMOUNT = await getRedeemAmount(lido, "huge");
    const redeemShares = await lido.getSharesByPooledEth(REDEEM_AMOUNT);
    const redeemEther = await lido.getPooledEthByShares(redeemShares);

    await redeemExact(lido, holder, fix, REDEEM_AMOUNT);

    await doReport(ctx, { excludeVaultsBalances: false, reportElVault: true, reportWithdrawalsVault: false });
    const state2: ProtocolState = await captureState(lido);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(state2, RATIO_BP);

    // --- Compare paths: difference is only the redeemed ETH and shares ---
    expect(state1.totalPooledEther).to.equal(state0.totalPooledEther + REWARDS);
    expect(state1.totalShares).to.equal(state0.totalShares);

    expect(state2.totalPooledEther).to.equal(state0.totalPooledEther + REWARDS - redeemEther);
    expect(state2.totalShares).to.equal(state0.totalShares - redeemShares);

    const expectedState1ShareRate = ((state0.totalPooledEther + REWARDS) * ether("1")) / state0.totalShares;
    const expectedState2ShareRate =
      ((state0.totalPooledEther + REWARDS - redeemEther) * ether("1")) / (state0.totalShares - redeemShares);

    expect(state1.shareRate).to.equal(expectedState1ShareRate);
    expect(state2.shareRate).to.equal(expectedState2ShareRate);
  });

  it("insurance burn request keeps pre-report reserve state unchanged, then EL rewards positive rebase on a smaller base changes share rate", async () => {
    const { lido } = ctx.contracts;
    const BURN_AMOUNT = ether("2");

    // --- Apply insurance burn, verify reserve state unchanged ---
    const reserveBeforeBurn = await lido.getRedeemsReserve();
    const reserveTargetBeforeBurn = await lido.getRedeemsReserveTarget();
    const shareRateBeforeBurn = await lido.getPooledEthByShares(ether("1"));

    await applyInsurance(ctx, holder, BURN_AMOUNT);

    expect(await lido.getRedeemsReserve()).to.equal(reserveBeforeBurn);
    expect(await lido.getRedeemsReserveTarget()).to.equal(reserveTargetBeforeBurn);
    expect(await lido.getPooledEthByShares(ether("1"))).to.equal(shareRateBeforeBurn);

    // --- Fund EL rewards, save pre-report state ---
    await fundElRewards(ctx, REWARDS);
    const state0: ProtocolState = await captureState(lido);

    // --- Path A: report without redeem, with burn (via snapshot) ---
    const simSnapshot = await Snapshot.take();

    await doReport(ctx, {
      excludeVaultsBalances: false,
      reportElVault: true,
      reportWithdrawalsVault: false,
      reportBurner: true,
    });
    const state1: ProtocolState = await captureState(lido);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(state1, RATIO_BP);

    await Snapshot.restore(simSnapshot);

    // --- Path B: redeem at pre-burn share rate, then report with burn ---
    const REDEEM_AMOUNT = await getRedeemAmount(lido, "huge");
    const redeemShares = await lido.getSharesByPooledEth(REDEEM_AMOUNT);
    const redeemEther = await lido.getPooledEthByShares(redeemShares);

    await redeemExact(lido, holder, fix, REDEEM_AMOUNT);

    await doReport(ctx, {
      excludeVaultsBalances: false,
      reportElVault: true,
      reportWithdrawalsVault: false,
      reportBurner: true,
    });
    const state2: ProtocolState = await captureState(lido);
    await assertReserveAllocationInvariant(lido);
    assertReserveState(state2, RATIO_BP);

    // --- Compare paths: difference is only the redeemed ETH and shares ---
    expect(state1.totalPooledEther).to.equal(state0.totalPooledEther + REWARDS);
    expect(state2.totalPooledEther).to.equal(state0.totalPooledEther + REWARDS - redeemEther);
    expect(state2.totalShares).to.equal(state1.totalShares - redeemShares);

    const expectedState1ShareRate = (state1.totalPooledEther * ether("1")) / state1.totalShares;
    const expectedState2ShareRate = (state2.totalPooledEther * ether("1")) / state2.totalShares;

    expect(state1.shareRate).to.equal(expectedState1ShareRate);
    expect(state2.shareRate).to.equal(expectedState2ShareRate);
  });
});
