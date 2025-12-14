/**
 * Entity type definitions for Graph Simulator
 *
 * These types mirror the Graph schema entities but use native TypeScript types.
 * All numeric values use bigint to ensure exact matching without precision loss.
 * APR values use number (BigDecimal equivalent).
 *
 * Reference: lido-subgraph/schema.graphql - TotalReward entity
 * Reference: lido-subgraph/src/helpers.ts - _loadTotalRewardEntity()
 */

/**
 * TotalReward entity representing rewards data from an oracle report
 *
 * This entity is created by handleETHDistributed when processing a profitable oracle report.
 */
export interface TotalRewardEntity {
  // ========== Tier 1 - Direct Event Metadata ==========
  // These fields come directly from the transaction receipt

  /** Transaction hash - serves as entity ID */
  id: string;

  /** Block number where the oracle report was processed */
  block: bigint;

  /** Block timestamp (Unix seconds) */
  blockTime: bigint;

  /** Transaction hash (same as id) */
  transactionHash: string;

  /** Transaction index within the block */
  transactionIndex: bigint;

  /** Log index of the ETHDistributed event */
  logIndex: bigint;

  // ========== Tier 2 - Pool State ==========
  // These fields come from TokenRebased event params

  /** Total pooled ether before the rebase (from TokenRebased.preTotalEther) */
  totalPooledEtherBefore: bigint;

  /** Total pooled ether after the rebase (from TokenRebased.postTotalEther) */
  totalPooledEtherAfter: bigint;

  /** Total shares before the rebase (from TokenRebased.preTotalShares) */
  totalSharesBefore: bigint;

  /** Total shares after the rebase (from TokenRebased.postTotalShares) */
  totalSharesAfter: bigint;

  /** Shares minted as fees (from TokenRebased.sharesMintedAsFees) */
  shares2mint: bigint;

  /** Time elapsed since last oracle report in seconds (from TokenRebased.timeElapsed) */
  timeElapsed: bigint;

  /** MEV/execution layer rewards withdrawn (from ETHDistributed.executionLayerRewardsWithdrawn) */
  mevFee: bigint;

  // ========== Tier 2 - Fee Distribution ==========
  // These fields track fee distribution from Transfer/TransferShares events

  /** Total rewards including fees (CL balance delta + EL rewards) */
  totalRewardsWithFees: bigint;

  /** Total user rewards after fee deduction */
  totalRewards: bigint;

  /** Total protocol fee (treasuryFee + operatorsFee) */
  totalFee: bigint;

  /** ETH value minted to treasury */
  treasuryFee: bigint;

  /** ETH value minted to staking router modules (operators) */
  operatorsFee: bigint;

  /** Shares minted to treasury */
  sharesToTreasury: bigint;

  /** Shares minted to staking router modules (operators) */
  sharesToOperators: bigint;

  // ========== Tier 3 - Calculated Fields ==========

  /**
   * User APR after fees and time correction (BigDecimal in Graph schema)
   * Calculated from share rate change annualized
   */
  apr: number;

  /** Raw APR (same as apr in v2) */
  aprRaw: number;

  /** APR before fees (same as apr in v2) */
  aprBeforeFees: number;

  /** Fee basis points: totalFee * 10000 / totalRewardsWithFees */
  feeBasis: bigint;

  /** Treasury fee as fraction of total fee: treasuryFee * 10000 / totalFee */
  treasuryFeeBasisPoints: bigint;

  /** Operators fee as fraction of total fee: operatorsFee * 10000 / totalFee */
  operatorsFeeBasisPoints: bigint;
}

/**
 * Create a new TotalReward entity with default values
 *
 * @param id - Transaction hash to use as entity ID
 * @returns New TotalRewardEntity with zero/empty default values
 */
export function createTotalRewardEntity(id: string): TotalRewardEntity {
  return {
    // Tier 1
    id,
    block: 0n,
    blockTime: 0n,
    transactionHash: id,
    transactionIndex: 0n,
    logIndex: 0n,

    // Tier 2 - Pool State
    totalPooledEtherBefore: 0n,
    totalPooledEtherAfter: 0n,
    totalSharesBefore: 0n,
    totalSharesAfter: 0n,
    shares2mint: 0n,
    timeElapsed: 0n,
    mevFee: 0n,

    // Tier 2 - Fee Distribution
    totalRewardsWithFees: 0n,
    totalRewards: 0n,
    totalFee: 0n,
    treasuryFee: 0n,
    operatorsFee: 0n,
    sharesToTreasury: 0n,
    sharesToOperators: 0n,

    // Tier 3
    apr: 0,
    aprRaw: 0,
    aprBeforeFees: 0,
    feeBasis: 0n,
    treasuryFeeBasisPoints: 0n,
    operatorsFeeBasisPoints: 0n,
  };
}
