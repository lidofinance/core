import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { RedeemsBuffer } from "typechain-types";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext, report } from "lib/protocol";

import { Snapshot } from "test/suite";

/**
 * Tests specific to v6 push mechanics:
 * - Shares burned outside rebase limiter (guaranteed full burn)
 * - Tracked reserve balance (_reserveBalance prevents force-sent ETH redemption)
 * - REDEEMER_ROLE access control
 * - Counter reset separation (shares vs ether)
 * - fundReserve() payable method
 */
describe("Integration: Redeems reserve — v6 mechanics", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let reserveManager: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let vault: RedeemsBuffer;

  const reportOpts = { clDiff: 0n, excludeVaultsBalances: true, skipWithdrawals: true };

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [holder, , stranger] = await ethers.getSigners();
    reserveManager = holder;

    const { acl, lido, burner } = ctx.contracts;
    const agent = await ctx.getSigner("agent");

    const role = await lido.BUFFER_RESERVE_MANAGER_ROLE();
    const hasRole = await acl["hasPermission(address,address,bytes32)"](reserveManager.address, lido.address, role);
    if (!hasRole) {
      await acl.connect(agent).grantPermission(reserveManager.address, lido.address, role);
    }

    const VaultFactory = await ethers.getContractFactory("RedeemsBuffer");
    vault = await VaultFactory.connect(holder).deploy(await ctx.contracts.locator.getAddress());
    await vault.initialize(holder.address);

    const burnRole = await burner.REQUEST_BURN_SHARES_ROLE();
    await burner.connect(agent).grantRole(burnRole, await vault.getAddress());
    await lido.connect(reserveManager).setRedeemsBuffer(await vault.getAddress());

    const redeemerRole = await vault.REDEEMER_ROLE();
    await vault.connect(holder).grantRole(redeemerRole, holder.address);
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

  const setupVault = async (submitAmount: bigint, ratioBP: bigint) => {
    const { lido } = ctx.contracts;
    await lido.connect(holder).submit(ZeroAddress, { value: submitAmount });
    await report(ctx, { ...reportOpts, clDiff: ether("0.0037") });
    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(ratioBP);
    await report(ctx, reportOpts);
  };

  const redeemWithReceipt = async (signer: HardhatEthersSigner, amount: bigint, ethRecipient: string) => {
    const { lido } = ctx.contracts;
    const vaultAddr = await vault.getAddress();
    await lido.connect(signer).approve(vaultAddr, amount + 10n, { gasPrice: 0 });
    const tx = await vault.connect(signer).redeem(amount, ethRecipient, { gasPrice: 0 });
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((l) => {
        try {
          return vault.interface.parseLog(l);
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
    await setupVault(ether("1000"), 500n);

    const before = {
      totalShares: await lido.getTotalShares(),
      shareRate: await lido.getPooledEthByShares(ether("1")),
    };

    // Large redeem — creates significant pending shares
    const { sharesAmount } = await redeemWithReceipt(holder, ether("30"), holder.address);

    // Shares on Burner redeem track (sent during redeem)
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(sharesAmount);
    const [, nonCoverBefore] = await burner.getSharesRequestedToBurn();
    expect(nonCoverBefore).to.equal(0n);

    // Report WITH positive rewards — limiter consumes headroom for rewards
    // Redemption shares must still burn fully (outside limiter)
    await report(ctx, { ...reportOpts, clDiff: ether("0.01") });

    // All redeemed shares burned — none deferred
    const [, nonCoverAfter] = await burner.getSharesRequestedToBurn();
    expect(nonCoverAfter).to.equal(0n);
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(0n);
    expect(await vault.getRedeemedEther()).to.equal(0n);

    // Shares decreased by at least redemption amount (minus fee shares minted)
    const afterShares = await lido.getTotalShares();
    expect(before.totalShares - afterShares).to.be.gt(0n);
  });

  it("Redemption shares do not compete with WQ finalization for limiter headroom", async () => {
    const { lido, withdrawalQueue, burner } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    // WQ request — creates WQ shares to burn
    const wqAddr = await withdrawalQueue.getAddress();
    await lido.connect(holder).approve(wqAddr, ether("5"), { gasPrice: 0 });
    await withdrawalQueue.connect(holder).requestWithdrawals([ether("5")], holder.address, { gasPrice: 0 });

    // Redeem — creates vault shares to burn
    const { sharesAmount } = await redeemWithReceipt(holder, ether("10"), holder.address);
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(sharesAmount);

    // Report with rewards — WQ finalization through limiter, redemptions outside
    await report(ctx, { clDiff: ether("0.01"), excludeVaultsBalances: true, skipWithdrawals: false });

    // WQ finalized
    expect(await withdrawalQueue.unfinalizedStETH()).to.equal(0n);

    // Vault shares all burned (outside limiter)
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(0n);
    const [, nonCover] = await burner.getSharesRequestedToBurn();
    expect(nonCover).to.equal(0n);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  2. Tracked reserve balance — force-sent ETH protection
  // ═══════════════════════════════════════════════════════════════════════

  it("Force-sent ETH is not redeemable — tracked reserve limits redemptions", async () => {
    await setupVault(ether("1000"), 500n);

    const vaultAddr = await vault.getAddress();

    // Redeem some of the reserve first
    await redeemWithReceipt(holder, ether("10"), holder.address);

    // Force-send extra ETH via setBalance (simulates selfdestruct)
    const currentBal = await ethers.provider.getBalance(vaultAddr);
    await setBalance(vaultAddr, currentBal + ether("100"));

    // Vault has extra ETH, but reserve available = _reserveBalance - _redeemedEther
    // which is capped by what was funded via fundReserve(), not including force-sent
    const vaultBalance = await ethers.provider.getBalance(vaultAddr);

    // Redeem more than tracked available fails even though vault has plenty of ETH
    // Try to redeem the full vault balance — will fail at InsufficientReserve
    await expect(
      vault.connect(holder).redeem(vaultBalance, holder.address, { gasPrice: 0 }),
    ).to.be.revertedWithCustomError(vault, "InsufficientReserve");

    // But a small redeem within tracked reserve still works
    await redeemWithReceipt(holder, ether("1"), holder.address);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  3. REDEEMER_ROLE access control
  // ═══════════════════════════════════════════════════════════════════════

  it("Redeem reverts without REDEEMER_ROLE", async () => {
    const { lido } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    // Transfer stETH to stranger (who has no REDEEMER_ROLE)
    await lido.connect(holder).transfer(stranger.address, ether("10"), { gasPrice: 0 });
    const vaultAddr = await vault.getAddress();
    await lido.connect(stranger).approve(vaultAddr, ether("10"), { gasPrice: 0 });

    // Stranger cannot redeem
    const redeemerRole = await vault.REDEEMER_ROLE();
    expect(await vault.hasRole(redeemerRole, stranger.address)).to.equal(false);
    await expect(vault.connect(stranger).redeem(ether("1"), stranger.address, { gasPrice: 0 })).to.be.reverted;
  });

  it("Redeem works after granting REDEEMER_ROLE", async () => {
    const { lido } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    await lido.connect(holder).transfer(stranger.address, ether("10"), { gasPrice: 0 });
    const vaultAddr = await vault.getAddress();
    await lido.connect(stranger).approve(vaultAddr, ether("10"), { gasPrice: 0 });

    // Grant role
    const redeemerRole = await vault.REDEEMER_ROLE();
    await vault.connect(holder).grantRole(redeemerRole, stranger.address);

    // Now redeem works
    const ethBefore = await ethers.provider.getBalance(stranger.address);
    await vault.connect(stranger).redeem(ether("1"), stranger.address, { gasPrice: 0 });
    expect(await ethers.provider.getBalance(stranger.address)).to.be.gt(ethBefore);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  4. Counter reset separation
  // ═══════════════════════════════════════════════════════════════════════

  it("After report: both counters reset to zero", async () => {
    const { burner } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    await redeemWithReceipt(holder, ether("10"), holder.address);

    expect(await burner.getRedeemSharesRequestedToBurn()).to.be.gt(0n);
    expect(await vault.getRedeemedEther()).to.be.gt(0n);

    await report(ctx, reportOpts);

    // Both counters reset (shares by flushSharesToBurner, ether by resetRedeemedEther)
    expect(await burner.getRedeemSharesRequestedToBurn()).to.equal(0n);
    expect(await vault.getRedeemedEther()).to.equal(0n);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  5. fundReserve() — receive() reverts
  // ═══════════════════════════════════════════════════════════════════════

  it("Direct ETH transfer to vault reverts", async () => {
    await setupVault(ether("1000"), 500n);

    await expect(
      holder.sendTransaction({ to: await vault.getAddress(), value: ether("1"), gasPrice: 0 }),
    ).to.be.revertedWithCustomError(vault, "NotLido");
  });

  it("fundReserve() only callable by Lido", async () => {
    await setupVault(ether("1000"), 500n);

    await expect(vault.connect(holder).fundReserve({ value: ether("1"), gasPrice: 0 })).to.be.revertedWithCustomError(
      vault,
      "NotLido",
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  6. _reserveBalance drift — redeem → report → redeem must not exceed actual balance
  // ═══════════════════════════════════════════════════════════════════════

  it("BUG: _reserveBalance drifts above actual balance after redeem+report cycles", async () => {
    const { lido } = ctx.contracts;
    // Large deposit so holder has more stETH than vault balance
    await lido.connect(holder).submit(ZeroAddress, { value: ether("5000") });
    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(500n);
    await report(ctx, reportOpts);

    const vaultAddr = await vault.getAddress();
    const targetBalance = await ethers.provider.getBalance(vaultAddr);
    expect(targetBalance).to.be.gt(0n);

    // Run 5 cycles: redeem → report → fundReserve accumulates in _reserveBalance
    // Each cycle: _reserveBalance += replenishAmount, but never -= redeemedEther
    const redeemPerCycle = ether("5");
    for (let i = 0; i < 5; i++) {
      await redeemWithReceipt(holder, redeemPerCycle, holder.address);
      await report(ctx, reportOpts);
    }

    // After 5 cycles: _reserveBalance ≈ initial + 5 * replenishAmount
    // Actual vault balance ≈ target (replenished each cycle)
    const actualBalance = await ethers.provider.getBalance(vaultAddr);

    // The drift: try to redeem more than actual balance
    // _reserveBalance >> actualBalance, so InsufficientReserve check passes
    // But ETH transfer will fail because vault doesn't have enough ETH
    const overRedeemAmount = actualBalance + ether("10");
    const holderBal = await lido.balanceOf(holder.address);

    expect(overRedeemAmount).to.be.lte(holderBal, "holder must have enough stETH");

    // Pre-approve vault for the full amount
    await lido.connect(holder).approve(await vault.getAddress(), overRedeemAmount + ether("100"), { gasPrice: 0 });

    // EXPECTED: revert with InsufficientReserve (tracked reserve < actual request)
    // BUG: _reserveBalance drifted → check passes → reverts at ETH transfer
    await expect(
      vault.connect(holder).redeem(overRedeemAmount, holder.address, { gasPrice: 0 }),
    ).to.be.revertedWithCustomError(vault, "InsufficientReserve");
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  7. Recovery
  // ═══════════════════════════════════════════════════════════════════════

  it("recoverERC20 reverts for stETH", async () => {
    await setupVault(ether("1000"), 500n);

    const lidoAddr = await ctx.contracts.lido.getAddress();
    await expect(vault.connect(holder).recoverERC20(lidoAddr, ether("1"))).to.be.revertedWithCustomError(
      vault,
      "StETHRecoveryNotAllowed",
    );
  });
});
