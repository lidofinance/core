import { expect } from "chai";
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
  redeemExact,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

const DEPOSIT = ether("1000");
const RATIO_BP = 500n;
const REDEEM_AMOUNT = ether("1");

describe("Integration: Redeems reserve — pause during frame", () => {
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

    const pauseRole = await fix.vault.PAUSE_ROLE();
    const resumeRole = await fix.vault.RESUME_ROLE();
    await fix.vault.connect(reserveManager).grantRole(pauseRole, reserveManager.address);
    await fix.vault.connect(reserveManager).grantRole(resumeRole, reserveManager.address);
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

  it("pause blocks redeem but lets the oracle report complete, resume restores redeem", async () => {
    const { lido } = ctx.contracts;

    // --- Pause the buffer indefinitely (doReport may advance past a finite pause window) ---
    const PAUSE_INFINITELY = await fix.vault.PAUSE_INFINITELY();
    await fix.vault.connect(reserveManager).pauseFor(PAUSE_INFINITELY);
    expect(await fix.vault.isPaused()).to.equal(true);

    // --- Redeem blocked ---
    await lido.connect(holder).approve(fix.address, REDEEM_AMOUNT + 10n, { gasPrice: 0 });
    await expect(
      fix.vault.connect(holder).redeem(REDEEM_AMOUNT, holder.address, { gasPrice: 0 }),
    ).to.be.revertedWithCustomError(fix.vault, "ResumedExpected");

    // --- Oracle report proceeds despite pause (withdrawUnredeemed/fundReserve not gated) ---
    await doReport(ctx);

    const stateDuringPause = await captureState(lido);
    const expectedTarget = expectedReserveTarget(stateDuringPause.internalEther, RATIO_BP);
    assertReserveState(stateDuringPause, RATIO_BP);
    expect(stateDuringPause.reserve).to.equal(expectedTarget);
    expect(await ethers.provider.getBalance(fix.address)).to.equal(expectedTarget);
    expect(await fix.vault.isPaused()).to.equal(true);
    await assertReserveAllocationInvariant(lido);

    // --- Resume and verify redeem works ---
    await fix.vault.connect(reserveManager).resume();
    expect(await fix.vault.isPaused()).to.equal(false);

    const shares = await lido.getSharesByPooledEth(REDEEM_AMOUNT);
    const etherAmount = await lido.getPooledEthByShares(shares);
    await redeemExact(lido, holder, fix, REDEEM_AMOUNT);

    expect(await fix.vault.getRedeemedEther()).to.equal(etherAmount);
    expect(await ethers.provider.getBalance(fix.address)).to.equal(expectedTarget - etherAmount);
  });
});
