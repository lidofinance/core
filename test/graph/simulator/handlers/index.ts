/**
 * Handler registry for Graph Simulator
 *
 * Maps event names to their handler functions and coordinates
 * event processing across all handlers.
 */

import { ProtocolContext } from "lib/protocol";

import { LogDescriptionWithMeta } from "../../utils/event-extraction";
import {
  LidoSubmissionEntity,
  LidoTransferEntity,
  SharesBurnEntity,
  TotalRewardEntity,
  TotalsEntity,
} from "../entities";
import { EntityStore } from "../store";

import {
  ExternalSharesBurntResult,
  ExternalSharesMintedResult,
  handleETHDistributed,
  handleExternalSharesBurnt,
  handleExternalSharesMinted,
  HandlerContext,
  handleSharesBurntWithEntity,
  handleSubmitted,
  handleTransfer,
  isETHDistributedEvent,
  isExternalSharesBurntEvent,
  isExternalSharesMintedEvent,
  isSharesBurntEvent,
  isSubmittedEvent,
  isTransferEvent,
  SharesBurntResult,
  ValidationWarning,
} from "./lido";

// Re-export for convenience
export {
  HandlerContext,
  ValidationWarning,
  SharesBurntResult,
  SharesBurntWithEntityResult,
  SubmittedResult,
  TransferResult,
  ExternalSharesMintedResult,
  ExternalSharesBurntResult,
} from "./lido";

/**
 * Result of processing a transaction's events
 */
export interface ProcessTransactionResult {
  /** TotalReward entities created/updated (keyed by tx hash) */
  totalRewards: Map<string, TotalRewardEntity>;

  /** LidoSubmission entities created (keyed by entity id) */
  lidoSubmissions: Map<string, LidoSubmissionEntity>;

  /** LidoTransfer entities created (keyed by entity id) */
  lidoTransfers: Map<string, LidoTransferEntity>;

  /** SharesBurn entities created (keyed by entity id) */
  sharesBurns: Map<string, SharesBurnEntity>;

  /** Number of events processed */
  eventsProcessed: number;

  /** Whether any profitable oracle report was found */
  hadProfitableReport: boolean;

  /** Whether Totals entity was updated */
  totalsUpdated: boolean;

  /** The current state of the Totals entity after processing */
  totals: TotalsEntity | null;

  /** SharesBurnt events processed during withdrawal finalization (legacy format) */
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
    lidoSubmissions: new Map(),
    lidoTransfers: new Map(),
    sharesBurns: new Map(),
    eventsProcessed: 0,
    hadProfitableReport: false,
    totalsUpdated: false,
    totals: null,
    sharesBurnt: [],
    warnings: [],
  };

  // Track which events were already processed by other handlers
  const processedSharesBurntIndices = new Set<number>();
  const processedTransferIndices = new Set<number>();

  // Process events in logIndex order
  for (const log of logs) {
    result.eventsProcessed++;

    // ========== Submitted Event ==========
    if (isSubmittedEvent(log)) {
      const submittedResult = handleSubmitted(log, logs, store, ctx);

      result.lidoSubmissions.set(submittedResult.submission.id, submittedResult.submission);
      result.lidoTransfers.set(submittedResult.transfer.id, submittedResult.transfer);
      result.totalsUpdated = true;
      result.totals = submittedResult.totals;

      // Mark the associated Transfer event as processed
      const transferEvent = logs.find((l) => l.name === "Transfer" && l.logIndex > log.logIndex);
      if (transferEvent) {
        processedTransferIndices.add(transferEvent.logIndex);
      }
    }

    // ========== ETHDistributed Event (Oracle Report) ==========
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
      // (they occur between ETHDistributed and TokenRebased and are handled via handleSharesBurnt)
      // Note: Transfer events are NOT marked - they still need handleTransfer to create LidoTransfer entities
      // and update Shares. In the real Graph, handleTransfer runs for ALL Transfer events independently.
      const tokenRebasedIdx = logs.findIndex((l) => l.name === "TokenRebased" && l.logIndex > log.logIndex);
      if (tokenRebasedIdx >= 0) {
        const tokenRebasedLogIndex = logs[tokenRebasedIdx].logIndex;
        for (const l of logs) {
          if (l.logIndex > log.logIndex && l.logIndex < tokenRebasedLogIndex) {
            if (l.name === "SharesBurnt") {
              processedSharesBurntIndices.add(l.logIndex);
            }
          }
        }
      }
    }

    // ========== Transfer Event (Standalone) ==========
    if (isTransferEvent(log) && !processedTransferIndices.has(log.logIndex)) {
      const transferResult = handleTransfer(log, logs, store, ctx);

      result.lidoTransfers.set(transferResult.transfer.id, transferResult.transfer);
      result.totalsUpdated = true;
      result.totals = store.totals;
    }

    // ========== SharesBurnt Event (Standalone) ==========
    if (isSharesBurntEvent(log) && !processedSharesBurntIndices.has(log.logIndex)) {
      const sharesBurntResult = handleSharesBurntWithEntity(log, logs, store, ctx);

      result.sharesBurnt.push(sharesBurntResult);
      result.sharesBurns.set(sharesBurntResult.entity.id, sharesBurntResult.entity);
      result.lidoTransfers.set(sharesBurntResult.transfer.id, sharesBurntResult.transfer);
      result.totalsUpdated = true;
      result.totals = sharesBurntResult.totals;
    }

    // ========== V3 VaultHub Events ==========
    // Note: These require protocolContext for contract reads and are async
    // They should be handled separately via processV3Event function
  }

  // Get final Totals state from store if not already set
  if (!result.totals && store.totals) {
    result.totals = store.totals;
  }

  return result;
}

/**
 * Process a V3 VaultHub event (requires async contract reads)
 *
 * @param log - The event log
 * @param store - Entity store
 * @param ctx - Handler context
 * @param protocolContext - Protocol context for contract reads
 * @returns Result of processing the V3 event
 */
export async function processV3Event(
  log: LogDescriptionWithMeta,
  store: EntityStore,
  ctx: HandlerContext,
  protocolContext: ProtocolContext,
): Promise<ExternalSharesMintedResult | ExternalSharesBurntResult | null> {
  if (isExternalSharesMintedEvent(log)) {
    return handleExternalSharesMinted(log, store, ctx, protocolContext);
  }

  if (isExternalSharesBurntEvent(log)) {
    return handleExternalSharesBurnt(log, store, ctx, protocolContext);
  }

  return null;
}
