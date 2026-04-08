import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

import {
  assertReserveAllocationInvariant,
  captureState,
  doReport,
  ProtocolState,
  redeemExact,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

const DEPOSIT = ether("1000");
const RATIO_BP = 500n;

describe("Integration: Redeems reserve — additional push-specific scenarios", () => {
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
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  it("accumulated redeems across frames — all burned in single report, rate exactly preserved", async () => {
    const { lido, burner } = ctx.contracts;

    await seedReserve(ctx, holder, reserveManager, { deposit: DEPOSIT, redeemsReserveRatioBP: RATIO_BP });

    const before: ProtocolState = await captureState(lido);

    // --- 3 redeems without intermediate report ---
    const redeem1Shares = await lido.getSharesByPooledEth(ether("5"));
    const redeem1Ether = await lido.getPooledEthByShares(redeem1Shares);
    await redeemExact(lido, holder, fix, ether("5"));

    const redeem2Shares = await lido.getSharesByPooledEth(ether("5"));
    const redeem2Ether = await lido.getPooledEthByShares(redeem2Shares);
    await redeemExact(lido, holder, fix, ether("5"));

    const redeem3Shares = await lido.getSharesByPooledEth(ether("5"));
    const redeem3Ether = await lido.getPooledEthByShares(redeem3Shares);
    await redeemExact(lido, holder, fix, ether("5"));

    const totalShares = redeem1Shares + redeem2Shares + redeem3Shares;
    const totalEther = redeem1Ether + redeem2Ether + redeem3Ether;

    // Verify: vault delta = sum of all redeemed ETH (tracked stale, actual decreased)
    const trackedReserve = await lido.getRedeemsReserve();
    const actualVaultBalance = await ethers.provider.getBalance(fix.address);
    expect(trackedReserve - actualVaultBalance).to.equal(totalEther);
    expect(trackedReserve).to.equal(before.reserve);

    // Verify: all redeemed shares accumulated on burner
    expect(await fix.vault.getRedeemedShares()).to.equal(totalShares);
    expect(await fix.vault.getRedeemedEther()).to.equal(totalEther);

    // Verify: rate exactly unchanged between reports (stale overcount cancels deferred burn)
    expect(await lido.getPooledEthByShares(ether("1"))).to.equal(before.shareRate);
    await assertReserveAllocationInvariant(lido);

    // --- Single report: all shares burned, state reconciled ---
    await doReport(ctx);

    const after: ProtocolState = await captureState(lido);

    // Verify: all shares burned, counters reset
    expect(await fix.vault.getRedeemedShares()).to.equal(0n);
    expect(await fix.vault.getRedeemedEther()).to.equal(0n);

    // Verify: tracked == actual (reconciled)
    expect(await lido.getRedeemsReserve()).to.equal(await ethers.provider.getBalance(fix.address));

    // Verify: rate exactly preserved, shares decreased by exact total
    expect(after.shareRate).to.equal(before.shareRate);
    expect(after.totalShares).to.equal(before.totalShares - totalShares);
    expect(after.totalPooledEther).to.equal(before.totalPooledEther - totalEther);
    await assertReserveAllocationInvariant(lido);
  });
});
