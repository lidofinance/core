/**
 * Lido event handlers for Graph Simulator
 *
 * Ports the core logic from lido-subgraph/src/Lido.ts:
 * - handleETHDistributed() - Main handler that creates TotalReward entity
 * - _processTokenRebase() - Extracts pool state from TokenRebased event
 *
 * Reference: lido-subgraph/src/Lido.ts lines 477-690
 */

import {
  findEventByName,
  findTransferSharesPairs,
  getEventArg,
  LogDescriptionWithMeta,
  ZERO_ADDRESS,
} from "../../utils/event-extraction";
import { createTotalRewardEntity, TotalRewardEntity } from "../entities";
import { calcAPR_v2, CALCULATION_UNIT } from "../helpers";
import { EntityStore, saveTotalReward } from "../store";

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
}

/**
 * Handle ETHDistributed event - creates TotalReward entity for profitable reports
 *
 * This is the main entry point for processing oracle reports.
 * It looks ahead to find the TokenRebased event and extracts pool state.
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
  // Extract ETHDistributed event params
  const preCLBalance = getEventArg<bigint>(event, "preCLBalance");
  const postCLBalance = getEventArg<bigint>(event, "postCLBalance");
  const withdrawalsWithdrawn = getEventArg<bigint>(event, "withdrawalsWithdrawn");
  const executionLayerRewardsWithdrawn = getEventArg<bigint>(event, "executionLayerRewardsWithdrawn");

  // Find TokenRebased event (look-ahead)
  const tokenRebasedEvent = findEventByName(allLogs, "TokenRebased", event.logIndex);

  if (!tokenRebasedEvent) {
    throw new Error(
      `TokenRebased event not found after ETHDistributed in tx ${ctx.transactionHash} at logIndex ${event.logIndex}`,
    );
  }

  // Check for non-profitable report (LIP-12)
  // Don't mint/distribute any protocol fee on non-profitable oracle report
  // when consensus layer balance delta is zero or negative
  const postCLTotalBalance = postCLBalance + withdrawalsWithdrawn;
  if (postCLTotalBalance <= preCLBalance) {
    return {
      totalReward: null,
      isProfitable: false,
    };
  }

  // Calculate total rewards with fees (same as real graph lines 553-556)
  // totalRewardsWithFees = (postCLBalance + withdrawalsWithdrawn - preCLBalance) + executionLayerRewardsWithdrawn
  const totalRewardsWithFees = postCLTotalBalance - preCLBalance + executionLayerRewardsWithdrawn;

  // Create TotalReward entity
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
  entity.totalRewardsWithFees = totalRewardsWithFees;

  // Process TokenRebased to fill in pool state and fee distribution
  _processTokenRebase(entity, tokenRebasedEvent, allLogs, event.logIndex, ctx.treasuryAddress);

  // Save entity
  saveTotalReward(store, entity);

  return {
    totalReward: entity,
    isProfitable: true,
  };
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
 */
export function _processTokenRebase(
  entity: TotalRewardEntity,
  tokenRebasedEvent: LogDescriptionWithMeta,
  allLogs: LogDescriptionWithMeta[],
  ethDistributedLogIndex: number,
  treasuryAddress: string,
): void {
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
  const sharesMintedAsFees = getEventArg<bigint>(tokenRebasedEvent, "sharesMintedAsFees");
  const timeElapsed = getEventArg<bigint>(tokenRebasedEvent, "timeElapsed");

  // Tier 2 - Pool State
  entity.totalPooledEtherBefore = preTotalEther;
  entity.totalPooledEtherAfter = postTotalEther;
  entity.totalSharesBefore = preTotalShares;
  entity.totalSharesAfter = postTotalShares;
  entity.shares2mint = sharesMintedAsFees;
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
