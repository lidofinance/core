/**
 * Handler registry for Graph Simulator
 *
 * Maps event names to their handler functions and coordinates
 * event processing across all handlers.
 */

import { LogDescriptionWithMeta } from "../../utils/event-extraction";
import { TotalRewardEntity } from "../entities";
import { EntityStore } from "../store";

import { handleETHDistributed, HandlerContext, isETHDistributedEvent } from "./lido";

// Re-export for convenience
export { HandlerContext } from "./lido";

/**
 * Result of processing a transaction's events
 */
export interface ProcessTransactionResult {
  /** TotalReward entities created/updated (keyed by tx hash) */
  totalRewards: Map<string, TotalRewardEntity>;

  /** Number of events processed */
  eventsProcessed: number;

  /** Whether any profitable oracle report was found */
  hadProfitableReport: boolean;
}

/**
 * Process all events from a transaction through the appropriate handlers
 *
 * Events are processed in logIndex order. Some handlers (like handleETHDistributed)
 * use look-ahead to access later events in the same transaction.
 *
 * @param logs - All parsed logs from the transaction, sorted by logIndex
 * @param store - Entity store for persisting entities
 * @param ctx - Handler context with transaction metadata
 * @returns Processing result with created entities
 */
export function processTransactionEvents(
  logs: LogDescriptionWithMeta[],
  store: EntityStore,
  ctx: HandlerContext,
): ProcessTransactionResult {
  const result: ProcessTransactionResult = {
    totalRewards: new Map(),
    eventsProcessed: 0,
    hadProfitableReport: false,
  };

  // Process events in logIndex order
  for (const log of logs) {
    result.eventsProcessed++;

    // Route to appropriate handler based on event name
    if (isETHDistributedEvent(log)) {
      const ethDistributedResult = handleETHDistributed(log, logs, store, ctx);

      if (ethDistributedResult.isProfitable && ethDistributedResult.totalReward) {
        result.totalRewards.set(ethDistributedResult.totalReward.id, ethDistributedResult.totalReward);
        result.hadProfitableReport = true;
      }
    }

    // Future handlers can be added here:
    // - handleProcessingStarted (AccountingOracle)
    // - handleExtraDataSubmitted (AccountingOracle)
    // - handleTransfer (Lido) - for fee distribution tracking
  }

  return result;
}
