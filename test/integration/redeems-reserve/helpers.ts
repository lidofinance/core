import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { EtherReceiver__MockForLidoRedeems, Lido } from "typechain-types";

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

export interface RedeemerFixture {
  redeemer: EtherReceiver__MockForLidoRedeems;
  address: string;
}

export interface RedeemQuote {
  stETHAmount: bigint;
  shares: bigint;
  ether: bigint;
}

/** Deploys the redeemer mock and registers it on Lido */
export async function setupRedeemer(
  ctx: ProtocolContext,
  reserveManager: HardhatEthersSigner,
): Promise<RedeemerFixture> {
  const { lido } = ctx.contracts;
  const redeemer = (await ethers.deployContract("EtherReceiver__MockForLidoRedeems", [
    await lido.getAddress(),
  ])) as unknown as EtherReceiver__MockForLidoRedeems;
  const address = await redeemer.getAddress();
  await lido.connect(reserveManager).setStETHRedeemer(address);
  return { redeemer, address };
}

/** Deposits ETH, sets reserve ratio, and runs a report to fill the reserve */
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
  await lido.connect(reserveManager).setRedeemsReserveTargetRatio(opts.redeemsReserveRatioBP);
  if (opts.depositsReserveTarget !== undefined) {
    await lido.connect(reserveManager).setDepositsReserveTarget(opts.depositsReserveTarget);
  }
  if (opts.growthShareBP !== undefined) {
    await lido.connect(reserveManager).setRedeemsReserveGrowthShare(opts.growthShareBP);
  }
  await doReport(ctx);
}

/** Submits an oracle report with default options (no vaults, no WQ, no burner) */
export function doReport(ctx: ProtocolContext, opts: Parameters<typeof report>[1] = {}) {
  return report(ctx, {
    clDiff: 0n,
    excludeVaultsBalances: true,
    reportBurner: false,
    skipWithdrawals: true,
    ...opts,
  });
}

/** Transfers stETH to the redeemer, calls redeemStETH, and verifies state changes */
export async function redeemExact(lido: Lido, holder: HardhatEthersSigner, fixture: RedeemerFixture, amount: bigint) {
  const sharesAmount = await lido.getSharesByPooledEth(amount);
  const etherAmount = await lido.getPooledEthByShares(sharesAmount);

  const reserveBefore = await lido.getRedeemsReserve();
  const bufferedBefore = await lido.getBufferedEther();
  const redeemerBalanceBefore = await ethers.provider.getBalance(fixture.address);

  await lido.connect(holder).transfer(fixture.address, amount);
  await fixture.redeemer.callRedeemStETH(amount);

  expect(await lido.getRedeemsReserve()).to.equal(reserveBefore - etherAmount, "reserve mismatch after redeem");
  expect(await lido.getBufferedEther()).to.equal(bufferedBefore - etherAmount, "buffered ether mismatch after redeem");
  expect(await ethers.provider.getBalance(fixture.address)).to.equal(
    redeemerBalanceBefore + etherAmount,
    "redeemer ETH balance mismatch after redeem",
  );
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

/** Funds the EL rewards vault with the given amount */
export async function fundElRewards(ctx: ProtocolContext, amount: bigint) {
  const elVaultAddr = await ctx.contracts.locator.elRewardsVault();
  await updateBalance(elVaultAddr, amount);
}

/** Advances chain time past requestTimestampMargin so pending WQ requests pass the creation-time sanity check */
export async function advancePastRequestTimestampMargin(ctx: ProtocolContext) {
  const { requestTimestampMargin } = await ctx.contracts.oracleReportSanityChecker.getOracleReportLimits();
  await advanceChainTime(requestTimestampMargin + 1n);
}

/** Mines the given number of empty blocks */
export async function mineBlocks(count: number) {
  for (let i = 0; i < count; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

/** Advances time past one full oracle frame without submitting a report */
export async function skipReport(ctx: ProtocolContext) {
  const { slotsPerEpoch, secondsPerSlot } = await ctx.contracts.hashConsensus.getChainConfig();
  const [, epochsPerFrame] = await ctx.contracts.hashConsensus.getFrameConfig();
  const frameSeconds = slotsPerEpoch * secondsPerSlot * epochsPerFrame;
  await advanceChainTime(frameSeconds + 1n);
}

/** Applies an effective CL loss report and asserts that bunker mode becomes active */
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

/** Applies a recovery report and asserts that bunker mode becomes inactive */
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

/** Asserts buffer = reserve + deposits + wq + unreserved */
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

/**
 * Redeem size relative to current reserve:
 * - small:  5% of reserve
 * - huge:  50% of reserve
 * - full: 100% of reserve (share-rounded to be exactly redeemable)
 */
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

/**
 * Simulates insurance application: transfers stETH from `holder` to a dedicated insurance signer
 * (representing the LidoInsuranceFund), then burns it as cover via the Burner.
 * Uses transfer instead of submit to avoid inflating internalEther before the burn is applied.
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

/** Snapshot of protocol state for comparison between scenarios */
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

/** Captures reserve state together with bunker/WQ progress */
async function captureBunkerCheckpoint(ctx: ProtocolContext): Promise<BunkerCheckpoint> {
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

/** Captures bunker state and asserts reserve allocation invariants first */
export async function captureValidatedBunkerCheckpoint(ctx: ProtocolContext): Promise<BunkerCheckpoint> {
  await assertReserveAllocationInvariant(ctx.contracts.lido);
  return await captureBunkerCheckpoint(ctx);
}

/** Creates one WQ request and verifies that unfinalized demand increased by the requested amount */
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

/** Transfers stETH to the redeemer and asserts that bunker mode blocks redemption */
export async function expectRedeemBlockedInBunker(
  ctx: ProtocolContext,
  from: HardhatEthersSigner,
  fixture: RedeemerFixture,
  amount: bigint,
) {
  const { lido } = ctx.contracts;

  await lido.connect(from).transfer(fixture.address, amount);
  await expect(fixture.redeemer.callRedeemStETH(amount)).to.be.revertedWith("BUNKER_MODE");
}

/** Redeems after bunker exit and verifies exact reserve, TPE, and total shares changes */
export async function redeemAfterBunkerExit(
  lido: Lido,
  from: HardhatEthersSigner,
  fixture: RedeemerFixture,
  amount: bigint,
) {
  const reserveBefore = await lido.getRedeemsReserve();
  const totalPooledBefore = await lido.getTotalPooledEther();
  const totalSharesBefore = await lido.getTotalShares();
  const redeemShares = await lido.getSharesByPooledEth(amount);
  const redeemEther = await lido.getPooledEthByShares(redeemShares);

  await redeemExact(lido, from, fixture, amount);

  expect(await lido.getRedeemsReserve()).to.equal(reserveBefore - redeemEther);
  expect(await lido.getTotalPooledEther()).to.equal(totalPooledBefore - redeemEther);
  expect(await lido.getTotalShares()).to.equal(totalSharesBefore - redeemShares);
}

/**
 * Resets the protocol to a near-empty state: all stETH holders drained via the Withdrawal
 * Queue, all requests finalized, CL balance zeroed. A small dust residual (fee shares,
 * rounding artifacts) may remain in the buffer — this is expected and negligible relative
 * to test deposit amounts.
 */
export async function resetProtocolState(ctx: ProtocolContext) {
  const { lido, withdrawalQueue } = ctx.contracts;
  const MIN_WQ_AMOUNT = ether("0.001");
  const MAX_WQ_AMOUNT = ether("1000");

  // Phase 1: discover holders and drain via WQ

  const holderAddrs = await _discoverStETHHolders(ctx);

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

  // Phase 2a: finalize via simulated validator exits

  const savedRebaseLimit = await setMaxPositiveTokenRebase(ctx, LIMITER_PRECISION_BASE);
  const savedLimits = await ctx.contracts.oracleReportSanityChecker.getOracleReportLimits();
  await updateOracleReportLimits(ctx, {
    maxCLBalanceDecreaseBP: 10000n,
    simulatedShareRateDeviationBPLimit: 10000n,
  });

  await resetCLBalanceDecreaseWindow(ctx, { reportBurner: false });

  const withdrawalVaultAddr = await ctx.contracts.locator.withdrawalVault();
  const [clBal, clPending] = await lido.getBalanceStats();
  let remainingCl = clBal + clPending;

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
      reportBurner: false,
      sharesRequestedToBurn: 0n,
    });
  }

  // Phase 2b: drain remaining requests from the buffer

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
        reportBurner: false,
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

async function _discoverStETHHolders(ctx: ProtocolContext): Promise<string[]> {
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
