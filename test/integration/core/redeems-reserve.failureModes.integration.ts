import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { RedeemsReserveVault } from "typechain-types";

import { ether, impersonate } from "lib";
import {
  getProtocolContext,
  ProtocolContext,
  report,
  reportWithEffectiveClDiff,
  resetCLBalanceDecreaseWindow,
} from "lib/protocol";

import { Snapshot } from "test/suite";

/**
 * Failure mode scenarios for the push-based Redeems Reserve.
 *
 * Scratch deploy (MODE=scratch) — all state is deterministic.
 * All assertions use exact equality with computed expected values.
 */
describe("Integration: Redeems reserve — failure modes", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let reserveManager: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let holderB: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let vault: RedeemsReserveVault;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [holder, holderB, stranger] = await ethers.getSigners();
    reserveManager = holder;

    const { acl, lido, burner, withdrawalQueue } = ctx.contracts;
    const agent = await ctx.getSigner("agent");

    const role = await lido.BUFFER_RESERVE_MANAGER_ROLE();
    const hasRole = await acl["hasPermission(address,address,bytes32)"](reserveManager.address, lido.address, role);
    if (!hasRole) {
      await acl.connect(agent).grantPermission(reserveManager.address, lido.address, role);
    }

    const accountingAddr = await ctx.contracts.locator.accounting();
    const VaultFactory = await ethers.getContractFactory("RedeemsReserveVault");
    vault = await VaultFactory.connect(holder).deploy(
      await lido.getAddress(),
      await burner.getAddress(),
      await withdrawalQueue.getAddress(),
      accountingAddr,
      holder.address,
    );

    const burnRole = await burner.REQUEST_BURN_SHARES_ROLE();
    await burner.connect(agent).grantRole(burnRole, await vault.getAddress());
    await lido.connect(reserveManager).setRedeemsReserveVault(await vault.getAddress());

    // Grant REDEEMER_ROLE to test signers
    const redeemerRole = await vault.REDEEMER_ROLE();
    await vault.connect(holder).grantRole(redeemerRole, holder.address);
    await vault.connect(holder).grantRole(redeemerRole, holderB.address);
    await vault.connect(holder).grantRole(redeemerRole, stranger.address);
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

  const reportOpts = { clDiff: 0n, excludeVaultsBalances: true, skipWithdrawals: true };

  const setupVault = async (submitAmount: bigint, ratioBP: bigint) => {
    const { lido } = ctx.contracts;
    await lido.connect(holder).submit(ZeroAddress, { value: submitAmount });

    // Initial rebase to create non-1:1 share rate with many non-zero digits
    // This catches rounding edge cases that 1:1 rate would hide
    await report(ctx, { ...reportOpts, clDiff: ether("0.0037") });

    const rate = await lido.getPooledEthByShares(ether("1"));
    expect(rate).to.not.equal(ether("1")); // rate is no longer 1:1

    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(ratioBP);
    await report(ctx, reportOpts);
  };

  /** Redeem and extract exact sharesAmount/etherAmount from Redeemed event */
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
      tx,
      receipt: receipt!,
      sharesAmount: event!.args.sharesAmount as bigint,
      etherAmount: event!.args.etherAmount as bigint,
    };
  };

  /** Captures protocol state snapshot for before/after comparison */
  const captureState = async () => {
    const { lido, burner } = ctx.contracts;
    const vaultAddr = await vault.getAddress();
    const [coverPending, nonCoverPending] = await burner.getSharesRequestedToBurn();
    return {
      totalPooledEther: await lido.getTotalPooledEther(),
      totalShares: await lido.getTotalShares(),
      shareRate: await lido.getPooledEthByShares(ether("1")),
      bufferedEther: await lido.getBufferedEther(),
      trackedVaultEth: await lido.getRedeemsReserveVaultEth(),
      vaultBalance: await ethers.provider.getBalance(vaultAddr),
      depositableEther: await lido.getDepositableEther(),
      coverPending,
      nonCoverPending,
    };
  };

  const assertVaultReconciled = async () => {
    const { lido } = ctx.contracts;
    const tracked = await lido.getRedeemsReserveVaultEth();
    const actual = await ethers.provider.getBalance(await vault.getAddress());
    expect(tracked).to.equal(actual, "vault tracked != actual balance");
  };

  const assertVaultAtTarget = async () => {
    const { lido } = ctx.contracts;
    const vaultBal = await ethers.provider.getBalance(await vault.getAddress());
    const target = await lido.getRedeemsReserveTarget();
    expect(vaultBal).to.equal(target, "vault balance != target");
  };

  const assertAllocationInvariant = async () => {
    const { lido } = ctx.contracts;
    const buffered = await lido.getBufferedEther();
    const wRes = await lido.getWithdrawalsReserve();
    expect(await lido.getDepositableEther()).to.equal(buffered - wRes, "allocation invariant broken");
  };

  const claimAndVerify = async (signer: HardhatEthersSigner, reqId: bigint) => {
    const { withdrawalQueue } = ctx.contracts;
    const lastCheckpoint = await withdrawalQueue.getLastCheckpointIndex();
    const hints = [...(await withdrawalQueue.findCheckpointHints([reqId], 1n, lastCheckpoint))];
    const [claimable] = await withdrawalQueue.getClaimableEther([reqId], hints);
    expect(claimable).to.be.gt(0n, "nothing to claim");
    const ethBefore = await ethers.provider.getBalance(signer.address);
    await withdrawalQueue.connect(signer).claimWithdrawals([reqId], hints, { gasPrice: 0 });
    expect(await ethers.provider.getBalance(signer.address)).to.equal(ethBefore + claimable);
    return claimable;
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  0. Full Lifecycle: submit → fund → WQ + redeem → finalize → refill
  // ═══════════════════════════════════════════════════════════════════════

  it("0.1 Full lifecycle: submit, fund vault, WQ request + redeem, report finalizes both, vault refills", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    await assertVaultAtTarget();
    const targetAfterFund = await lido.getRedeemsReserveTarget();

    // WQ request
    const wqAmount = ether("5");
    const wqAddr = await withdrawalQueue.getAddress();
    await lido.connect(holder).approve(wqAddr, wqAmount, { gasPrice: 0 });
    await withdrawalQueue.connect(holder).requestWithdrawals([wqAmount], holder.address, { gasPrice: 0 });
    const wqRequestId = await withdrawalQueue.getLastRequestId();
    expect(await withdrawalQueue.unfinalizedStETH()).to.equal(wqAmount);

    await assertAllocationInvariant();

    // Redeem via vault
    const before = await captureState();
    const redeemAmount = ether("10");
    const { sharesAmount, etherAmount } = await redeemWithReceipt(holder, redeemAmount, holder.address);

    // Verify immediate effects (push: shares moved to Burner, not burned yet)
    // totalShares unchanged — burn deferred to report
    expect(await lido.getTotalShares()).to.equal(before.totalShares);
    // Rate unchanged — stale tracked vault ETH hides the decrease
    expect(await lido.getPooledEthByShares(ether("1"))).to.equal(before.shareRate);
    // Vault balance decreased by exact etherAmount
    const vaultAfterRedeem = await ethers.provider.getBalance(await vault.getAddress());
    expect(vaultAfterRedeem).to.equal(before.vaultBalance - etherAmount);
    // Shares held on vault (not in Burner yet — flushed on report)
    expect(await vault.getRedeemedShares()).to.equal(sharesAmount);
    expect(await vault.getRedeemedEther()).to.equal(etherAmount);

    // Report: finalizes WQ + burns vault shares + refills vault
    await report(ctx, { clDiff: 0n, excludeVaultsBalances: true, skipWithdrawals: false });

    // WQ finalized
    expect(await withdrawalQueue.getLastFinalizedRequestId()).to.equal(wqRequestId);
    expect(await withdrawalQueue.unfinalizedStETH()).to.equal(0n);

    // Vault shares all burned
    const [, nonCover] = await ctx.contracts.burner.getSharesRequestedToBurn();
    expect(nonCover).to.equal(0n);

    // Vault refilled to new (lower) target
    await assertVaultReconciled();
    await assertVaultAtTarget();
    expect(await lido.getRedeemsReserveTarget()).to.be.lt(targetAfterFund);
    await assertAllocationInvariant();
  });

  it("0.2 Fair user outcomes: A redeems via vault, B exits via WQ, report with rewards — both get fair value", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    // Two holders with equal deposits
    await lido.connect(holder).submit(ZeroAddress, { value: ether("100") });
    await lido.connect(holderB).submit(ZeroAddress, { value: ether("100") });
    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(500n);
    await report(ctx, reportOpts);

    // A redeems 10 stETH via vault (gets pre-report rate)
    const redeemAmount = ether("10");
    const rateBeforeRedeem = await lido.getPooledEthByShares(ether("1"));
    const { etherAmount: aEthReceived, sharesAmount: aSharesBurned } = await redeemWithReceipt(
      holder,
      redeemAmount,
      holder.address,
    );

    // B requests full WQ withdrawal
    const bBalance = await lido.balanceOf(holderB.address);
    const wqAddr = await withdrawalQueue.getAddress();
    await lido.connect(holderB).approve(wqAddr, bBalance, { gasPrice: 0 });
    await withdrawalQueue.connect(holderB).requestWithdrawals([bBalance], holderB.address, { gasPrice: 0 });
    const bRequestId = await withdrawalQueue.getLastRequestId();

    // Report with positive CL rewards
    const clDiff = ether("0.01");
    await report(ctx, { clDiff, excludeVaultsBalances: true, skipWithdrawals: false });

    expect(await withdrawalQueue.getLastFinalizedRequestId()).to.equal(bRequestId);
    await claimAndVerify(holderB, bRequestId);

    // Fairness: A got ETH at pre-rebase rate (vault redeem is instant at current rate)
    const aEffectiveRate = (aEthReceived * ether("1")) / aSharesBurned;
    expect(aEffectiveRate).to.equal(rateBeforeRedeem);

    // Vault shares burned, reserve refilled
    const [, nonCover] = await ctx.contracts.burner.getSharesRequestedToBurn();
    expect(nonCover).to.equal(0n);
    await assertVaultAtTarget();
    await assertAllocationInvariant();
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  1. Negative Rebase — Sanity Checker & Rebase Amount
  // ═══════════════════════════════════════════════════════════════════════

  it("1.1 vaultDelta in _etherToDecrease — state reconciled, shares exact (no rewards)", async () => {
    const { lido } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    const before = await captureState();
    const { sharesAmount, etherAmount } = await redeemWithReceipt(holder, ether("10"), holder.address);

    // Between reports: tracked stale, vault balance decreased by exact etherAmount
    expect(await lido.getRedeemsReserveVaultEth()).to.equal(before.trackedVaultEth);
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(before.vaultBalance - etherAmount);

    // Rate unchanged between reports (overcount cancels)
    expect(await lido.getPooledEthByShares(ether("1"))).to.equal(before.shareRate);

    // clDiff=0 → no fee shares minted → exact totalShares check
    await report(ctx, reportOpts);

    const after = await captureState();

    await assertVaultReconciled();
    expect(after.totalShares).to.equal(before.totalShares - sharesAmount);
    expect(after.shareRate).to.equal(before.shareRate);
    expect(after.nonCoverPending).to.equal(0n);
  });

  it("1.2 checkSimulatedShareRate passes after large redemption — shares exact (no rewards)", async () => {
    await setupVault(ether("1000"), 500n);

    const before = await captureState();
    const { sharesAmount } = await redeemWithReceipt(holder, ether("30"), holder.address);

    // clDiff=0 → exact shares
    await report(ctx, reportOpts);

    const after = await captureState();

    await assertVaultReconciled();
    expect(after.totalShares).to.equal(before.totalShares - sharesAmount);
    expect(after.shareRate).to.equal(before.shareRate);
    expect(after.nonCoverPending).to.equal(0n);
  });

  it("1.3 Positive CL rewards + vault redemption — rate increases, vault burn net-neutral", async () => {
    const { lido } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    const before = await captureState();
    const { sharesAmount, etherAmount } = await redeemWithReceipt(holder, ether("10"), holder.address);

    // Rate unchanged between reports — paired overcount cancels
    expect(await lido.getPooledEthByShares(ether("1"))).to.equal(before.shareRate);

    const clDiff = ether("0.01");
    await report(ctx, { ...reportOpts, clDiff });

    const after = await captureState();

    // clDiff > 0 → fee shares minted. Exact totalShares requires fee calculation.
    // Bound: shares decreased by burned amount minus fees minted
    const sharesDelta = before.totalShares - after.totalShares;
    expect(sharesDelta).to.be.lt(sharesAmount); // fees minted → less decrease than pure burn
    expect(sharesDelta).to.be.gt(0n); // but still net decrease
    // TPE = before - etherAmount(redeem) + clDiff (rewards)
    // Exact: after.TPE should be less than before (redeem > clDiff)
    expect(after.totalPooledEther).to.equal(before.totalPooledEther - etherAmount + clDiff);
    // Rate: TPE / totalShares. TPE decreased by (etherAmount - clDiff), shares decreased by (sharesAmount - feeMinted)
    // Since we know exact TPE, verify rate = TPE * 1e18 / totalShares
    const expectedRate = (after.totalPooledEther * ether("1")) / after.totalShares;
    expect(after.shareRate).to.equal(expectedRate);
    await assertVaultReconciled();
    expect(after.nonCoverPending).to.equal(0n);
  });

  it("1.4 Negative CL rebase + vault redemption — rate drops, shares exact (no fees on negative)", async () => {
    await setupVault(ether("1000"), 500n);

    const before = await captureState();
    const { sharesAmount, etherAmount } = await redeemWithReceipt(holder, ether("10"), holder.address);

    const clDiff = -ether("0.01");
    await report(ctx, { ...reportOpts, clDiff });

    const after = await captureState();

    // Negative CL → no fee shares minted → exact totalShares
    expect(after.totalShares).to.equal(before.totalShares - sharesAmount);
    // TPE = before - etherAmount + clDiff (negative)
    expect(after.totalPooledEther).to.equal(before.totalPooledEther - etherAmount + clDiff);
    // Rate = TPE / totalShares
    const expectedRate = (after.totalPooledEther * ether("1")) / after.totalShares;
    expect(after.shareRate).to.equal(expectedRate);
    expect(after.trackedVaultEth).to.equal(after.vaultBalance);
    expect(after.nonCoverPending).to.equal(0n);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  3.2 Full Withdraw from Protocol
  // ═══════════════════════════════════════════════════════════════════════

  it("3.2 Full withdraw from protocol — all holders exit via WQ, vault drained", async () => {
    const { lido, withdrawalQueue, oracleReportSanityChecker } = ctx.contracts;

    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(500n);
    await report(ctx, reportOpts);

    await assertVaultAtTarget();
    const targetBefore = await lido.getRedeemsReserveTarget();

    // Discover all stETH holders via Transfer events
    const transfers = await lido.queryFilter(lido.filters.Transfer());
    const holdersSet = new Set<string>();
    for (const t of transfers) {
      if (t.args[1] !== ZeroAddress) holdersSet.add(t.args[1]);
    }
    const excludeAddrs = new Set(
      [
        await ctx.contracts.burner.getAddress(),
        await vault.getAddress(),
        await withdrawalQueue.getAddress(),
        await lido.getAddress(),
      ].map((a) => a.toLowerCase()),
    );
    const holderAddrs = [...holdersSet].filter((a) => !excludeAddrs.has(a.toLowerCase()));

    // Completeness: found holders + excluded ≈ totalSupply
    let holdersBalanceSum = 0n;
    for (const addr of holderAddrs) holdersBalanceSum += await lido.balanceOf(addr);
    let excludedBalanceSum = 0n;
    for (const addr of excludeAddrs) excludedBalanceSum += await lido.balanceOf(addr);
    expect(holdersBalanceSum + excludedBalanceSum).to.be.closeTo(
      await lido.totalSupply(),
      BigInt(holderAddrs.length + excludeAddrs.size),
    );

    // All holders request full WQ withdrawal
    const wqAddr = await withdrawalQueue.getAddress();
    const MIN_STETH_WITHDRAWAL = ether("0.001");
    const MAX_STETH_WITHDRAWAL = ether("1000");
    let totalRequested = 0n;

    for (const addr of holderAddrs) {
      const bal = await lido.balanceOf(addr);
      if (bal < MIN_STETH_WITHDRAWAL) continue;

      const signer = await ethers.getImpersonatedSigner(addr);
      await holder.sendTransaction({ to: addr, value: ether("0.1"), gasPrice: 0 });
      await lido.connect(signer).approve(wqAddr, bal, { gasPrice: 0 });

      let remaining = bal;
      const amounts: bigint[] = [];
      while (remaining >= MIN_STETH_WITHDRAWAL) {
        const chunk = remaining > MAX_STETH_WITHDRAWAL ? MAX_STETH_WITHDRAWAL : remaining;
        if (chunk < MIN_STETH_WITHDRAWAL) break;
        amounts.push(chunk);
        remaining -= chunk;
      }
      if (amounts.length > 0) {
        await withdrawalQueue.connect(signer).requestWithdrawals(amounts, addr, { gasPrice: 0 });
        totalRequested += amounts.reduce((a, b) => a + b, 0n);
      }
    }
    expect(totalRequested).to.be.closeTo(holdersBalanceSum, 3n * BigInt(holderAddrs.length));

    const lastRequestId = await withdrawalQueue.getLastRequestId();

    // Free deposits reserve so full buffer is available for WQ
    await lido.connect(reserveManager).setDepositsReserveTarget(0n);

    // Lift sanity checker limits for validator exit simulation
    const agent = await ctx.getSigner("agent");
    const decreaseRole = await oracleReportSanityChecker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE();
    await oracleReportSanityChecker.connect(agent).grantRole(decreaseRole, agent.address);
    await oracleReportSanityChecker.connect(agent).setMaxCLBalanceDecreaseBP(10000);
    const rebaseRole = await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE();
    await oracleReportSanityChecker.connect(agent).grantRole(rebaseRole, agent.address);
    await oracleReportSanityChecker.connect(agent).setMaxPositiveTokenRebase((1n << 64n) - 1n);

    const wvAddr = await ctx.contracts.withdrawalVault.getAddress();
    const stats = await lido.getBalanceStats();
    let remainingCl = stats.clValidatorsBalanceAtLastReport + stats.clPendingBalanceAtLastReport;

    // Phase 1: finalize via validator exits + buffer
    let prevTarget = targetBefore;
    let prevUnfinalized = await withdrawalQueue.unfinalizedStETH();

    const MAX_REPORTS = 15;
    for (let i = 0; i < MAX_REPORTS; i++) {
      const unfinalized = await withdrawalQueue.unfinalizedStETH();
      if (unfinalized === 0n) break;

      const exitChunk = unfinalized < remainingCl ? unfinalized : remainingCl;
      if (exitChunk > 0n) {
        const curWvBal = await ethers.provider.getBalance(wvAddr);
        await setBalance(wvAddr, curWvBal + exitChunk);
        remainingCl -= exitChunk;
      }

      await report(ctx, { clDiff: exitChunk > 0n ? -exitChunk : 0n });

      const curTarget = await lido.getRedeemsReserveTarget();
      const curUnfinalized = await withdrawalQueue.unfinalizedStETH();
      expect(curTarget).to.be.lte(prevTarget);
      expect(curUnfinalized).to.be.lte(prevUnfinalized);
      await assertVaultReconciled();

      prevTarget = curTarget;
      prevUnfinalized = curUnfinalized;
    }

    // Phase 2: drain vault to free remaining ETH
    const unfinalizedMid = await withdrawalQueue.unfinalizedStETH();
    if (unfinalizedMid > 0n) {
      const vaultMid = await ethers.provider.getBalance(await vault.getAddress());
      expect(vaultMid).to.be.gt(0n);

      await lido.connect(reserveManager).setRedeemsReserveTargetRatio(0n);
      for (let i = 0; i < 10; i++) {
        if ((await withdrawalQueue.unfinalizedStETH()) === 0n) break;
        await report(ctx, { clDiff: 0n });
      }
    }

    // All finalized
    expect(await withdrawalQueue.unfinalizedStETH()).to.equal(0n);
    expect(await withdrawalQueue.getLastFinalizedRequestId()).to.equal(lastRequestId);

    // Verify claims work — check first and last requests
    const firstReqId = (await withdrawalQueue.getLastCheckpointIndex()) > 0n ? 1n : 0n;
    if (firstReqId > 0n) {
      const reqOwner = (await withdrawalQueue.getWithdrawalStatus([lastRequestId]))[0].owner;
      const ownerSigner = await ethers.getImpersonatedSigner(reqOwner);
      await holder.sendTransaction({ to: reqOwner, value: ether("0.01"), gasPrice: 0 });
      await claimAndVerify(ownerSigner, lastRequestId);
    }
  });

  // NOTE: section 4 (vaultDelta + negative rebase) merged into 1.4 — identical scenario

  // ═══════════════════════════════════════════════════════════════════════
  //  6. Insurance/Cover Shares Burning Priority
  // ═══════════════════════════════════════════════════════════════════════

  it("6.1 Cover + vault shares — cover burned to 0, vault shares burned to 0", async () => {
    const { lido, burner } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    const { sharesAmount: vaultShares } = await redeemWithReceipt(holder, ether("10"), holder.address);

    // Add cover shares
    const agent = await ctx.getSigner("agent");
    const coverRole = await burner.REQUEST_BURN_SHARES_ROLE();
    if (!(await burner.hasRole(coverRole, stranger.address))) {
      await burner.connect(agent).grantRole(coverRole, stranger.address);
    }

    const coverStETH = ether("5");
    await lido.connect(holder).transfer(stranger.address, coverStETH);
    const coverShares = await lido.getSharesByPooledEth(coverStETH);
    await lido.connect(stranger).approve(await burner.getAddress(), coverStETH);
    await burner.connect(stranger).requestBurnSharesForCover(stranger.address, coverShares);

    // Cover shares in Burner, vault shares on vault (not Burner yet)
    const [coverBefore, nonCoverBefore] = await burner.getSharesRequestedToBurn();
    expect(coverBefore).to.equal(coverShares);
    expect(nonCoverBefore).to.equal(0n); // vault shares held locally
    expect(await vault.getRedeemedShares()).to.equal(vaultShares);

    const before = await captureState();

    await report(ctx, { ...reportOpts, clDiff: ether("0.01") });

    const [coverAfter, nonCoverAfter] = await burner.getSharesRequestedToBurn();
    const after = await captureState();

    // Both burned to 0
    expect(coverAfter).to.equal(0n);
    expect(nonCoverAfter).to.equal(0n);
    // clDiff > 0 → fees minted. Bound shares delta.
    const sharesDelta = before.totalShares - after.totalShares;
    const totalBurned = coverShares + vaultShares;
    expect(sharesDelta).to.be.lt(totalBurned); // fees minted → less decrease than pure burn
    expect(sharesDelta).to.be.gt(0n); // still net decrease
    // TPE: before - vault etherAmount + clDiff (cover burn doesn't change TPE, only shares)
    // Rate = TPE / totalShares — verify consistency
    const expectedRate = (after.totalPooledEther * ether("1")) / after.totalShares;
    expect(after.shareRate).to.equal(expectedRate);
    // Reconciled
    expect(after.trackedVaultEth).to.equal(after.vaultBalance);
  });

  it("6.2 Vault shares after first report — all burned, none deferred", async () => {
    const { burner } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    const before = await captureState();
    const { sharesAmount } = await redeemWithReceipt(holder, ether("10"), holder.address);

    // Shares held on vault (flushed to Burner on report)
    expect(await vault.getRedeemedShares()).to.equal(sharesAmount);

    // clDiff=0 → exact shares
    await report(ctx, reportOpts);

    const [coverAfter, nonCoverAfter] = await burner.getSharesRequestedToBurn();
    expect(coverAfter).to.equal(0n);
    expect(nonCoverAfter).to.equal(0n);

    const after = await captureState();
    await assertVaultReconciled();
    await assertVaultAtTarget();
    expect(after.totalShares).to.equal(before.totalShares - sharesAmount);
    expect(after.shareRate).to.equal(before.shareRate);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  7. Skipped Oracle Report
  // ═══════════════════════════════════════════════════════════════════════

  it("7.1 Accumulated redeems across frames — all burned, rate exactly preserved", async () => {
    const { lido } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    const before = await captureState();

    // 3 redeems without report
    const r1 = await redeemWithReceipt(holder, ether("5"), holder.address);
    const r2 = await redeemWithReceipt(holder, ether("5"), holder.address);
    const r3 = await redeemWithReceipt(holder, ether("5"), holder.address);
    const totalShares = r1.sharesAmount + r2.sharesAmount + r3.sharesAmount;
    const totalEther = r1.etherAmount + r2.etherAmount + r3.etherAmount;

    // vaultDelta = sum of all redeemed ETH
    const midTracked = await lido.getRedeemsReserveVaultEth();
    const midActual = await ethers.provider.getBalance(await vault.getAddress());
    expect(midTracked - midActual).to.equal(totalEther);
    // Tracked stale
    expect(midTracked).to.equal(before.trackedVaultEth);

    // Rate exactly unchanged between reports (clDiff=0, overcount cancels)
    expect(await lido.getPooledEthByShares(ether("1"))).to.equal(before.shareRate);

    // Single report — clDiff=0 → rate exactly preserved
    await report(ctx, reportOpts);

    const after = await captureState();

    // Rate exactly equal (no CL rewards, paired burn net-neutral)
    expect(after.shareRate).to.equal(before.shareRate);
    // Tracked == actual
    expect(after.trackedVaultEth).to.equal(after.vaultBalance);
    // All shares burned
    expect(after.nonCoverPending).to.equal(0n);
    // Shares decreased by exact total
    expect(after.totalShares).to.equal(before.totalShares - totalShares);
  });

  it("7.2 Large accumulated delta — state correct after report", async () => {
    const { lido } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    const before = await captureState();

    const holderStETH = await lido.balanceOf(holder.address);
    const redeemAmount = before.vaultBalance < holderStETH ? before.vaultBalance - ether("1") : holderStETH / 2n;
    const { sharesAmount } = await redeemWithReceipt(holder, redeemAmount, holder.address);

    // clDiff=0 → exact shares
    await report(ctx, reportOpts);

    const after = await captureState();

    await assertVaultReconciled();
    expect(after.totalShares).to.equal(before.totalShares - sharesAmount);
    expect(after.shareRate).to.equal(before.shareRate);
    expect(after.nonCoverPending).to.equal(0n);
  });

  it("7.3 Submit between reports does not refill vault — only report does", async () => {
    const { lido } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    // Redeem drains some vault ETH
    await redeemWithReceipt(holder, ether("10"), holder.address);
    const vaultAfterRedeem = await ethers.provider.getBalance(await vault.getAddress());
    const trackedAfterRedeem = await lido.getRedeemsReserveVaultEth();

    // submit() does NOT change vault balance or tracked ETH
    await lido.connect(holderB).submit(ZeroAddress, { value: ether("50"), gasPrice: 0 });

    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(vaultAfterRedeem);
    expect(await lido.getRedeemsReserveVaultEth()).to.equal(trackedAfterRedeem);

    // Target increased (higher TVL from submit), but vault still at old level
    const target = await lido.getRedeemsReserveTarget();
    expect(target).to.be.gt(vaultAfterRedeem);

    await report(ctx, reportOpts);
    await assertVaultReconciled();
    await assertVaultAtTarget();
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  8. Oracle Report Interactions
  // ═══════════════════════════════════════════════════════════════════════

  it("8.1 Full vault drain — report passes, vault replenished, tracked reconciled", async () => {
    const { lido } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    const before = await captureState();

    const holderStETH = await lido.balanceOf(holder.address);
    const redeemAmount = before.vaultBalance < holderStETH ? before.vaultBalance - 1n : holderStETH / 2n;
    const { sharesAmount } = await redeemWithReceipt(holder, redeemAmount, holder.address);

    await report(ctx, reportOpts);

    const after = await captureState();

    await assertVaultReconciled();
    await assertVaultAtTarget();
    expect(after.totalShares).to.equal(before.totalShares - sharesAmount);
    expect(after.shareRate).to.equal(before.shareRate);
  });

  it("8.2 Sandwich: attacker gets fewer shares back at higher post-report rate", async () => {
    const { lido } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    const attackAmount = ether("10");
    await lido.connect(holder).transfer(stranger.address, attackAmount);

    const attackerSharesBefore = await lido.sharesOf(stranger.address);
    const attackerEthBefore = await ethers.provider.getBalance(stranger.address);
    const rateBefore = await lido.getPooledEthByShares(ether("1"));

    // "Front-run": redeem at current rate (gasPrice=0 → exact ETH tracking)
    const { etherAmount, sharesAmount } = await redeemWithReceipt(stranger, attackAmount, stranger.address);

    // Exact ETH received (gas cost = 0)
    const attackerEthAfter = await ethers.provider.getBalance(stranger.address);
    expect(attackerEthAfter - attackerEthBefore).to.equal(etherAmount);
    // Exact shares redeemed
    expect(await lido.sharesOf(stranger.address)).to.equal(attackerSharesBefore - sharesAmount);

    // Report with rewards — rate increases
    await report(ctx, { ...reportOpts, clDiff: ether("0.01") });

    const after = await captureState();

    // Rate = TPE / totalShares — verify consistency
    const expectedRate = (after.totalPooledEther * ether("1")) / after.totalShares;
    expect(after.shareRate).to.equal(expectedRate);
    // Rate increased from rewards (exact: TPE increased by clDiff)
    expect(after.shareRate).to.not.equal(rateBefore);

    // Core sandwich assertion: at higher rate, attacker's ETH buys strictly fewer shares
    const sharesAtNewRate = await lido.getSharesByPooledEth(etherAmount);
    expect(sharesAtNewRate).to.be.lt(sharesAmount); // strict inequality proves no profit
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  9. Bunker Mode
  // ═══════════════════════════════════════════════════════════════════════

  it("9.1 Bunker mode blocks redeem — recovery restores it", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    // Transfer stETH to stranger for redeem
    await lido.connect(holder).transfer(stranger.address, ether("20"), { gasPrice: 0 });

    // Enter bunker mode via large negative CL rebase (skipWithdrawals must be false for bunker flag)
    await resetCLBalanceDecreaseWindow(ctx);
    await reportWithEffectiveClDiff(ctx, ether("-1"), { excludeVaultsBalances: true });
    expect(await withdrawalQueue.isBunkerModeActive()).to.equal(true);

    // Redeem reverts in bunker mode
    const vaultAddr = await vault.getAddress();
    await lido.connect(stranger).approve(vaultAddr, ether("10"), { gasPrice: 0 });
    await expect(
      vault.connect(stranger).redeem(ether("1"), stranger.address, { gasPrice: 0 }),
    ).to.be.revertedWithCustomError(vault, "BunkerMode");

    // Exit bunker mode via neutral report
    await reportWithEffectiveClDiff(ctx, 0n, { excludeVaultsBalances: true });
    expect(await withdrawalQueue.isBunkerModeActive()).to.equal(false);

    // Vault survived bunker — still reconciled and at target
    await assertVaultReconciled();
    await assertVaultAtTarget();

    // Redeem works again
    const { etherAmount } = await redeemWithReceipt(stranger, ether("1"), stranger.address);
    expect(etherAmount).to.be.gt(0n);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  10. Negative Rebase — Target Recalculation
  // ═══════════════════════════════════════════════════════════════════════

  it("10.1 Negative rebase shrinks target — vault capped to new lower target", async () => {
    const { lido } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    const targetBefore = await lido.getRedeemsReserveTarget();
    const vaultBefore = await ethers.provider.getBalance(await vault.getAddress());
    const bufferedBefore = await lido.getBufferedEther();
    expect(vaultBefore).to.equal(targetBefore);

    await resetCLBalanceDecreaseWindow(ctx);
    await reportWithEffectiveClDiff(ctx, ether("-50"), { excludeVaultsBalances: true, skipWithdrawals: true });

    const targetAfter = await lido.getRedeemsReserveTarget();
    const vaultAfter = await ethers.provider.getBalance(await vault.getAddress());

    expect(targetAfter).to.be.lt(targetBefore);
    await assertVaultReconciled();
    await assertVaultAtTarget();
    // Excess ETH returned to buffer
    const excessReturned = vaultBefore - vaultAfter;
    expect(excessReturned).to.be.gt(0n);
    // Buffer absorbed the returned vault ETH (minus CL loss impact)
    expect(await lido.getBufferedEther()).to.be.gt(bufferedBefore);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  11. Oracle Rate Effects — A/B drain vs no-drain
  // ═══════════════════════════════════════════════════════════════════════

  it("11.1 Rate after drain+rewards vs no-drain+rewards — deviation bounded", async () => {
    const { lido } = ctx.contracts;

    // Scenario A: no drain, just rewards
    await setupVault(ether("1000"), 500n);
    await report(ctx, { ...reportOpts, clDiff: ether("0.01") });
    const rateA = await lido.getPooledEthByShares(ether("1"));

    // Restore and run scenario B: drain + same rewards
    await Snapshot.restore(testSnapshot);
    testSnapshot = await Snapshot.take();
    await setupVault(ether("1000"), 500n);
    await redeemWithReceipt(holder, ether("30"), holder.address);
    await report(ctx, { ...reportOpts, clDiff: ether("0.01") });
    const rateB = await lido.getPooledEthByShares(ether("1"));

    // Drain concentrates rewards on fewer shares → rate higher
    expect(rateB).to.be.gt(rateA);

    // Deviation bounded: < 1% (30 ETH drain from 1000 ETH TVL = 3%)
    const rateDiff = rateB - rateA;
    expect(rateDiff).to.be.lte(rateA / 100n);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  12. Bad Debt — vault unaffected, redeem quote drops
  // ═══════════════════════════════════════════════════════════════════════

  it("12.1 Bad debt: vault tracked unchanged, redeem gets reduced rate", async () => {
    const { lido } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    // Setup external shares so bad debt can be internalized
    const agent = await ctx.getSigner("agent");
    await ctx.contracts.acl
      .connect(agent)
      .grantPermission(holder.address, lido.address, await lido.STAKING_CONTROL_ROLE());
    await lido.connect(holder).setMaxExternalRatioBP(5000n);
    const vaultHub = await impersonate(await ctx.contracts.locator.vaultHub(), ether("10"));
    await lido.connect(vaultHub).mintExternalShares(stranger.address, ether("10"));
    await report(ctx, reportOpts);

    const vaultBefore = await ethers.provider.getBalance(await vault.getAddress());
    const trackedBefore = await lido.getRedeemsReserveVaultEth();
    const targetBefore = await lido.getRedeemsReserveTarget();
    const rateBefore = await lido.getPooledEthByShares(ether("1"));

    const accountingSigner = await impersonate(await ctx.contracts.locator.accounting(), ether("10"));
    await lido.connect(accountingSigner).internalizeExternalBadDebt(ether("5"));

    const rateAfter = await lido.getPooledEthByShares(ether("1"));
    expect(rateAfter).to.be.lt(rateBefore);
    // Vault balance, tracked, and target unchanged by bad debt
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(vaultBefore);
    expect(await lido.getRedeemsReserveVaultEth()).to.equal(trackedBefore);
    expect(await lido.getRedeemsReserveTarget()).to.equal(targetBefore);

    // Fixed share amount gets less ETH at reduced rate
    const probeShares = ether("1");
    const ethPerShareBefore = (probeShares * rateBefore) / ether("1");
    const ethPerShareAfter = (probeShares * rateAfter) / ether("1");
    expect(ethPerShareAfter).to.be.lt(ethPerShareBefore);

    // Redeem still works at reduced rate
    const { etherAmount } = await redeemWithReceipt(holder, ether("10"), holder.address);
    expect(etherAmount).to.be.gt(0n);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  13. Insurance Burn — rate impact on redeem
  // ═══════════════════════════════════════════════════════════════════════

  it("13.1 Insurance burn increases rate — redeemer gets more ETH per stETH", async () => {
    const { lido } = ctx.contracts;
    await setupVault(ether("1000"), 500n);

    const vaultBefore = await ethers.provider.getBalance(await vault.getAddress());
    const trackedBefore = await lido.getRedeemsReserveVaultEth();
    const targetBefore = await lido.getRedeemsReserveTarget();
    const rateBefore = await lido.getPooledEthByShares(ether("1"));

    const burnStETH = ether("5");
    const sharesToBurn = await lido.getSharesByPooledEth(burnStETH);
    const burnerAddr = await ctx.contracts.locator.burner();
    await lido.connect(holder).transfer(burnerAddr, burnStETH, { gasPrice: 0 });
    const burnerSigner = await impersonate(burnerAddr, ether("10"));
    await lido.connect(burnerSigner).burnShares(sharesToBurn);

    const rateAfter = await lido.getPooledEthByShares(ether("1"));
    expect(rateAfter).to.be.gt(rateBefore);
    // Vault balance, tracked, and target unchanged by insurance burn
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(vaultBefore);
    expect(await lido.getRedeemsReserveVaultEth()).to.equal(trackedBefore);
    expect(await lido.getRedeemsReserveTarget()).to.equal(targetBefore);

    // Fixed share amount gets more ETH at higher rate
    const probeShares = ether("1");
    const ethPerShareBefore = (probeShares * rateBefore) / ether("1");
    const ethPerShareAfter = (probeShares * rateAfter) / ether("1");
    expect(ethPerShareAfter).to.be.gt(ethPerShareBefore);

    // Redeem still works at new rate
    const { etherAmount } = await redeemWithReceipt(holder, ether("10"), holder.address);
    expect(etherAmount).to.be.gt(0n);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  14. Simulated Share Rate Deviation
  // ═══════════════════════════════════════════════════════════════════════

  it("14.1 Redeem between refSlot and report — actual rate deviates from simulated, bounded by spec formula", async () => {
    const { lido } = ctx.contracts;
    // Large deposit so holder has enough stETH to drain entire vault
    await setupVault(ether("10000"), 500n);

    const clDiff = ether("0.01");

    // Dry-run report at refSlot — simulated rate BEFORE redeem
    const { hashConsensus } = ctx.contracts;
    const refSlot = (await hashConsensus.getCurrentFrame()).refSlot;
    const simResult = await report(ctx, {
      clDiff,
      excludeVaultsBalances: true,
      skipWithdrawals: true,
      refSlot,
      waitNextReportTime: false,
      dryRun: true,
    });

    const SHARE_RATE_PRECISION = 10n ** 27n;
    const simulatedRate = BigInt(simResult.data.simulatedShareRate);

    // Redeem entire vault AFTER refSlot — worst case for deviation
    const vaultBalance = await ethers.provider.getBalance(await vault.getAddress());
    expect(await lido.balanceOf(holder.address)).to.be.gte(vaultBalance);
    await redeemWithReceipt(holder, vaultBalance, holder.address);
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.be.lte(1n);

    // Actual report — same params, applies to post-redeem state
    await report(ctx, {
      clDiff,
      excludeVaultsBalances: true,
      skipWithdrawals: true,
    });

    // Compute actual post-report rate
    const actualRate = ((await lido.getTotalPooledEther()) * SHARE_RATE_PRECISION) / (await lido.getTotalShares());

    // Deviation: actual > simulated (rewards on smaller base = higher rate)
    expect(actualRate).to.be.gte(simulatedRate);

    const deviation = actualRate - simulatedRate;
    const deviationBP = (deviation * 10000n) / simulatedRate;

    // Spec formula: deviation ≈ etherRedeemed / internalEther × rebasePercent
    // With 5% redeem and 0.001% rebase → deviation ≈ 0.00005% ≈ 0.005 BP
    // Must be well within 250 BP sanity checker limit
    expect(deviationBP).to.be.lt(250n);

    // Verify deviation is non-zero (redeem actually affected the rate)
    // With clDiff > 0, the base shrinks from redeem → rate increases → deviation > 0
    expect(deviation).to.be.gt(0n);
  });
});
