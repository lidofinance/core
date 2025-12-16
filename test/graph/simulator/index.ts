/**
 * Graph Simulator - Main Entry Point
 *
 * This module provides the main interface for simulating Graph indexer behavior.
 * It processes transaction events and produces entities that should match
 * what the actual Graph indexer would produce.
 *
 * Usage:
 * ```typescript
 * const store = createEntityStore();
 * const result = processTransaction(receipt, ctx, store);
 * const totalReward = result.totalRewards.get(receipt.hash);
 * ```
 *
 * Reference: graph-tests-spec.md
 */

import { ContractTransactionReceipt } from "ethers";

import { ProtocolContext } from "lib/protocol";

import { extractAllLogs, findTransferSharesPairs, ZERO_ADDRESS } from "../utils/event-extraction";

import { TotalRewardEntity, TotalsEntity } from "./entities";
import { HandlerContext, processTransactionEvents, ProcessTransactionResult } from "./handlers";
import { calcAPR_v2, CALCULATION_UNIT } from "./helpers";
import {
  countTotalRewards,
  getLatestTotalReward,
  getTotalRewardById,
  getTotalRewardsInBlockRange,
  queryTotalRewards,
  TotalRewardsQueryParamsExtended,
  TotalRewardsQueryResult,
} from "./query";
import { createEntityStore, EntityStore, loadTotalsEntity, saveTotals } from "./store";

// Re-export types and utilities
export { TotalRewardEntity, createTotalRewardEntity, TotalsEntity, createTotalsEntity } from "./entities";
export { EntityStore, createEntityStore, getTotalReward, saveTotalReward, loadTotalsEntity, saveTotals } from "./store";
export { SimulatorInitialState, PoolState, captureChainState, capturePoolState } from "../utils/state-capture";
export { ProcessTransactionResult, ValidationWarning, SharesBurntResult } from "./handlers";

// Re-export query types and functions
export {
  queryTotalRewards,
  getTotalRewardById,
  countTotalRewards,
  getLatestTotalReward,
  getTotalRewardsInBlockRange,
  TotalRewardsQueryParams,
  TotalRewardsQueryParamsExtended,
  TotalRewardsQueryResult,
} from "./query";

// Re-export helper functions and types for testing
export {
  calcAPR_v2,
  calcAPR_v2Extended,
  CALCULATION_UNIT,
  E27_PRECISION_BASE,
  SECONDS_PER_YEAR,
  MAX_APR_SCALED,
  MIN_SHARE_RATE,
  APRResult,
  APREdgeCase,
} from "./helpers";

/**
 * Process a transaction's events through the Graph simulator
 *
 * This is the main entry point for the simulator. It extracts all events
 * from the transaction receipt, processes them through the appropriate
 * handlers, and returns the resulting entities.
 *
 * @param receipt - Transaction receipt containing events
 * @param ctx - Protocol context with contract interfaces
 * @param store - Entity store for persistence (entities are saved here)
 * @param blockTimestamp - Block timestamp (optional, defaults to current time)
 * @param treasuryAddress - Treasury address for fee categorization (required for fee tracking)
 * @returns Processing result with created/updated entities
 */
export function processTransaction(
  receipt: ContractTransactionReceipt,
  ctx: ProtocolContext,
  store: EntityStore,
  blockTimestamp?: bigint,
  treasuryAddress?: string,
): ProcessTransactionResult {
  // Extract all parseable logs from the transaction
  const logs = extractAllLogs(receipt, ctx);

  // Build handler context from receipt
  const handlerCtx: HandlerContext = {
    blockNumber: BigInt(receipt.blockNumber),
    blockTimestamp: blockTimestamp ?? BigInt(Math.floor(Date.now() / 1000)),
    transactionHash: receipt.hash,
    transactionIndex: receipt.index,
    treasuryAddress: treasuryAddress ?? "",
  };

  // Process events through handlers
  return processTransactionEvents(logs, store, handlerCtx);
}

/**
 * GraphSimulator class for stateful simulation
 *
 * This class wraps the simulator functionality with persistent state,
 * useful for scenario tests where state persists across multiple transactions.
 */
export class GraphSimulator {
  private store: EntityStore;
  private treasuryAddress: string;

  constructor(treasuryAddress: string = "") {
    this.store = createEntityStore();
    this.treasuryAddress = treasuryAddress;
  }

  /**
   * Set the treasury address for fee categorization
   *
   * @param address - Treasury address
   */
  setTreasuryAddress(address: string): void {
    this.treasuryAddress = address;
  }

  /**
   * Get the treasury address
   *
   * @returns Treasury address
   */
  getTreasuryAddress(): string {
    return this.treasuryAddress;
  }

  /**
   * Process a transaction and return the result
   *
   * @param receipt - Transaction receipt
   * @param ctx - Protocol context
   * @param blockTimestamp - Optional block timestamp
   * @returns Processing result
   */
  processTransaction(
    receipt: ContractTransactionReceipt,
    ctx: ProtocolContext,
    blockTimestamp?: bigint,
  ): ProcessTransactionResult {
    return processTransaction(receipt, ctx, this.store, blockTimestamp, this.treasuryAddress);
  }

  /**
   * Get a TotalReward entity by transaction hash
   *
   * @param txHash - Transaction hash
   * @returns The entity if found
   */
  getTotalReward(txHash: string): TotalRewardEntity | undefined {
    return this.store.totalRewards.get(txHash.toLowerCase());
  }

  /**
   * Get the underlying store for advanced operations
   */
  getStore(): EntityStore {
    return this.store;
  }

  /**
   * Clear all stored entities
   */
  reset(): void {
    this.store = createEntityStore();
  }

  // ========== Totals Entity Methods ==========

  /**
   * Get the current Totals entity
   *
   * @returns The Totals entity or null if not initialized
   */
  getTotals(): TotalsEntity | null {
    return this.store.totals;
  }

  /**
   * Initialize Totals entity with values from chain state
   *
   * This should be called at test setup to initialize the simulator
   * with the current chain state before processing transactions.
   *
   * @param totalPooledEther - Total pooled ether from lido.getTotalPooledEther()
   * @param totalShares - Total shares from lido.getTotalShares()
   */
  initializeTotals(totalPooledEther: bigint, totalShares: bigint): void {
    const totals = loadTotalsEntity(this.store, true)!;
    totals.totalPooledEther = totalPooledEther;
    totals.totalShares = totalShares;
    saveTotals(this.store, totals);
  }

  // ========== Query Methods ==========

  /**
   * Query TotalRewards with filtering, ordering, and pagination
   *
   * Mimics the GraphQL query:
   * ```graphql
   * query TotalRewards($skip: Int!, $limit: Int!, $block_from: BigInt!) {
   *   totalRewards(
   *     skip: $skip
   *     first: $limit
   *     where: { block_gt: $block_from }
   *     orderBy: blockTime
   *     orderDirection: asc
   *   ) { ... }
   * }
   * ```
   *
   * @param params - Query parameters (skip, limit, blockFrom, orderBy, orderDirection)
   * @returns Array of matching TotalReward results
   */
  queryTotalRewards(params: TotalRewardsQueryParamsExtended): TotalRewardsQueryResult[] {
    return queryTotalRewards(this.store, params);
  }

  /**
   * Get a TotalReward by ID
   *
   * @param id - Transaction hash
   * @returns The entity if found, null otherwise
   */
  getTotalRewardById(id: string): TotalRewardEntity | null {
    return getTotalRewardById(this.store, id);
  }

  /**
   * Count TotalRewards matching filter criteria
   *
   * @param blockFrom - Only count entities where block > blockFrom
   * @returns Count of matching entities
   */
  countTotalRewards(blockFrom: bigint = 0n): number {
    return countTotalRewards(this.store, blockFrom);
  }

  /**
   * Get the most recent TotalReward by block time
   *
   * @returns The latest entity or null if store is empty
   */
  getLatestTotalReward(): TotalRewardEntity | null {
    return getLatestTotalReward(this.store);
  }

  /**
   * Get TotalRewards within a block range
   *
   * @param fromBlock - Start block (inclusive)
   * @param toBlock - End block (inclusive)
   * @returns Array of entities within the range
   */
  getTotalRewardsInBlockRange(fromBlock: bigint, toBlock: bigint): TotalRewardEntity[] {
    return getTotalRewardsInBlockRange(this.store, fromBlock, toBlock);
  }
}

/**
 * Derive expected TotalReward field values from on-chain data
 *
 * This helper computes what the TotalReward fields should be based on
 * the events in the transaction. Used for test verification.
 *
 * @param receipt - Transaction receipt
 * @param ctx - Protocol context
 * @param treasuryAddress - Treasury address for fee categorization (optional)
 * @returns Expected TotalReward entity or null if non-profitable
 */
export function deriveExpectedTotalReward(
  receipt: ContractTransactionReceipt,
  ctx: ProtocolContext,
  treasuryAddress?: string,
): TotalRewardEntity | null {
  const logs = extractAllLogs(receipt, ctx);

  // Find ETHDistributed event
  const ethDistributedEvent = logs.find((log) => log.name === "ETHDistributed");
  if (!ethDistributedEvent) {
    return null;
  }

  // Find TokenRebased event
  const tokenRebasedEvent = logs.find((log) => log.name === "TokenRebased");
  if (!tokenRebasedEvent) {
    return null;
  }

  // Check profitability
  const preCLBalance = ethDistributedEvent.args["preCLBalance"] as bigint;
  const postCLBalance = ethDistributedEvent.args["postCLBalance"] as bigint;
  const withdrawalsWithdrawn = ethDistributedEvent.args["withdrawalsWithdrawn"] as bigint;
  const executionLayerRewardsWithdrawn = ethDistributedEvent.args["executionLayerRewardsWithdrawn"] as bigint;

  const postCLTotalBalance = postCLBalance + withdrawalsWithdrawn;
  if (postCLTotalBalance <= preCLBalance) {
    return null; // Non-profitable
  }

  // Calculate total rewards with fees
  const totalRewardsWithFees = postCLTotalBalance - preCLBalance + executionLayerRewardsWithdrawn;

  // Extract TokenRebased params
  const preTotalEther = tokenRebasedEvent.args["preTotalEther"] as bigint;
  const postTotalEther = tokenRebasedEvent.args["postTotalEther"] as bigint;
  const preTotalShares = tokenRebasedEvent.args["preTotalShares"] as bigint;
  const postTotalShares = tokenRebasedEvent.args["postTotalShares"] as bigint;
  const timeElapsed = tokenRebasedEvent.args["timeElapsed"] as bigint;
  const sharesMintedAsFees = tokenRebasedEvent.args["sharesMintedAsFees"] as bigint;

  // Calculate APR
  const apr = calcAPR_v2(preTotalEther, postTotalEther, preTotalShares, postTotalShares, timeElapsed);

  // ========== Fee Distribution Tracking ==========
  // Extract Transfer/TransferShares pairs between ETHDistributed and TokenRebased
  const transferPairs = findTransferSharesPairs(logs, ethDistributedEvent.logIndex, tokenRebasedEvent.logIndex);

  // Process mint events and categorize by destination
  let sharesToTreasury = 0n;
  let sharesToOperators = 0n;
  let treasuryFee = 0n;
  let operatorsFee = 0n;

  const treasuryAddressLower = (treasuryAddress ?? "").toLowerCase();

  for (const pair of transferPairs) {
    // Only process mint events (from = ZERO_ADDRESS)
    if (pair.transfer.from.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      if (treasuryAddressLower && pair.transfer.to.toLowerCase() === treasuryAddressLower) {
        // Mint to treasury
        sharesToTreasury += pair.transferShares.sharesValue;
        treasuryFee += pair.transfer.value;
      } else {
        // Mint to staking router module (operators)
        sharesToOperators += pair.transferShares.sharesValue;
        operatorsFee += pair.transfer.value;
      }
    }
  }

  const totalFee = treasuryFee + operatorsFee;
  const totalRewards = totalRewardsWithFees - totalFee;

  // Calculate basis points
  const feeBasis = totalRewardsWithFees > 0n ? (totalFee * CALCULATION_UNIT) / totalRewardsWithFees : 0n;
  const treasuryFeeBasisPoints = totalFee > 0n ? (treasuryFee * CALCULATION_UNIT) / totalFee : 0n;
  const operatorsFeeBasisPoints = totalFee > 0n ? (operatorsFee * CALCULATION_UNIT) / totalFee : 0n;

  // Build expected entity from events
  const expected: TotalRewardEntity = {
    // Tier 1 - from receipt
    id: receipt.hash,
    block: BigInt(receipt.blockNumber),
    blockTime: 0n, // Will be set from block
    transactionHash: receipt.hash,
    transactionIndex: BigInt(receipt.index),
    logIndex: BigInt(ethDistributedEvent.logIndex),

    // Tier 2 - Pool State from TokenRebased
    totalPooledEtherBefore: preTotalEther,
    totalPooledEtherAfter: postTotalEther,
    totalSharesBefore: preTotalShares,
    totalSharesAfter: postTotalShares,
    shares2mint: sharesMintedAsFees,
    timeElapsed,

    // Tier 2 - from ETHDistributed
    mevFee: executionLayerRewardsWithdrawn,

    // Tier 2 - Fee Distribution
    totalRewardsWithFees,
    totalRewards,
    totalFee,
    treasuryFee,
    operatorsFee,
    sharesToTreasury,
    sharesToOperators,

    // Tier 3 - calculated
    apr,
    aprRaw: apr,
    aprBeforeFees: apr,
    feeBasis,
    treasuryFeeBasisPoints,
    operatorsFeeBasisPoints,
  };

  return expected;
}
