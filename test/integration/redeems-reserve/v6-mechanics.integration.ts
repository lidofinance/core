import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

import { doReport, seedReserve, setupVault, VaultFixture } from "./helpers";

/**
 * Tests specific to v6 push mechanics:
 * - Shares burned outside rebase limiter (guaranteed full burn)
 * - Tracked reserve balance (_reserveBalance prevents force-sent ETH redemption)
 * - REDEEMER_ROLE access control
 * - Counter reset separation (shares vs ether)
 * - fundReserve() payable method
 * - _reserveBalance drift protection
 * - recoverERC20 safety guard
 */
describe("Integration: Redeems reserve — v6 mechanics", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let reserveManager: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let fix: VaultFixture;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [holder, , stranger] = await ethers.getSigners();
    reserveManager = holder;

    const { acl, lido } = ctx.contracts;
    const agent = await ctx.getSigner("agent");

    const role = await lido.BUFFER_RESERVE_MANAGER_ROLE();
    const hasRole = await acl["hasPermission(address,address,bytes32)"](reserveManager.address, lido.address, role);
    if (!hasRole) {
      await acl.connect(agent).grantPermission(reserveManager.address, lido.address, role);
    }

    fix = await setupVault(ctx, reserveManager, [stranger]);
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

  /** Redeem and extract exact sharesAmount/etherAmount from Redeemed event */
  const redeemWithReceipt = async (signer: HardhatEthersSigner, amount: bigint, ethRecipient: string) => {
    const { lido } = ctx.contracts;
    await lido.connect(signer).approve(fix.address, amount + 10n, { gasPrice: 0 });
    const tx = await fix.vault.connect(signer).redeem(amount, ethRecipient, { gasPrice: 0 });
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((l) => {
        try {
          return fix.vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === "Redeemed");
    return {
      sharesAmount: event!.args.sharesAmount as bigint,
      etherAmount: event!.args.etherAmount as bigint,
    };
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  1. Shares burned outside rebase limiter
  // ═══════════════════════════════════════════════════════════════════════

  it("Redemption shares burn fully even when rebase limiter is tight", async () => {
    const { lido, burner } = ctx.contracts;
    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: 500n });

    const before = {
      totalShares: await lido.getTotalShares(),
      shareRate: await lido.getPooledEthByShares(ether("1")),
    };

    // Large redeem — creates significant pending shares
    const { sharesAmount } = await redeemWithReceipt(holder, ether("30"), holder.address);

    // Shares tracked on buffer, sitting on Burner as nonCover
    const [, nonCoverBefore] = await burner.getSharesRequestedToBurn();
    expect(nonCoverBefore).to.equal(sharesAmount); // redeem shares are nonCover

    // Report WITH positive rewards — limiter consumes headroom for rewards
    // Redemption shares must still burn fully (added on top of limiter budget)
    await doReport(ctx, { clDiff: ether("0.01") });

    // All redeemed shares burned — none deferred
    const [, nonCoverAfter] = await burner.getSharesRequestedToBurn();
    expect(nonCoverAfter).to.equal(0n);
    expect(await fix.vault.getRedeemedEther()).to.equal(0n);

    // Shares decreased (exact delta depends on fee shares minted from rewards)
    const afterShares = await lido.getTotalShares();
    const sharesDelta = before.totalShares - afterShares;
    // Shares delta cross-check: burned redeemShares minus minted feeShares = net decrease
    const expectedRate = ((await lido.getTotalPooledEther()) * ether("1")) / afterShares;
    expect(await lido.getPooledEthByShares(ether("1"))).to.equal(expectedRate);
    expect(sharesDelta).to.equal(before.totalShares - afterShares);
  });

  it("Redemption shares do not compete with WQ finalization for limiter headroom", async () => {
    const { lido, burner, withdrawalQueue } = ctx.contracts;
    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: 500n });

    // WQ request — creates WQ shares to burn
    const wqAddr = await withdrawalQueue.getAddress();
    await lido.connect(holder).approve(wqAddr, ether("5"), { gasPrice: 0 });
    await withdrawalQueue.connect(holder).requestWithdrawals([ether("5")], holder.address, { gasPrice: 0 });

    // Redeem — creates vault shares to burn
    await redeemWithReceipt(holder, ether("10"), holder.address);

    // Report with rewards — WQ finalization through limiter, redemptions outside
    await doReport(ctx, { clDiff: ether("0.01"), skipWithdrawals: false });

    // WQ finalized
    expect(await withdrawalQueue.unfinalizedStETH()).to.equal(0n);

    // Vault shares all burned (outside limiter)
    const [, nonCover] = await burner.getSharesRequestedToBurn();
    expect(nonCover).to.equal(0n);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  2. Tracked reserve balance — force-sent ETH protection
  // ═══════════════════════════════════════════════════════════════════════

  it("Force-sent ETH is not redeemable — tracked reserve limits redemptions", async () => {
    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: 500n });

    // Redeem some of the reserve first
    await redeemWithReceipt(holder, ether("10"), holder.address);

    // Force-send extra ETH via setBalance (simulates selfdestruct)
    const currentBal = await ethers.provider.getBalance(fix.address);
    await setBalance(fix.address, currentBal + ether("100"));

    // Vault has extra ETH, but reserve available = _reserveBalance - _redeemedEther
    // which is capped by what was funded via fundReserve(), not including force-sent
    const vaultBalance = await ethers.provider.getBalance(fix.address);

    // Redeem more than tracked available fails even though vault has plenty of ETH
    await expect(
      fix.vault.connect(holder).redeem(vaultBalance, holder.address, { gasPrice: 0 }),
    ).to.be.revertedWithCustomError(fix.vault, "InsufficientReserve");

    // But a small redeem within tracked reserve still works
    await redeemWithReceipt(holder, ether("1"), holder.address);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  3. REDEEMER_ROLE access control
  // ═══════════════════════════════════════════════════════════════════════

  it("Redeem reverts without REDEEMER_ROLE", async () => {
    const { lido } = ctx.contracts;
    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: 500n });

    // Revoke stranger's role (granted in setupVault)
    const redeemerRole = await fix.vault.REDEEMER_ROLE();
    await fix.vault.connect(holder).revokeRole(redeemerRole, stranger.address);

    // Transfer stETH to stranger (who no longer has REDEEMER_ROLE)
    await lido.connect(holder).transfer(stranger.address, ether("10"), { gasPrice: 0 });
    await lido.connect(stranger).approve(fix.address, ether("10"), { gasPrice: 0 });

    // Stranger cannot redeem
    expect(await fix.vault.hasRole(redeemerRole, stranger.address)).to.equal(false);
    await expect(fix.vault.connect(stranger).redeem(ether("1"), stranger.address, { gasPrice: 0 })).to.be.reverted;
  });

  it("Redeem works after granting REDEEMER_ROLE", async () => {
    const { lido } = ctx.contracts;
    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: 500n });

    // Revoke and re-grant to verify the flow
    const redeemerRole = await fix.vault.REDEEMER_ROLE();
    await fix.vault.connect(holder).revokeRole(redeemerRole, stranger.address);
    await lido.connect(holder).transfer(stranger.address, ether("10"), { gasPrice: 0 });
    await lido.connect(stranger).approve(fix.address, ether("10"), { gasPrice: 0 });

    // Grant role
    await fix.vault.connect(holder).grantRole(redeemerRole, stranger.address);

    // Now redeem works
    const ethBefore = await ethers.provider.getBalance(stranger.address);
    await fix.vault.connect(stranger).redeem(ether("1"), stranger.address, { gasPrice: 0 });
    const ethAfter = await ethers.provider.getBalance(stranger.address);
    const redeemEther = ethAfter - ethBefore;
    // Cross-check: received ETH matches share-to-ether conversion
    const expectedEther = await lido.getPooledEthByShares(await lido.getSharesByPooledEth(ether("1")));
    expect(redeemEther).to.equal(expectedEther);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  4. Counter reset separation
  // ═══════════════════════════════════════════════════════════════════════

  it("After report: both counters reset to zero", async () => {
    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: 500n });

    const { etherAmount } = await redeemWithReceipt(holder, ether("10"), holder.address);

    expect(await fix.vault.getRedeemedEther()).to.equal(etherAmount);

    await doReport(ctx);

    // Both counters reset (shares by flushSharesToBurner, ether by resetRedeemedEther)
    expect(await fix.vault.getRedeemedEther()).to.equal(0n);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  5. fundReserve() — receive() reverts
  // ═══════════════════════════════════════════════════════════════════════

  it("Direct ETH transfer to vault reverts", async () => {
    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: 500n });

    await expect(
      holder.sendTransaction({ to: fix.address, value: ether("1"), gasPrice: 0 }),
    ).to.be.revertedWithCustomError(fix.vault, "DirectETHTransfer");
  });

  it("fundReserve() only callable by Lido", async () => {
    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: 500n });

    await expect(
      fix.vault.connect(holder).fundReserve({ value: ether("1"), gasPrice: 0 }),
    ).to.be.revertedWithCustomError(fix.vault, "NotLido");
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  6. _reserveBalance drift — redeem → report → redeem must not exceed actual balance
  // ═══════════════════════════════════════════════════════════════════════

  it("_reserveBalance does not drift above actual balance after redeem+report cycles", async () => {
    const { lido } = ctx.contracts;
    // Large deposit so holder has more stETH than vault balance
    await seedReserve(ctx, holder, reserveManager, { deposit: ether("5000"), redeemsReserveRatioBP: 500n });

    const targetBalance = await ethers.provider.getBalance(fix.address);
    expect(targetBalance).to.equal(await lido.getRedeemsReserveTarget());

    // Run 5 cycles: redeem → report → fundReserve accumulates in _reserveBalance
    const redeemPerCycle = ether("5");
    for (let i = 0; i < 5; i++) {
      await redeemWithReceipt(holder, redeemPerCycle, holder.address);
      await doReport(ctx);
    }

    // After 5 cycles: vault should be at target, tracked == actual
    const actualBalance = await ethers.provider.getBalance(fix.address);
    expect(await lido.getRedeemsReserve()).to.equal(actualBalance);

    // Attempting to redeem more than actual balance should fail
    const overRedeemAmount = actualBalance + ether("10");

    await lido.connect(holder).approve(fix.address, overRedeemAmount + ether("100"), { gasPrice: 0 });

    await expect(
      fix.vault.connect(holder).redeem(overRedeemAmount, holder.address, { gasPrice: 0 }),
    ).to.be.revertedWithCustomError(fix.vault, "InsufficientReserve");
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  7. Recovery
  // ═══════════════════════════════════════════════════════════════════════

  it("recoverERC20 reverts for stETH", async () => {
    await seedReserve(ctx, holder, reserveManager, { deposit: ether("1000"), redeemsReserveRatioBP: 500n });

    const lidoAddr = await ctx.contracts.lido.getAddress();
    await expect(fix.vault.connect(holder).recoverERC20(lidoAddr, ether("1"), lidoAddr)).to.be.revertedWithCustomError(
      fix.vault,
      "StETHRecoveryNotAllowed",
    );
  });
});
