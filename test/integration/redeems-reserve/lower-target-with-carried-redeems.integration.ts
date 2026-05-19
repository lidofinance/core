import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether, impersonate } from "lib";
import {
  getProtocolContext,
  ProtocolContext,
  report,
  submitReportDataWithConsensus,
  waitNextAvailableReportTime,
} from "lib/protocol";

import { Snapshot } from "test/suite";

import {
  assertReserveAllocationInvariant,
  doReport,
  mineBlocks,
  redeemExact,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

const DEPOSIT = ether("1000");
const RATIO_BP = 500n;
const REDEEM = ether("1");

describe("Integration: Redeems reserve — lowering target while a post-refSlot redeem is carried", () => {
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
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  // Scenario:
  // 1. Reserve seeded at 5% ratio, buffer holds full reserve.
  // 2. Advance to next reportable frame (refSlot R).
  // 3. User redeems 1 ETH inside frame R — live counter grows to 1 ETH,
  //    snapshot for R stays at 0 (RefSlotCache rotates valueOnRefSlot=0 because
  //    previous reconcile already anchored _storage.refSlot to R).
  // 4. Governance lowers redeems reserve ratio to 0.
  // 5. Report for refSlot R is submitted at the same refSlot — Accounting reads
  //    getRedeemedForLastRefSlot()==0, so it passes (0, 0) to Lido. The buffer
  //    reconciles to _reserveBalance=0 while _redeemedEther.value=1 stays carried.
  //    Lido sets REDEEMS_RESERVE_POSITION=0 (target=0) and skips fundReserve.
  // 6. Next report at refSlot R' picks up the carried 1 ETH via getValue path
  //    (currentRefSlot != _storage.refSlot), tries buffer.reconcile(1, 1):
  //       unredeemed = _reserveBalance - _redeemedEther.value = 0 - 1 → underflow.
  //
  // Expected (fixed) behavior: the next report must succeed. The invariant
  // `_reserveBalance >= _redeemedEther.value` must hold after every reconcile.
  it("next report must not revert in buffer.reconcile after target drops to 0", async () => {
    const { lido, accountingOracle, hashConsensus } = ctx.contracts;

    // --- 1. Advance to next reportable frame, stay inside it ---
    const { reportRefSlot } = await waitNextAvailableReportTime(ctx);
    await mineBlocks(3);

    // --- 2. Redeem inside the upcoming report's refSlot ---
    await redeemExact(lido, holder, fix, REDEEM);

    const [liveEther, liveShares] = await fix.vault.getRedeemed();
    expect(liveEther).to.be.gt(0n);
    expect(liveShares).to.be.gt(0n);
    // Snapshot for current refSlot must be 0 — Accounting will consume 0 in this report.
    expect(await fix.vault.getRedeemedForLastRefSlot()).to.deep.equal([0n, 0n]);

    // --- 3. Governance lowers target ratio to 0 ---
    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(0n);

    // --- 4. DryRun for refSlot R (post-redeem state) then submit at same refSlot ---
    const dry = await report(ctx, {
      clDiff: 0n,
      excludeVaultsBalances: true,
      skipWithdrawals: true,
      refSlot: reportRefSlot,
      waitNextReportTime: false,
      dryRun: true,
    });

    await submitReportDataWithConsensus(ctx, dry.data);

    const { addresses } = await hashConsensus.getFastLaneMembers();
    const member = await impersonate(addresses[0], ether("1"));
    await accountingOracle.connect(member).submitReportExtraDataEmpty();

    // --- 5. State after first report: Lido reserve floored at the buffer's carry,
    //        buffer refunded to match. Invariant `_reserveBalance >= _redeemedEther.value`
    //        is preserved so the next `reconcile` cannot underflow. ---
    expect(await lido.getRedeemsReserveTarget()).to.equal(0n);
    expect(await lido.getRedeemsReserve()).to.equal(liveEther);
    expect(await fix.vault.getReserveBalance()).to.equal(liveEther);
    expect(await ethers.provider.getBalance(fix.address)).to.equal(liveEther);

    const [carriedEther, carriedShares] = await fix.vault.getRedeemed();
    expect(carriedEther).to.equal(liveEther);
    expect(carriedShares).to.equal(liveShares);

    // Explicit invariant: `_reserveBalance == _redeemedEther.value` after report (floor matched carry).
    expect(await fix.vault.getReserveBalance()).to.equal(carriedEther);

    await assertReserveAllocationInvariant(lido);
  });
});
