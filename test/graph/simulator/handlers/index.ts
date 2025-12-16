/**
 * Handler registry for Graph Simulator
 *
 * Maps event names to their handler functions and coordinates
 * event processing across all handlers.
 */

import { LogDescriptionWithMeta } from "../../utils/event-extraction";
import { TotalRewardEntity, TotalsEntity } from "../entities";
import { EntityStore } from "../store";

import {
  handleETHDistributed,
  HandlerContext,
  handleSharesBurnt,
  isETHDistributedEvent,
  isSharesBurntEvent,
  SharesBurntResult,
  ValidationWarning,
} from "./lido";

// Re-export for convenience
export { HandlerContext, ValidationWarning, SharesBurntResult } from "./lido";

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

  /** Whether Totals entity was updated */
  totalsUpdated: boolean;

  /** The current state of the Totals entity after processing */
  totals: TotalsEntity | null;

  /** SharesBurnt events processed during withdrawal finalization */
  sharesBurnt: SharesBurntResult[];

  /** Validation warnings from sanity checks */
  warnings: ValidationWarning[];
}

/**
 * Process all events from a transaction through the appropriate handlers
 *
 * Events are processed in logIndex order. Some handlers (like handleETHDistributed)
 * use look-ahead to access later events in the same transaction.
 *
 * Note: SharesBurnt events are handled within handleETHDistributed when they occur
 * between ETHDistributed and TokenRebased events (withdrawal finalization scenario).
 * Standalone SharesBurnt events outside of oracle reports are also tracked.
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
    totalsUpdated: false,
    totals: null,
    sharesBurnt: [],
    warnings: [],
  };

  // Track which SharesBurnt events were already processed by handleETHDistributed
  const processedSharesBurntIndices = new Set<number>();

  // Process events in logIndex order
  for (const log of logs) {
    result.eventsProcessed++;

    // Route to appropriate handler based on event name
    if (isETHDistributedEvent(log)) {
      const ethDistributedResult = handleETHDistributed(log, logs, store, ctx);

      // Track Totals update (happens even for non-profitable reports)
      result.totalsUpdated = true;
      result.totals = ethDistributedResult.totals;

      // Collect warnings from handler
      result.warnings.push(...ethDistributedResult.warnings);

      if (ethDistributedResult.isProfitable && ethDistributedResult.totalReward) {
        result.totalRewards.set(ethDistributedResult.totalReward.id, ethDistributedResult.totalReward);
        result.hadProfitableReport = true;
      }

      // Mark SharesBurnt events that were processed as part of this ETHDistributed handler
      // (they occur between ETHDistributed and TokenRebased)
      const tokenRebasedIdx = logs.findIndex((l) => l.name === "TokenRebased" && l.logIndex > log.logIndex);
      if (tokenRebasedIdx >= 0) {
        const tokenRebasedLogIndex = logs[tokenRebasedIdx].logIndex;
        for (const l of logs) {
          if (l.name === "SharesBurnt" && l.logIndex > log.logIndex && l.logIndex < tokenRebasedLogIndex) {
            processedSharesBurntIndices.add(l.logIndex);
          }
        }
      }
    }

    // Handle standalone SharesBurnt events (not part of oracle report)
    if (isSharesBurntEvent(log) && !processedSharesBurntIndices.has(log.logIndex)) {
      const sharesBurntResult = handleSharesBurnt(log, store);
      result.sharesBurnt.push(sharesBurntResult);
      result.totalsUpdated = true;
      result.totals = sharesBurntResult.totals;
    }

    // Future handlers can be added here:
    // - handleProcessingStarted (AccountingOracle)
    // - handleExtraDataSubmitted (AccountingOracle)
    // - handleTransfer (Lido) - for fee distribution tracking
  }

  // Get final Totals state from store if not already set
  if (!result.totals && store.totals) {
    result.totals = store.totals;
  }

  return result;
}
