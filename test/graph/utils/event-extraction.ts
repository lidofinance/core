/**
 * Event extraction utilities for Graph Simulator
 *
 * Wraps and extends the existing lib/event.ts utilities to provide
 * Graph-compatible event extraction with extended metadata.
 *
 * Reference: lib/event.ts - findEventsWithInterfaces()
 */

import { ContractTransactionReceipt, EventLog, Interface, Log, LogDescription } from "ethers";

import { ProtocolContext } from "lib/protocol";

/**
 * Extended log description with additional metadata needed by the simulator
 */
export interface LogDescriptionWithMeta extends LogDescription {
  /** Contract address that emitted the event */
  address: string;

  /** Log index within the transaction */
  logIndex: number;

  /** Block number */
  blockNumber: number;

  /** Block timestamp (if available) */
  blockTimestamp?: bigint;

  /** Transaction hash */
  transactionHash: string;

  /** Transaction index */
  transactionIndex: number;
}

/**
 * Parse a single log entry using provided interfaces
 *
 * @param entry - The log entry to parse
 * @param interfaces - Array of contract interfaces to try
 * @returns Parsed log description or null if parsing fails
 */
function parseLogEntry(entry: Log, interfaces: Interface[]): LogDescription | null {
  // Try EventLog first (has built-in interface)
  if (entry instanceof EventLog) {
    try {
      return entry.interface.parseLog(entry);
    } catch {
      // Fall through to try other interfaces
    }
  }

  // Try each interface
  for (const iface of interfaces) {
    try {
      const parsed = iface.parseLog(entry);
      if (parsed) {
        return parsed;
      }
    } catch {
      // Continue to next interface
    }
  }

  return null;
}

/**
 * Extract all parseable logs from a transaction receipt with extended metadata
 *
 * This function parses all logs in a transaction using the protocol's contract
 * interfaces and adds metadata needed for event processing.
 *
 * @param receipt - Transaction receipt containing logs
 * @param ctx - Protocol context with contract interfaces
 * @returns Array of parsed logs with metadata, sorted by logIndex
 */
export function extractAllLogs(receipt: ContractTransactionReceipt, ctx: ProtocolContext): LogDescriptionWithMeta[] {
  const results: LogDescriptionWithMeta[] = [];

  for (const log of receipt.logs) {
    const parsed = parseLogEntry(log, ctx.interfaces);

    if (parsed) {
      const extended: LogDescriptionWithMeta = Object.assign(Object.create(Object.getPrototypeOf(parsed)), parsed, {
        address: log.address,
        logIndex: log.index,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
      });

      results.push(extended);
    }
  }

  // Sort by logIndex to ensure correct processing order
  return results.sort((a, b) => a.logIndex - b.logIndex);
}

/**
 * Find an event by name in the logs array
 *
 * @param logs - Array of parsed logs
 * @param eventName - Name of the event to find
 * @param afterLogIndex - Optional: only search logs after this index
 * @returns First matching event or null
 */
export function findEventByName(
  logs: LogDescriptionWithMeta[],
  eventName: string,
  afterLogIndex?: number,
): LogDescriptionWithMeta | null {
  const startIndex = afterLogIndex ?? -1;

  for (const log of logs) {
    if (log.logIndex > startIndex && log.name === eventName) {
      return log;
    }
  }

  return null;
}

/**
 * Find all events by name in the logs array
 *
 * @param logs - Array of parsed logs
 * @param eventName - Name of the event to find
 * @param startLogIndex - Optional: only search logs at or after this index
 * @param endLogIndex - Optional: only search logs before this index
 * @returns Array of matching events
 */
export function findAllEventsByName(
  logs: LogDescriptionWithMeta[],
  eventName: string,
  startLogIndex?: number,
  endLogIndex?: number,
): LogDescriptionWithMeta[] {
  const start = startLogIndex ?? 0;
  const end = endLogIndex ?? Infinity;

  return logs.filter((log) => log.name === eventName && log.logIndex >= start && log.logIndex < end);
}

/**
 * Get event argument value with type safety
 *
 * Helper to extract typed values from event args.
 *
 * @param event - The parsed event
 * @param argName - Name of the argument
 * @returns The argument value
 */
export function getEventArg<T>(event: LogDescriptionWithMeta, argName: string): T {
  return event.args[argName] as T;
}

/**
 * Check if an event exists in the logs
 *
 * @param logs - Array of parsed logs
 * @param eventName - Name of the event to check
 * @returns true if event exists
 */
export function hasEvent(logs: LogDescriptionWithMeta[], eventName: string): boolean {
  return logs.some((log) => log.name === eventName);
}

/**
 * Zero address constant for mint detection
 */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Represents a paired Transfer and TransferShares event
 *
 * These events are emitted together by Lido for share transfers.
 * The Transfer event contains the ETH value, while TransferShares contains the share amount.
 */
export interface TransferPair {
  transfer: {
    from: string;
    to: string;
    value: bigint;
    logIndex: number;
  };
  transferShares: {
    from: string;
    to: string;
    sharesValue: bigint;
    logIndex: number;
  };
}

/**
 * Find paired Transfer/TransferShares events within a log index range
 *
 * This mirrors the real graph's extractPairedEvent() function from parser.ts.
 * Transfer and TransferShares events are emitted consecutively by Lido,
 * so we pair them by finding Transfer events followed by TransferShares events.
 *
 * @param logs - Array of parsed logs
 * @param startLogIndex - Start of range (exclusive, typically ETHDistributed logIndex)
 * @param endLogIndex - End of range (exclusive, typically TokenRebased logIndex)
 * @returns Array of paired Transfer/TransferShares events
 */
export function findTransferSharesPairs(
  logs: LogDescriptionWithMeta[],
  startLogIndex: number,
  endLogIndex: number,
): TransferPair[] {
  const pairs: TransferPair[] = [];

  // Get all Transfer and TransferShares events in range
  const transferEvents = logs.filter(
    (log) => log.name === "Transfer" && log.logIndex > startLogIndex && log.logIndex < endLogIndex,
  );
  const transferSharesEvents = logs.filter(
    (log) => log.name === "TransferShares" && log.logIndex > startLogIndex && log.logIndex < endLogIndex,
  );

  // Pair Transfer events with their corresponding TransferShares events
  // They are emitted consecutively, so TransferShares follows Transfer with logIndex + 1
  for (const transfer of transferEvents) {
    // Find the TransferShares event that immediately follows this Transfer
    const matchingTransferShares = transferSharesEvents.find((ts) => ts.logIndex === transfer.logIndex + 1);

    if (matchingTransferShares) {
      pairs.push({
        transfer: {
          from: getEventArg<string>(transfer, "from"),
          to: getEventArg<string>(transfer, "to"),
          value: getEventArg<bigint>(transfer, "value"),
          logIndex: transfer.logIndex,
        },
        transferShares: {
          from: getEventArg<string>(matchingTransferShares, "from"),
          to: getEventArg<string>(matchingTransferShares, "to"),
          sharesValue: getEventArg<bigint>(matchingTransferShares, "sharesValue"),
          logIndex: matchingTransferShares.logIndex,
        },
      });
    }
  }

  return pairs;
}
