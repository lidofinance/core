/**
 * Lido event handlers for Graph Simulator
 *
 * Ports the core logic from lido-subgraph/src/Lido.ts:
 * - handleETHDistributed() - Main handler that creates TotalReward entity and updates Totals
 * - handleSharesBurnt() - Handles SharesBurnt events during withdrawal finalization
 * - _processTokenRebase() - Extracts pool state from TokenRebased event
 *
 * Reference: lido-subgraph/src/Lido.ts lines 477-690
 */

import {
  findAllEventsByName,
  findEventByName,
  findTransferSharesPairs,
  getEventArg,
  LogDescriptionWithMeta,
  ZERO_ADDRESS,
} from "../../utils/event-extraction";
import { createTotalRewardEntity, TotalRewardEntity, TotalsEntity } from "../entities";
import { calcAPR_v2, CALCULATION_UNIT } from "../helpers";
import { EntityStore, loadTotalsEntity, saveTotalReward, saveTotals } from "../store";

/**
 * Context passed to handlers containing transaction metadata
 */
export interface HandlerContext {
  /** Block number */
  blockNumber: bigint;

  /** Block timestamp */
  blockTimestamp: bigint;

  /** Transaction hash */
  transactionHash: string;

  /** Transaction index */
  transactionIndex: number;

  /** Treasury address for fee categorization */
  treasuryAddress: string;
}

/**
 * Result of processing an ETHDistributed event
 */
export interface ETHDistributedResult {
  /** The created TotalReward entity, or null if report was non-profitable */
  totalReward: TotalRewardEntity | null;

  /** Whether the report was profitable (entity was created) */
  isProfitable: boolean;

  /** The updated Totals entity (always updated, even for non-profitable reports) */
  totals: TotalsEntity;

  /** Any validation warnings encountered during processing */
  warnings: ValidationWarning[];
}

/**
 * Result of processing a SharesBurnt event
 */
export interface SharesBurntResult {
  /** Amount of shares burnt */
  sharesBurnt: bigint;

  /** Account whose shares were burnt */
  account: string;

  /** Pre-rebase token amount */
  preRebaseTokenAmount: bigint;

  /** Post-rebase token amount */
  postRebaseTokenAmount: bigint;

  /** The updated Totals entity */
  totals: TotalsEntity;
}

/**
 * Validation warning types for sanity checks
 */
export type ValidationWarningType = "shares2mint_mismatch" | "totals_state_mismatch";

/**
 * Validation warning issued during event processing
 */
export interface ValidationWarning {
  type: ValidationWarningType;
  message: string;
  expected?: bigint;
  actual?: bigint;
}

/**
 * Handle ETHDistributed event - creates TotalReward entity for profitable reports
 *
 * This is the main entry point for processing oracle reports.
 * It looks ahead to find the TokenRebased event and extracts pool state.
 *
 * IMPORTANT: This handler also updates the Totals entity to match the real graph behavior:
 * 1. Update totalPooledEther to postTotalEther (before SharesBurnt handling)
 * 2. Handle SharesBurnt if present (decreases totalShares) during withdrawal finalization
 * 3. Update totalShares to postTotalShares (after SharesBurnt handling)
 *
 * Reference: lido-subgraph/src/Lido.ts handleETHDistributed() lines 477-571
 *
 * @param event - The ETHDistributed event
 * @param allLogs - All parsed logs from the transaction (for look-ahead)
 * @param store - Entity store
 * @param ctx - Handler context with transaction metadata
 * @returns Result containing the created entity or null for non-profitable reports
 */
export function handleETHDistributed(
  event: LogDescriptionWithMeta,
  allLogs: LogDescriptionWithMeta[],
  store: EntityStore,
  ctx: HandlerContext,
): ETHDistributedResult {
  const warnings: ValidationWarning[] = [];

  // Extract ETHDistributed event params
  const preCLBalance = getEventArg<bigint>(event, "preCLBalance");
  const postCLBalance = getEventArg<bigint>(event, "postCLBalance");
  const withdrawalsWithdrawn = getEventArg<bigint>(event, "withdrawalsWithdrawn");
  const executionLayerRewardsWithdrawn = getEventArg<bigint>(event, "executionLayerRewardsWithdrawn");

  // Find TokenRebased event (look-ahead)
  // Reference: lido-subgraph/src/Lido.ts lines 487-502
  const tokenRebasedEvent = findEventByName(allLogs, "TokenRebased", event.logIndex);

  if (!tokenRebasedEvent) {
    throw new Error(
      `TokenRebased event not found after ETHDistributed in tx ${ctx.transactionHash} at logIndex ${event.logIndex}`,
    );
  }

  // Extract TokenRebased params for Totals update
  const preTotalEther = getEventArg<bigint>(tokenRebasedEvent, "preTotalEther");
  const postTotalEther = getEventArg<bigint>(tokenRebasedEvent, "postTotalEther");
  const preTotalShares = getEventArg<bigint>(tokenRebasedEvent, "preTotalShares");
  const postTotalShares = getEventArg<bigint>(tokenRebasedEvent, "postTotalShares");
  const sharesMintedAsFees = getEventArg<bigint>(tokenRebasedEvent, "sharesMintedAsFees");

  // ========== Update Totals Entity ==========
  // Reference: lido-subgraph/src/Lido.ts lines 504-540

  // Load Totals entity (should already exist on oracle report)
  const totals = loadTotalsEntity(store, true)!;

  // ========== Totals State Validation (Sanity Check) ==========
  // In real graph, there are assertions here - we convert to warnings
  // Reference: lido-subgraph/src/Lido.ts lines 509-513
  if (totals.totalPooledEther !== 0n && totals.totalPooledEther !== preTotalEther) {
    warnings.push({
      type: "totals_state_mismatch",
      message: `Totals.totalPooledEther mismatch: expected ${preTotalEther}, got ${totals.totalPooledEther}`,
      expected: preTotalEther,
      actual: totals.totalPooledEther,
    });
  }
  if (totals.totalShares !== 0n && totals.totalShares !== preTotalShares) {
    warnings.push({
      type: "totals_state_mismatch",
      message: `Totals.totalShares mismatch: expected ${preTotalShares}, got ${totals.totalShares}`,
      expected: preTotalShares,
      actual: totals.totalShares,
    });
  }

  // Step 1: Update totalPooledEther for correct SharesBurnt handling
  // Reference: lido-subgraph/src/Lido.ts lines 515-517
  totals.totalPooledEther = postTotalEther;
  saveTotals(store, totals);

  // Step 2: Handle SharesBurnt if present (for withdrawal finalization)
  // Reference: lido-subgraph/src/Lido.ts lines 521-535
  // Find all SharesBurnt events between ETHDistributed and TokenRebased
  const sharesBurntEvents = findAllEventsByName(allLogs, "SharesBurnt", event.logIndex, tokenRebasedEvent.logIndex);

  for (const sharesBurntEvent of sharesBurntEvents) {
    handleSharesBurnt(sharesBurntEvent, store);
  }

  // Step 3: Update totalShares for next mint transfers
  // Reference: lido-subgraph/src/Lido.ts lines 537-540
  totals.totalShares = postTotalShares;
  saveTotals(store, totals);

  // ========== Non-Profitable Report Check (LIP-12) ==========
  // Reference: lido-subgraph/src/Lido.ts lines 542-551
  // Don't mint/distribute any protocol fee on non-profitable oracle report
  // when consensus layer balance delta is zero or negative
  const postCLTotalBalance = postCLBalance + withdrawalsWithdrawn;
  if (postCLTotalBalance <= preCLBalance) {
    // Note: Totals are still updated even for non-profitable reports!
    return {
      totalReward: null,
      isProfitable: false,
      totals,
      warnings,
    };
  }

  // ========== Create TotalReward Entity ==========
  // Reference: lido-subgraph/src/Lido.ts lines 553-570

  // Calculate total rewards with fees (same as real graph lines 553-556)
  // totalRewardsWithFees = (postCLBalance + withdrawalsWithdrawn - preCLBalance) + executionLayerRewardsWithdrawn
  const totalRewardsWithFees = postCLTotalBalance - preCLBalance + executionLayerRewardsWithdrawn;

  // Create TotalReward entity
  // Reference: lido-subgraph/src/helpers.ts _loadTotalRewardEntity()
  const entity = createTotalRewardEntity(ctx.transactionHash);

  // Tier 1 - Direct Event Metadata
  entity.block = ctx.blockNumber;
  entity.blockTime = ctx.blockTimestamp;
  entity.transactionHash = ctx.transactionHash;
  entity.transactionIndex = BigInt(ctx.transactionIndex);
  entity.logIndex = BigInt(event.logIndex);

  // Tier 2 - MEV fee from ETHDistributed
  entity.mevFee = executionLayerRewardsWithdrawn;

  // Tier 2 - Total rewards with fees
  // Reference: lido-subgraph/src/Lido.ts lines 559-561
  // In real graph: totalRewardsEntity.totalRewards = totalRewards (initially same as totalRewardsWithFees)
  //               totalRewardsEntity.totalRewardsWithFees = totalRewardsEntity.totalRewards
  entity.totalRewardsWithFees = totalRewardsWithFees;

  // Process TokenRebased to fill in pool state and fee distribution
  // This will also set entity.totalRewards = totalRewardsWithFees - totalFee
  const rebaseWarnings = _processTokenRebase(
    entity,
    tokenRebasedEvent,
    allLogs,
    event.logIndex,
    ctx.treasuryAddress,
    sharesMintedAsFees,
  );
  warnings.push(...rebaseWarnings);

  // Save entity
  saveTotalReward(store, entity);

  return {
    totalReward: entity,
    isProfitable: true,
    totals,
    warnings,
  };
}

/**
 * Handle SharesBurnt event - updates Totals when shares are burnt during withdrawal finalization
 *
 * This is called from handleETHDistributed when SharesBurnt events are found
 * between ETHDistributed and TokenRebased events.
 *
 * Reference: lido-subgraph/src/Lido.ts handleSharesBurnt() lines 444-476
 *
 * @param event - The SharesBurnt event
 * @param store - Entity store
 * @returns Result containing the burnt shares details and updated Totals
 */
export function handleSharesBurnt(event: LogDescriptionWithMeta, store: EntityStore): SharesBurntResult {
  // Extract SharesBurnt event params
  // event SharesBurnt(address indexed account, uint256 preRebaseTokenAmount, uint256 postRebaseTokenAmount, uint256 sharesAmount)
  const account = getEventArg<string>(event, "account");
  const preRebaseTokenAmount = getEventArg<bigint>(event, "preRebaseTokenAmount");
  const postRebaseTokenAmount = getEventArg<bigint>(event, "postRebaseTokenAmount");
  const sharesAmount = getEventArg<bigint>(event, "sharesAmount");

  // Load Totals entity
  const totals = loadTotalsEntity(store, true)!;

  // Update totalShares by subtracting burnt shares
  // Reference: lido-subgraph/src/Lido.ts lines 460-463
  totals.totalShares = totals.totalShares - sharesAmount;
  saveTotals(store, totals);

  return {
    sharesBurnt: sharesAmount,
    account,
    preRebaseTokenAmount,
    postRebaseTokenAmount,
    totals,
  };
}

/**
 * Check if an event is a SharesBurnt event
 *
 * @param event - The event to check
 * @returns true if this is a SharesBurnt event
 */
export function isSharesBurntEvent(event: LogDescriptionWithMeta): boolean {
  return event.name === "SharesBurnt";
}

/**
 * Process TokenRebased event to extract pool state fields, fee distribution, and calculate APR
 *
 * This is called from handleETHDistributed after look-ahead finds the event.
 *
 * Reference: lido-subgraph/src/Lido.ts _processTokenRebase() lines 573-690
 *
 * @param entity - TotalReward entity to populate
 * @param tokenRebasedEvent - The TokenRebased event
 * @param allLogs - All parsed logs from the transaction (for Transfer/TransferShares extraction)
 * @param ethDistributedLogIndex - Log index of the ETHDistributed event
 * @param treasuryAddress - Treasury address for fee categorization
 * @param sharesMintedAsFees - Expected shares minted as fees from TokenRebased (for validation)
 * @returns Array of validation warnings encountered during processing
 */
export function _processTokenRebase(
  entity: TotalRewardEntity,
  tokenRebasedEvent: LogDescriptionWithMeta,
  allLogs: LogDescriptionWithMeta[],
  ethDistributedLogIndex: number,
  treasuryAddress: string,
  sharesMintedAsFees?: bigint,
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  // Extract TokenRebased event params
  // event TokenRebased(
  //   uint256 indexed reportTimestamp,
  //   uint256 timeElapsed,
  //   uint256 preTotalShares,
  //   uint256 preTotalEther,
  //   uint256 postTotalShares,
  //   uint256 postTotalEther,
  //   uint256 sharesMintedAsFees
  // )

  const preTotalEther = getEventArg<bigint>(tokenRebasedEvent, "preTotalEther");
  const postTotalEther = getEventArg<bigint>(tokenRebasedEvent, "postTotalEther");
  const preTotalShares = getEventArg<bigint>(tokenRebasedEvent, "preTotalShares");
  const postTotalShares = getEventArg<bigint>(tokenRebasedEvent, "postTotalShares");
  const sharesMintedAsFeesFromEvent = getEventArg<bigint>(tokenRebasedEvent, "sharesMintedAsFees");
  const timeElapsed = getEventArg<bigint>(tokenRebasedEvent, "timeElapsed");

  // Tier 2 - Pool State
  entity.totalPooledEtherBefore = preTotalEther;
  entity.totalPooledEtherAfter = postTotalEther;
  entity.totalSharesBefore = preTotalShares;
  entity.totalSharesAfter = postTotalShares;
  entity.shares2mint = sharesMintedAsFeesFromEvent;
  entity.timeElapsed = timeElapsed;

  // ========== Fee Distribution Tracking ==========
  // Reference: lido-subgraph/src/Lido.ts lines 586-662

  // Extract Transfer/TransferShares pairs between ETHDistributed and TokenRebased
  const transferPairs = findTransferSharesPairs(allLogs, ethDistributedLogIndex, tokenRebasedEvent.logIndex);

  // Process mint events and categorize by destination
  let sharesToTreasury = 0n;
  let sharesToOperators = 0n;
  let treasuryFee = 0n;
  let operatorsFee = 0n;

  const treasuryAddressLower = treasuryAddress.toLowerCase();

  for (const pair of transferPairs) {
    // Only process mint events (from = ZERO_ADDRESS)
    if (pair.transfer.from.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      if (pair.transfer.to.toLowerCase() === treasuryAddressLower) {
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

  // Set fee distribution fields
  entity.sharesToTreasury = sharesToTreasury;
  entity.sharesToOperators = sharesToOperators;
  entity.treasuryFee = treasuryFee;
  entity.operatorsFee = operatorsFee;
  entity.totalFee = treasuryFee + operatorsFee;
  entity.totalRewards = entity.totalRewardsWithFees - entity.totalFee;

  // ========== shares2mint Validation (Sanity Check) ==========
  // Reference: lido-subgraph/src/Lido.ts lines 664-667
  // In the real graph, there's a critical log if shares2mint != sharesToTreasury + sharesToOperators
  const totalSharesMinted = sharesToTreasury + sharesToOperators;
  if (sharesMintedAsFeesFromEvent !== totalSharesMinted) {
    warnings.push({
      type: "shares2mint_mismatch",
      message:
        `shares2mint mismatch: TokenRebased.sharesMintedAsFees (${sharesMintedAsFeesFromEvent}) != ` +
        `sharesToTreasury + sharesToOperators (${totalSharesMinted})`,
      expected: sharesMintedAsFeesFromEvent,
      actual: totalSharesMinted,
    });
  }

  // Also validate against the passed sharesMintedAsFees if provided
  if (sharesMintedAsFees !== undefined && sharesMintedAsFees !== sharesMintedAsFeesFromEvent) {
    warnings.push({
      type: "shares2mint_mismatch",
      message: `shares2mint event param inconsistency: passed ${sharesMintedAsFees} vs event ${sharesMintedAsFeesFromEvent}`,
      expected: sharesMintedAsFees,
      actual: sharesMintedAsFeesFromEvent,
    });
  }

  // ========== Calculate Basis Points ==========
  // Reference: lido-subgraph/src/Lido.ts lines 669-677

  // feeBasis = totalFee * 10000 / totalRewardsWithFees
  entity.feeBasis =
    entity.totalRewardsWithFees > 0n ? (entity.totalFee * CALCULATION_UNIT) / entity.totalRewardsWithFees : 0n;

  // treasuryFeeBasisPoints = treasuryFee * 10000 / totalFee
  entity.treasuryFeeBasisPoints = entity.totalFee > 0n ? (treasuryFee * CALCULATION_UNIT) / entity.totalFee : 0n;

  // operatorsFeeBasisPoints = operatorsFee * 10000 / totalFee
  entity.operatorsFeeBasisPoints = entity.totalFee > 0n ? (operatorsFee * CALCULATION_UNIT) / entity.totalFee : 0n;

  // ========== Calculate APR ==========
  // Reference: lido-subgraph/src/helpers.ts _calcAPR_v2()
  entity.apr = calcAPR_v2(preTotalEther, postTotalEther, preTotalShares, postTotalShares, timeElapsed);

  // In v2, aprRaw and aprBeforeFees are the same as apr
  entity.aprRaw = entity.apr;
  entity.aprBeforeFees = entity.apr;

  return warnings;
}

/**
 * Check if an event is an ETHDistributed event
 *
 * @param event - The event to check
 * @returns true if this is an ETHDistributed event
 */
export function isETHDistributedEvent(event: LogDescriptionWithMeta): boolean {
  return event.name === "ETHDistributed";
}
