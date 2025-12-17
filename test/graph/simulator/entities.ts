/**
 * Entity type definitions for Graph Simulator
 *
 * These types mirror the Graph schema entities but use native TypeScript types.
 * All numeric values use bigint to ensure exact matching without precision loss.
 * APR values use number (BigDecimal equivalent).
 *
 * ## V2+ Testing Focus
 *
 * This simulator is designed for V2+ (post-V2 upgrade) testing. The following
 * legacy V1 fields exist in the real Graph schema but are **intentionally omitted**
 * from this simulator as they are not populated for V2+ oracle reports:
 *
 * | Field                     | Purpose                              | Why Omitted                        |
 * | ------------------------- | ------------------------------------ | ---------------------------------- |
 * | `insuranceFee`            | ETH minted to insurance fund         | No insurance fund since V2         |
 * | `insuranceFeeBasisPoints` | Insurance fee as basis points        | No insurance fund since V2         |
 * | `sharesToInsuranceFund`   | Shares minted to insurance fund      | No insurance fund since V2         |
 * | `dust`                    | Rounding dust ETH to treasury        | V2 handles dust differently        |
 * | `dustSharesToTreasury`    | Rounding dust shares to treasury     | V2 handles dust differently        |
 *
 * These fields are initialized to zero in the real Graph but never populated for V2+ reports.
 * If testing V1 scenarios (historical data), these fields would need to be added.
 *
 * Reference: lido-subgraph/schema.graphql - TotalReward, Totals entities
 * Reference: lido-subgraph/src/helpers.ts - _loadTotalRewardEntity(), _loadTotalsEntity()
 */

/**
 * Totals entity representing the current state of the Lido pool
 *
 * This entity is a singleton (id = "") that tracks the total pooled ether and shares.
 * It is updated during oracle reports and other operations that change the pool state.
 *
 * Reference: lido-subgraph/src/helpers.ts _loadTotalsEntity()
 */
export interface TotalsEntity {
  /** Singleton ID (always empty string) */
  id: string;

  /** Total pooled ether in the protocol */
  totalPooledEther: bigint;

  /** Total shares in the protocol */
  totalShares: bigint;
}

/**
 * Create a new Totals entity with default values
 *
 * @returns New TotalsEntity with zero values
 */
export function createTotalsEntity(): TotalsEntity {
  return {
    id: "",
    totalPooledEther: 0n,
    totalShares: 0n,
  };
}

/**
 * TotalReward entity representing rewards data from an oracle report
 *
 * This entity is created by handleETHDistributed when processing a profitable oracle report.
 *
 * ## Legacy Fields Not Included (V1 only)
 *
 * The following fields exist in the real Graph schema but are **not implemented** here:
 * - `insuranceFee`: ETH value minted to insurance fund (no insurance fund since V2)
 * - `insuranceFeeBasisPoints`: Insurance fee as basis points (no insurance fund since V2)
 * - `sharesToInsuranceFund`: Shares minted to insurance fund (no insurance fund since V2)
 * - `dust`: Rounding dust ETH to treasury (V2 handles dust differently)
 * - `dustSharesToTreasury`: Rounding dust shares to treasury (V2 handles dust differently)
 *
 * These would be set to 0 in V2+ oracle reports anyway.
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

// ============================================================================
// Shares Entity
// ============================================================================

/**
 * Shares entity tracking per-holder share balance
 *
 * This entity tracks the share balance for each unique address.
 * Updated on transfers, submissions, and burns.
 *
 * Reference: lido-subgraph/schema.graphql - Shares entity
 * Reference: lido-subgraph/src/helpers.ts _loadSharesEntity()
 */
export interface SharesEntity {
  /** Holder address (lowercase hex string) */
  id: string;

  /** Current share balance */
  shares: bigint;
}

/**
 * Create a new Shares entity with default values
 *
 * @param id - Holder address
 * @returns New SharesEntity with zero shares
 */
export function createSharesEntity(id: string): SharesEntity {
  return {
    id: id.toLowerCase(),
    shares: 0n,
  };
}

// ============================================================================
// LidoTransfer Entity
// ============================================================================

/**
 * LidoTransfer entity representing a stETH transfer event
 *
 * This is an immutable entity created for each Transfer event.
 * Tracks the transfer details including before/after share balances.
 *
 * Reference: lido-subgraph/schema.graphql - LidoTransfer entity
 * Reference: lido-subgraph/src/helpers.ts _loadLidoTransferEntity()
 */
export interface LidoTransferEntity {
  /** Entity ID: txHash-logIndex */
  id: string;

  /** Sender address (0x0 for mints) */
  from: string;

  /** Recipient address (0x0 for burns) */
  to: string;

  /** Transfer value in wei */
  value: bigint;

  /** Shares transferred (from paired TransferShares event) */
  shares: bigint;

  /** Sender's shares before the transfer */
  sharesBeforeDecrease: bigint;

  /** Sender's shares after the transfer */
  sharesAfterDecrease: bigint;

  /** Recipient's shares before the transfer */
  sharesBeforeIncrease: bigint;

  /** Recipient's shares after the transfer */
  sharesAfterIncrease: bigint;

  /** Total pooled ether at time of transfer */
  totalPooledEther: bigint;

  /** Total shares at time of transfer */
  totalShares: bigint;

  /** Sender's balance after transfer: sharesAfterDecrease * totalPooledEther / totalShares */
  balanceAfterDecrease: bigint;

  /** Recipient's balance after transfer: sharesAfterIncrease * totalPooledEther / totalShares */
  balanceAfterIncrease: bigint;

  // ========== Event Metadata ==========

  /** Block number */
  block: bigint;

  /** Block timestamp (Unix seconds) */
  blockTime: bigint;

  /** Transaction hash */
  transactionHash: string;

  /** Transaction index within the block */
  transactionIndex: bigint;

  /** Log index within the transaction */
  logIndex: bigint;
}

/**
 * Create a new LidoTransfer entity with default values
 *
 * @param id - Entity ID (txHash-logIndex)
 * @returns New LidoTransferEntity with zero/empty default values
 */
export function createLidoTransferEntity(id: string): LidoTransferEntity {
  return {
    id,
    from: "",
    to: "",
    value: 0n,
    shares: 0n,
    sharesBeforeDecrease: 0n,
    sharesAfterDecrease: 0n,
    sharesBeforeIncrease: 0n,
    sharesAfterIncrease: 0n,
    totalPooledEther: 0n,
    totalShares: 0n,
    balanceAfterDecrease: 0n,
    balanceAfterIncrease: 0n,
    block: 0n,
    blockTime: 0n,
    transactionHash: "",
    transactionIndex: 0n,
    logIndex: 0n,
  };
}

// ============================================================================
// LidoSubmission Entity
// ============================================================================

/**
 * LidoSubmission entity representing a user stake submission
 *
 * This is an immutable entity created for each Submitted event.
 * Tracks the submission details including pool state before/after.
 *
 * Reference: lido-subgraph/schema.graphql - LidoSubmission entity
 * Reference: lido-subgraph/src/Lido.ts handleSubmitted()
 */
export interface LidoSubmissionEntity {
  /** Entity ID: txHash-logIndex */
  id: string;

  /** Sender address */
  sender: string;

  /** Amount of ETH submitted */
  amount: bigint;

  /** Referral address */
  referral: string;

  /** Shares minted to sender (from paired TransferShares event) */
  shares: bigint;

  /** Sender's shares before submission */
  sharesBefore: bigint;

  /** Sender's shares after submission */
  sharesAfter: bigint;

  /** Total pooled ether before submission */
  totalPooledEtherBefore: bigint;

  /** Total pooled ether after submission */
  totalPooledEtherAfter: bigint;

  /** Total shares before submission */
  totalSharesBefore: bigint;

  /** Total shares after submission */
  totalSharesAfter: bigint;

  /** Sender's balance after submission: sharesAfter * totalPooledEtherAfter / totalSharesAfter */
  balanceAfter: bigint;

  // ========== Event Metadata ==========

  /** Block number */
  block: bigint;

  /** Block timestamp (Unix seconds) */
  blockTime: bigint;

  /** Transaction hash */
  transactionHash: string;

  /** Transaction index within the block */
  transactionIndex: bigint;

  /** Log index within the transaction */
  logIndex: bigint;
}

/**
 * Create a new LidoSubmission entity with default values
 *
 * @param id - Entity ID (txHash-logIndex)
 * @returns New LidoSubmissionEntity with zero/empty default values
 */
export function createLidoSubmissionEntity(id: string): LidoSubmissionEntity {
  return {
    id,
    sender: "",
    amount: 0n,
    referral: "",
    shares: 0n,
    sharesBefore: 0n,
    sharesAfter: 0n,
    totalPooledEtherBefore: 0n,
    totalPooledEtherAfter: 0n,
    totalSharesBefore: 0n,
    totalSharesAfter: 0n,
    balanceAfter: 0n,
    block: 0n,
    blockTime: 0n,
    transactionHash: "",
    transactionIndex: 0n,
    logIndex: 0n,
  };
}

// ============================================================================
// SharesBurn Entity
// ============================================================================

/**
 * SharesBurn entity representing a share burning event
 *
 * This is an immutable entity created for each SharesBurnt event.
 * Occurs during withdrawal finalization.
 *
 * Reference: lido-subgraph/schema.graphql - SharesBurn entity
 * Reference: lido-subgraph/src/Lido.ts handleSharesBurnt()
 */
export interface SharesBurnEntity {
  /** Entity ID: txHash-logIndex */
  id: string;

  /** Account whose shares were burnt */
  account: string;

  /** Token amount before rebase */
  preRebaseTokenAmount: bigint;

  /** Token amount after rebase */
  postRebaseTokenAmount: bigint;

  /** Amount of shares burnt */
  sharesAmount: bigint;
}

/**
 * Create a new SharesBurn entity with default values
 *
 * @param id - Entity ID (txHash-logIndex)
 * @returns New SharesBurnEntity with zero/empty default values
 */
export function createSharesBurnEntity(id: string): SharesBurnEntity {
  return {
    id,
    account: "",
    preRebaseTokenAmount: 0n,
    postRebaseTokenAmount: 0n,
    sharesAmount: 0n,
  };
}
