import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Lido, RedeemsBuffer } from "typechain-types";

import { advanceChainTime, ether, impersonate, updateBalance } from "lib";
import { LIMITER_PRECISION_BASE } from "lib/constants";
import {
  ProtocolContext,
  report,
  reportWithEffectiveClDiff,
  resetCLBalanceDecreaseWindow,
  setMaxPositiveTokenRebase,
  submitReportDataWithConsensus,
  updateOracleReportLimits,
} from "lib/protocol";
import { proxify } from "lib/proxy";

export interface VaultFixture {
  vault: RedeemsBuffer;
  address: string;
}

export interface ProtocolState {
  internalEther: bigint;
  shareRate: bigint;
  totalPooledEther: bigint;
  totalShares: bigint;
  reserve: bigint;
  reserveTarget: bigint;
}

export interface BufferState {
  buffered: bigint;
  reserve: bigint;
  reserveTarget: bigint;
  depositsReserve: bigint;
  withdrawalsReserve: bigint;
  depositable: bigint;
  unfinalizedStETH: bigint;
}

export interface BunkerCheckpoint {
  protocol: ProtocolState;
  externalShares: bigint;
  internalShares: bigint;
  bunkerMode: boolean;
  lastFinalizedRequestId: bigint;
  unfinalizedStETH: bigint;
}

/** Deploys RedeemsBuffer, grants roles, registers on Lido. Call once in before(). */
export async function setupVault(
  ctx: ProtocolContext,
  admin: HardhatEthersSigner,
  extraRedeemers: HardhatEthersSigner[] = [],
): Promise<VaultFixture> {
  const { lido, burner, locator } = ctx.contracts;
  const agent = await ctx.getSigner("agent");

  const factory = await ethers.getContractFactory("RedeemsBuffer");
  const hashConsensusAddr = await ctx.contracts.hashConsensus.getAddress();
  const impl = await factory.connect(admin).deploy(await locator.getAddress(), hashConsensusAddr);
  const [vault] = await proxify({ impl, admin });
  await vault.initialize(admin.address);

  const burnRole = await burner.REQUEST_BURN_SHARES_ROLE();
  await burner.connect(agent).grantRole(burnRole, await vault.getAddress());
  await lido.connect(admin).setRedeemsBuffer(await vault.getAddress());

  const redeemerRole = await vault.REDEEMER_ROLE();
  await vault.connect(admin).grantRole(redeemerRole, admin.address);
  for (const signer of extraRedeemers) {
    await vault.connect(admin).grantRole(redeemerRole, signer.address);
  }

  return { vault, address: await vault.getAddress() };
}

/** Deposits ETH, applies initial rebase for non-1:1 rate, sets reserve ratio, runs report to fill reserve */
export async function seedReserve(
  ctx: ProtocolContext,
  holder: HardhatEthersSigner,
  reserveManager: HardhatEthersSigner,
  opts: {
    deposit: bigint;
    redeemsReserveRatioBP: bigint;
    depositsReserveTarget?: bigint;
    growthShareBP?: bigint;
  },
) {
  const { lido } = ctx.contracts;

  if (opts.deposit > 0n) {
    await lido.connect(holder).submit(ZeroAddress, { value: opts.deposit });
  }

  // Initial rebase via EL rewards to create non-1:1 share rate — catches rounding edge cases.
  // Uses EL vault instead of CL diff so it works even after resetProtocolState (no validators).
  await fundElRewards(ctx, ether("0.0037"));
  await doReport(ctx, { excludeVaultsBalances: false, reportElVault: true, reportWithdrawalsVault: false });

  await lido.connect(reserveManager).setRedeemsReserveTargetRatio(opts.redeemsReserveRatioBP);

  if (opts.depositsReserveTarget !== undefined) {
    await lido.connect(reserveManager).setDepositsReserveTarget(opts.depositsReserveTarget);
  }
  if (opts.growthShareBP !== undefined) {
    await lido.connect(reserveManager).setRedeemsReserveGrowthShare(opts.growthShareBP);
  }

  await doReport(ctx);
}

/** Submits an oracle report with push-friendly defaults */
export function doReport(ctx: ProtocolContext, opts: Parameters<typeof report>[1] = {}) {
  return report(ctx, {
    clDiff: 0n,
    excludeVaultsBalances: true,
    skipWithdrawals: true,
    ...opts,
  });
}

/** Approves vault and redeems stETH. Verifies vault balance decrease and recipient ETH receipt. */
export async function redeemExact(
  lido: Lido,
  holder: HardhatEthersSigner,
  fixture: VaultFixture,
  amount: bigint,
  recipient?: string,
) {
  const ethRecipient = recipient ?? holder.address;
  const sharesAmount = await lido.getSharesByPooledEth(amount);
  const etherAmount = await lido.getPooledEthByShares(sharesAmount);

  const vaultBalBefore = await ethers.provider.getBalance(fixture.address);
  const recipientBalBefore = await ethers.provider.getBalance(ethRecipient);

  await lido.connect(holder).approve(fixture.address, amount + 10n, { gasPrice: 0 });
  await fixture.vault.connect(holder).redeem(amount, ethRecipient, { gasPrice: 0 });

  expect(await ethers.provider.getBalance(fixture.address)).to.equal(
    vaultBalBefore - etherAmount,
    "vault balance mismatch after redeem",
  );
  expect(await ethers.provider.getBalance(ethRecipient)).to.equal(
    recipientBalBefore + etherAmount,
    "recipient ETH balance mismatch after redeem",
  );
}

export interface RedeemQuote {
  stETHAmount: bigint;
  shares: bigint;
  ether: bigint;
}

/** Captures the current redeem quote for a given stETH amount */
export async function captureRedeemQuote(lido: Lido, stETHAmount: bigint): Promise<RedeemQuote> {
  const shares = await lido.getSharesByPooledEth(stETHAmount);
  const pooledEther = await lido.getPooledEthByShares(shares);
  return { stETHAmount, shares, ether: pooledEther };
}

/** Re-quotes the ETH value of a fixed shares amount at the current share rate */
export async function quoteShares(lido: Lido, shares: bigint): Promise<bigint> {
  return await lido.getPooledEthByShares(shares);
}

/** Captures current protocol state into a snapshot object */
export async function captureState(lido: Lido): Promise<ProtocolState> {
  const totalPooledEther = await lido.getTotalPooledEther();
  const externalEther = await lido.getExternalEther();

  return {
    internalEther: totalPooledEther - externalEther,
    shareRate: await lido.getPooledEthByShares(ether("1")),
    totalPooledEther,
    totalShares: await lido.getTotalShares(),
    reserve: await lido.getRedeemsReserve(),
    reserveTarget: await lido.getRedeemsReserveTarget(),
  };
}

/** Captures current buffer allocation and withdrawal demand */
export async function captureBufferState(ctx: ProtocolContext): Promise<BufferState> {
  const { lido, withdrawalQueue } = ctx.contracts;

  return {
    buffered: await lido.getBufferedEther(),
    reserve: await lido.getRedeemsReserve(),
    reserveTarget: await lido.getRedeemsReserveTarget(),
    depositsReserve: await lido.getDepositsReserve(),
    withdrawalsReserve: await lido.getWithdrawalsReserve(),
    depositable: await lido.getDepositableEther(),
    unfinalizedStETH: await withdrawalQueue.unfinalizedStETH(),
  };
}

/** Computes expected reserve target from internal ether and ratio */
export function expectedReserveTarget(internalEther: bigint, ratioBP: bigint): bigint {
  return (ratioBP * internalEther) / 10_000n;
}

/**
 * Validates reserve is fully funded: target matches internalEther × ratioBP, and reserve == target.
 * Only valid after a report when the buffer has enough ETH to fill the reserve.
 */
export function assertReserveState(state: ProtocolState, ratioBP: bigint) {
  expect(state.reserveTarget).to.equal(expectedReserveTarget(state.internalEther, ratioBP));
  expect(state.reserve).to.equal(state.reserveTarget);
}

/** Asserts buffered = reserve + deposits + wq + unreserved, depositable = deposits + unreserved */
export async function assertReserveAllocationInvariant(lido: Lido) {
  const buffered = await lido.getBufferedEther();
  const reserve = await lido.getRedeemsReserve();
  const deposits = await lido.getDepositsReserve();
  const wq = await lido.getWithdrawalsReserve();
  const depositable = await lido.getDepositableEther();
  const unreserved = buffered - reserve - deposits - wq;

  expect(depositable).to.equal(buffered - reserve - wq, "depositable mismatch");
  expect(depositable).to.equal(deposits + unreserved, "depositable should equal deposits reserve plus unreserved");
  expect(buffered).to.equal(reserve + deposits + wq + unreserved, "buffered ether allocation mismatch");
}

type RedeemSize = "small" | "huge" | "full";

/** Computes a redeem amount based on the current reserve */
export async function getRedeemAmount(lido: Lido, size: RedeemSize): Promise<bigint> {
  const reserve = await lido.getRedeemsReserve();
  switch (size) {
    case "small":
      return (reserve * 5n) / 100n;
    case "huge":
      return (reserve * 50n) / 100n;
    case "full": {
      const shares = await lido.getSharesByPooledEth(reserve);
      return await lido.getPooledEthByShares(shares);
    }
  }
}

/** Funds the EL rewards vault with the given amount */
export async function fundElRewards(ctx: ProtocolContext, amount: bigint) {
  const elVaultAddr = await ctx.contracts.locator.elRewardsVault();
  await updateBalance(elVaultAddr, amount);
}

/**
 * Simulates insurance application: transfers stETH from holder to a dedicated insurance signer,
 * then burns it as cover via the Burner.
 */
export async function applyInsurance(ctx: ProtocolContext, holder: HardhatEthersSigner, amount: bigint) {
  const { lido, burner } = ctx.contracts;
  const burnRole = await burner.REQUEST_BURN_MY_STETH_ROLE();
  const adminRole = await burner.DEFAULT_ADMIN_ROLE();
  const agent = await ctx.getSigner("agent");
  const agentSigner = await impersonate(agent.address, ether("1"));

  const [, , , , , , , , insuranceSigner] = await ethers.getSigners();

  if (!(await burner.hasRole(adminRole, agent.address))) {
    throw new Error("agent does not have DEFAULT_ADMIN_ROLE on Burner");
  }

  if (!(await burner.hasRole(burnRole, insuranceSigner.address))) {
    await burner.connect(agentSigner).grantRole(burnRole, insuranceSigner.address);
  }

  await lido.connect(holder).transfer(insuranceSigner.address, amount);
  await lido.connect(insuranceSigner).approve(burner, amount);
  await burner.connect(insuranceSigner).requestBurnMyStETHForCover(amount);
}

/** Advances time past one full oracle frame without submitting a report */
export async function skipReport(ctx: ProtocolContext) {
  const { slotsPerEpoch, secondsPerSlot } = await ctx.contracts.hashConsensus.getChainConfig();
  const [, epochsPerFrame] = await ctx.contracts.hashConsensus.getFrameConfig();
  const frameSeconds = slotsPerEpoch * secondsPerSlot * epochsPerFrame;
  await advanceChainTime(frameSeconds + 1n);
}

/** Mines the given number of empty blocks */
export async function mineBlocks(count: number) {
  for (let i = 0; i < count; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

/** Enters bunker mode via a negative CL report */
export async function enterBunkerMode(
  ctx: ProtocolContext,
  opts: {
    effectiveClDiff?: bigint;
    reportParams?: Exclude<Parameters<typeof reportWithEffectiveClDiff>[2], undefined>;
  } = {},
) {
  const effectiveClDiff = opts.effectiveClDiff ?? ether("-1");
  await resetCLBalanceDecreaseWindow(ctx);
  const result = await reportWithEffectiveClDiff(ctx, effectiveClDiff, {
    excludeVaultsBalances: true,
    ...opts.reportParams,
  });
  expect(await ctx.contracts.withdrawalQueue.isBunkerModeActive()).to.equal(true, "failed to enter bunker mode");
  return result;
}

/** Exits bunker mode via a recovery report */
export async function exitBunkerMode(
  ctx: ProtocolContext,
  opts: {
    effectiveClDiff?: bigint;
    reportParams?: Exclude<Parameters<typeof reportWithEffectiveClDiff>[2], undefined>;
  } = {},
) {
  const effectiveClDiff = opts.effectiveClDiff ?? ether("0.0001");
  await reportWithEffectiveClDiff(ctx, effectiveClDiff, {
    excludeVaultsBalances: true,
    ...opts.reportParams,
  });
  expect(await ctx.contracts.withdrawalQueue.isBunkerModeActive()).to.equal(false, "failed to exit bunker mode");
}

/** Extracts the exact amount of ETH locked for WQ finalization from a report receipt */
export async function getAmountOfETHLocked(
  ctx: ProtocolContext,
  reportResult: { reportTx?: { wait(): Promise<import("ethers").TransactionReceipt | null> } },
): Promise<bigint> {
  const receipt = await reportResult.reportTx?.wait();
  if (!receipt) return 0n;

  for (const log of receipt.logs) {
    try {
      const parsed = ctx.contracts.withdrawalQueue.interface.parseLog(log);
      if (parsed?.name === "WithdrawalsFinalized") {
        return parsed.args.amountOfETHLocked;
      }
    } catch {
      continue;
    }
  }

  return 0n;
}

/** Creates one WQ request and verifies unfinalized demand increased */
export async function requestWithdrawal(
  ctx: ProtocolContext,
  from: HardhatEthersSigner,
  amount: bigint,
): Promise<bigint> {
  const { lido, withdrawalQueue } = ctx.contracts;
  const unfinalizedBefore = await withdrawalQueue.unfinalizedStETH();
  const lastRequestIdBefore = await withdrawalQueue.getLastRequestId();

  await lido.connect(from).approve(withdrawalQueue, amount);
  await withdrawalQueue.connect(from).requestWithdrawals([amount], from.address);

  const requestId = await withdrawalQueue.getLastRequestId();
  expect(requestId).to.equal(lastRequestIdBefore + 1n);
  expect(await withdrawalQueue.unfinalizedStETH()).to.equal(unfinalizedBefore + amount);
  return requestId;
}

/** Advances chain time past requestTimestampMargin so pending WQ requests pass the creation-time sanity check */
export async function advancePastRequestTimestampMargin(ctx: ProtocolContext) {
  const { requestTimestampMargin } = await ctx.contracts.oracleReportSanityChecker.getOracleReportLimits();
  await advanceChainTime(requestTimestampMargin + 1n);
}

/** Captures bunker state and asserts reserve allocation invariants first */
export async function captureValidatedBunkerCheckpoint(ctx: ProtocolContext): Promise<BunkerCheckpoint> {
  await assertReserveAllocationInvariant(ctx.contracts.lido);
  const { lido, withdrawalQueue } = ctx.contracts;
  const protocol = await captureState(lido);
  const externalShares = await lido.getExternalShares();

  return {
    protocol,
    externalShares,
    internalShares: protocol.totalShares - externalShares,
    bunkerMode: await withdrawalQueue.isBunkerModeActive(),
    lastFinalizedRequestId: await withdrawalQueue.getLastFinalizedRequestId(),
    unfinalizedStETH: await withdrawalQueue.unfinalizedStETH(),
  };
}

/** Applies another negative bunker report without WQ finalization and keeps bunker mode active */
export async function processNegativeReportInBunker(ctx: ProtocolContext, effectiveClDiff: bigint) {
  const dryRun = await reportWithEffectiveClDiff(ctx, effectiveClDiff, {
    excludeVaultsBalances: true,
    skipWithdrawals: true,
    dryRun: true,
  });

  await submitReportDataWithConsensus(ctx, {
    ...dryRun.data,
    withdrawalFinalizationBatches: [],
    isBunkerMode: true,
  });

  const { addresses } = await ctx.contracts.hashConsensus.getFastLaneMembers();
  const member = await impersonate(addresses[0], ether("1"));
  await ctx.contracts.accountingOracle.connect(member).submitReportExtraDataEmpty();

  expect(await ctx.contracts.withdrawalQueue.isBunkerModeActive()).to.equal(true, "failed to keep bunker mode active");
  return dryRun;
}

/** Verifies that vault.redeem reverts with BunkerMode during bunker */
export async function expectRedeemBlockedInBunker(
  ctx: ProtocolContext,
  from: HardhatEthersSigner,
  fixture: VaultFixture,
  amount: bigint,
) {
  const { lido } = ctx.contracts;
  await lido.connect(from).approve(fixture.address, amount + 10n, { gasPrice: 0 });
  await expect(fixture.vault.connect(from).redeem(amount, from.address, { gasPrice: 0 })).to.be.revertedWithCustomError(
    fixture.vault,
    "BunkerMode",
  );
}

/** Redeems after bunker exit via vault and verifies it succeeds */
export async function redeemAfterBunkerExit(
  lido: Lido,
  from: HardhatEthersSigner,
  fixture: VaultFixture,
  amount: bigint,
) {
  await redeemExact(lido, from, fixture, amount);
}

/**
 * Resets the protocol to a near-empty state: all stETH holders drained via the Withdrawal
 * Queue, all requests finalized, CL balance zeroed.
 */
export async function resetProtocolState(ctx: ProtocolContext) {
  const { lido, withdrawalQueue } = ctx.contracts;
  const MIN_WQ_AMOUNT = ether("0.001");
  const MAX_WQ_AMOUNT = ether("1000");

  const holderAddrs = await discoverStETHHolders(ctx);

  for (const addr of holderAddrs) {
    const balance = await lido.balanceOf(addr);
    if (balance < MIN_WQ_AMOUNT) continue;

    const signer = await impersonate(addr, ether("1"));
    await lido.connect(signer).approve(withdrawalQueue, balance);

    const chunks: bigint[] = [];
    let remaining = balance;
    while (remaining >= MIN_WQ_AMOUNT) {
      const chunk = remaining > MAX_WQ_AMOUNT ? MAX_WQ_AMOUNT : remaining;
      chunks.push(chunk);
      remaining -= chunk;
    }
    await withdrawalQueue.connect(signer).requestWithdrawals(chunks, addr);
  }

  if ((await withdrawalQueue.unfinalizedStETH()) === 0n) return;

  // Finalize via simulated validator exits
  const savedRebaseLimit = await setMaxPositiveTokenRebase(ctx, LIMITER_PRECISION_BASE);
  const savedLimits = await ctx.contracts.oracleReportSanityChecker.getOracleReportLimits();
  await updateOracleReportLimits(ctx, {
    maxCLBalanceDecreaseBP: 10000n,
    simulatedShareRateDeviationBPLimit: 10000n,
  });

  await resetCLBalanceDecreaseWindow(ctx);

  const withdrawalVaultAddr = await ctx.contracts.locator.withdrawalVault();
  const stats = await lido.getBalanceStats();
  let remainingCl = stats.clValidatorsBalanceAtLastReport + stats.clPendingBalanceAtLastReport;

  for (let i = 0; i < 20; i++) {
    const unfinalized = await withdrawalQueue.unfinalizedStETH();
    if (unfinalized === 0n) break;

    const exitChunk = unfinalized < remainingCl ? unfinalized : remainingCl;
    if (exitChunk > 0n) {
      const vaultBal = await ethers.provider.getBalance(withdrawalVaultAddr);
      await updateBalance(withdrawalVaultAddr, vaultBal + exitChunk);
      remainingCl -= exitChunk;
    }

    await report(ctx, {
      clDiff: exitChunk > 0n ? -exitChunk : 0n,
      excludeVaultsBalances: false,
      skipWithdrawals: false,
      sharesRequestedToBurn: 0n,
    });
  }

  // Drain remaining requests from the buffer
  if ((await withdrawalQueue.unfinalizedStETH()) > 0n) {
    const agent = await ctx.getSigner("agent");
    const role = await lido.BUFFER_RESERVE_MANAGER_ROLE();
    const { acl } = ctx.contracts;
    const hasRole = await acl["hasPermission(address,address,bytes32)"](agent.address, lido.getAddress(), role);
    if (!hasRole) {
      await acl.connect(agent).grantPermission(agent.address, lido.getAddress(), role);
    }
    const savedRatio = await lido.getRedeemsReserveTargetRatio();
    const savedDepositsTarget = await lido.getDepositsReserveTarget();
    await lido.connect(agent).setRedeemsReserveTargetRatio(0n);
    await lido.connect(agent).setDepositsReserveTarget(0n);

    for (let i = 0; i < 10; i++) {
      if ((await withdrawalQueue.unfinalizedStETH()) === 0n) break;
      await report(ctx, {
        clDiff: 0n,
        excludeVaultsBalances: false,
        skipWithdrawals: false,
        sharesRequestedToBurn: 0n,
      });
    }

    await lido.connect(agent).setRedeemsReserveTargetRatio(savedRatio);
    await lido.connect(agent).setDepositsReserveTarget(savedDepositsTarget);
  }

  expect(await withdrawalQueue.unfinalizedStETH()).to.equal(0n, "resetProtocolState: failed to finalize all requests");

  await setMaxPositiveTokenRebase(ctx, savedRebaseLimit);
  await updateOracleReportLimits(ctx, {
    maxCLBalanceDecreaseBP: savedLimits.maxCLBalanceDecreaseBP,
    simulatedShareRateDeviationBPLimit: savedLimits.simulatedShareRateDeviationBPLimit,
  });
}

async function discoverStETHHolders(ctx: ProtocolContext): Promise<string[]> {
  const { lido, withdrawalQueue, locator } = ctx.contracts;

  const transfers = await lido.queryFilter(lido.filters.Transfer());
  const holdersSet = new Set<string>();
  for (const t of transfers) {
    if (t.args[1] !== ZeroAddress) holdersSet.add(t.args[1]);
  }

  const excludeAddrs = new Set(
    [await locator.burner(), await withdrawalQueue.getAddress(), await lido.getAddress()].map((a) => a.toLowerCase()),
  );

  return [...holdersSet].filter((a) => !excludeAddrs.has(a.toLowerCase()));
}
