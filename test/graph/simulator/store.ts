/**
 * In-memory entity store for Graph Simulator
 *
 * This store mimics the Graph's database for storing entities during simulation.
 * Entities are keyed by their ID (transaction hash for TotalReward).
 *
 * Reference: The Graph's store API provides load/save operations for entities
 */

import {
  createLidoSubmissionEntity,
  createLidoTransferEntity,
  createSharesBurnEntity,
  createSharesEntity,
  createTotalsEntity,
  LidoSubmissionEntity,
  LidoTransferEntity,
  SharesBurnEntity,
  SharesEntity,
  TotalRewardEntity,
  TotalsEntity,
} from "./entities";

/**
 * Entity store interface containing all entity collections
 *
 * Each entity type has its own Map keyed by entity ID.
 */
export interface EntityStore {
  /** Totals singleton entity (pool state) */
  totals: TotalsEntity | null;

  /** TotalReward entities keyed by transaction hash */
  totalRewards: Map<string, TotalRewardEntity>;

  /** Shares entities keyed by holder address (lowercase) */
  shares: Map<string, SharesEntity>;

  /** LidoTransfer entities keyed by txHash-logIndex */
  lidoTransfers: Map<string, LidoTransferEntity>;

  /** LidoSubmission entities keyed by txHash-logIndex */
  lidoSubmissions: Map<string, LidoSubmissionEntity>;

  /** SharesBurn entities keyed by txHash-logIndex */
  sharesBurns: Map<string, SharesBurnEntity>;
}

/**
 * Create a new empty entity store
 *
 * @returns Fresh EntityStore with empty collections
 */
export function createEntityStore(): EntityStore {
  return {
    totals: null,
    totalRewards: new Map<string, TotalRewardEntity>(),
    shares: new Map<string, SharesEntity>(),
    lidoTransfers: new Map<string, LidoTransferEntity>(),
    lidoSubmissions: new Map<string, LidoSubmissionEntity>(),
    sharesBurns: new Map<string, SharesBurnEntity>(),
  };
}

/**
 * Clear all entities from the store
 *
 * Useful for resetting state between test runs.
 *
 * @param store - The store to clear
 */
export function clearStore(store: EntityStore): void {
  store.totals = null;
  store.totalRewards.clear();
  store.shares.clear();
  store.lidoTransfers.clear();
  store.lidoSubmissions.clear();
  store.sharesBurns.clear();
}

/**
 * Load or create the Totals entity
 *
 * Mimics _loadTotalsEntity from lido-subgraph/src/helpers.ts
 *
 * @param store - The entity store
 * @param create - Whether to create if not exists
 * @returns The Totals entity or null if not exists and create=false
 */
export function loadTotalsEntity(store: EntityStore, create: boolean = false): TotalsEntity | null {
  if (!store.totals && create) {
    store.totals = createTotalsEntity();
  }
  return store.totals;
}

/**
 * Save the Totals entity to the store
 *
 * @param store - The entity store
 * @param entity - The Totals entity to save
 */
export function saveTotals(store: EntityStore, entity: TotalsEntity): void {
  store.totals = entity;
}

/**
 * Get a TotalReward entity by ID (transaction hash)
 *
 * @param store - The entity store
 * @param id - Transaction hash
 * @returns The entity if found, undefined otherwise
 */
export function getTotalReward(store: EntityStore, id: string): TotalRewardEntity | undefined {
  return store.totalRewards.get(id.toLowerCase());
}

/**
 * Save a TotalReward entity to the store
 *
 * @param store - The entity store
 * @param entity - The entity to save
 */
export function saveTotalReward(store: EntityStore, entity: TotalRewardEntity): void {
  store.totalRewards.set(entity.id.toLowerCase(), entity);
}

/**
 * Check if a TotalReward entity exists
 *
 * @param store - The entity store
 * @param id - Transaction hash
 * @returns true if entity exists
 */
export function hasTotalReward(store: EntityStore, id: string): boolean {
  return store.totalRewards.has(id.toLowerCase());
}

// ============================================================================
// Shares Entity Functions
// ============================================================================

/**
 * Load or create a Shares entity
 *
 * Mimics _loadSharesEntity from lido-subgraph/src/helpers.ts
 *
 * @param store - The entity store
 * @param id - Holder address
 * @param create - Whether to create if not exists
 * @returns The Shares entity or null if not exists and create=false
 */
export function loadSharesEntity(store: EntityStore, id: string, create: boolean = false): SharesEntity | null {
  const normalizedId = id.toLowerCase();
  let entity = store.shares.get(normalizedId);
  if (!entity && create) {
    entity = createSharesEntity(normalizedId);
    store.shares.set(normalizedId, entity);
  }
  return entity ?? null;
}

/**
 * Save a Shares entity to the store
 *
 * @param store - The entity store
 * @param entity - The entity to save
 */
export function saveShares(store: EntityStore, entity: SharesEntity): void {
  store.shares.set(entity.id.toLowerCase(), entity);
}

/**
 * Get a Shares entity by ID (holder address)
 *
 * @param store - The entity store
 * @param id - Holder address
 * @returns The entity if found, undefined otherwise
 */
export function getShares(store: EntityStore, id: string): SharesEntity | undefined {
  return store.shares.get(id.toLowerCase());
}

// ============================================================================
// LidoTransfer Entity Functions
// ============================================================================

/**
 * Generate entity ID for LidoTransfer (txHash-logIndex)
 *
 * @param txHash - Transaction hash
 * @param logIndex - Log index
 * @returns Entity ID
 */
export function makeLidoTransferId(txHash: string, logIndex: number | bigint): string {
  return `${txHash.toLowerCase()}-${logIndex.toString()}`;
}

/**
 * Load or create a LidoTransfer entity
 *
 * @param store - The entity store
 * @param id - Entity ID (txHash-logIndex)
 * @param create - Whether to create if not exists
 * @returns The LidoTransfer entity or null if not exists and create=false
 */
export function loadLidoTransferEntity(
  store: EntityStore,
  id: string,
  create: boolean = false,
): LidoTransferEntity | null {
  const normalizedId = id.toLowerCase();
  let entity = store.lidoTransfers.get(normalizedId);
  if (!entity && create) {
    entity = createLidoTransferEntity(normalizedId);
    store.lidoTransfers.set(normalizedId, entity);
  }
  return entity ?? null;
}

/**
 * Save a LidoTransfer entity to the store
 *
 * @param store - The entity store
 * @param entity - The entity to save
 */
export function saveLidoTransfer(store: EntityStore, entity: LidoTransferEntity): void {
  store.lidoTransfers.set(entity.id.toLowerCase(), entity);
}

/**
 * Get a LidoTransfer entity by ID
 *
 * @param store - The entity store
 * @param id - Entity ID (txHash-logIndex)
 * @returns The entity if found, undefined otherwise
 */
export function getLidoTransfer(store: EntityStore, id: string): LidoTransferEntity | undefined {
  return store.lidoTransfers.get(id.toLowerCase());
}

// ============================================================================
// LidoSubmission Entity Functions
// ============================================================================

/**
 * Generate entity ID for LidoSubmission (txHash-logIndex)
 *
 * @param txHash - Transaction hash
 * @param logIndex - Log index
 * @returns Entity ID
 */
export function makeLidoSubmissionId(txHash: string, logIndex: number | bigint): string {
  return `${txHash.toLowerCase()}-${logIndex.toString()}`;
}

/**
 * Load or create a LidoSubmission entity
 *
 * @param store - The entity store
 * @param id - Entity ID (txHash-logIndex)
 * @param create - Whether to create if not exists
 * @returns The LidoSubmission entity or null if not exists and create=false
 */
export function loadLidoSubmissionEntity(
  store: EntityStore,
  id: string,
  create: boolean = false,
): LidoSubmissionEntity | null {
  const normalizedId = id.toLowerCase();
  let entity = store.lidoSubmissions.get(normalizedId);
  if (!entity && create) {
    entity = createLidoSubmissionEntity(normalizedId);
    store.lidoSubmissions.set(normalizedId, entity);
  }
  return entity ?? null;
}

/**
 * Save a LidoSubmission entity to the store
 *
 * @param store - The entity store
 * @param entity - The entity to save
 */
export function saveLidoSubmission(store: EntityStore, entity: LidoSubmissionEntity): void {
  store.lidoSubmissions.set(entity.id.toLowerCase(), entity);
}

/**
 * Get a LidoSubmission entity by ID
 *
 * @param store - The entity store
 * @param id - Entity ID (txHash-logIndex)
 * @returns The entity if found, undefined otherwise
 */
export function getLidoSubmission(store: EntityStore, id: string): LidoSubmissionEntity | undefined {
  return store.lidoSubmissions.get(id.toLowerCase());
}

// ============================================================================
// SharesBurn Entity Functions
// ============================================================================

/**
 * Generate entity ID for SharesBurn (txHash-logIndex)
 *
 * @param txHash - Transaction hash
 * @param logIndex - Log index
 * @returns Entity ID
 */
export function makeSharesBurnId(txHash: string, logIndex: number | bigint): string {
  return `${txHash.toLowerCase()}-${logIndex.toString()}`;
}

/**
 * Load or create a SharesBurn entity
 *
 * @param store - The entity store
 * @param id - Entity ID (txHash-logIndex)
 * @param create - Whether to create if not exists
 * @returns The SharesBurn entity or null if not exists and create=false
 */
export function loadSharesBurnEntity(store: EntityStore, id: string, create: boolean = false): SharesBurnEntity | null {
  const normalizedId = id.toLowerCase();
  let entity = store.sharesBurns.get(normalizedId);
  if (!entity && create) {
    entity = createSharesBurnEntity(normalizedId);
    store.sharesBurns.set(normalizedId, entity);
  }
  return entity ?? null;
}

/**
 * Save a SharesBurn entity to the store
 *
 * @param store - The entity store
 * @param entity - The entity to save
 */
export function saveSharesBurn(store: EntityStore, entity: SharesBurnEntity): void {
  store.sharesBurns.set(entity.id.toLowerCase(), entity);
}

/**
 * Get a SharesBurn entity by ID
 *
 * @param store - The entity store
 * @param id - Entity ID (txHash-logIndex)
 * @returns The entity if found, undefined otherwise
 */
export function getSharesBurn(store: EntityStore, id: string): SharesBurnEntity | undefined {
  return store.sharesBurns.get(id.toLowerCase());
}
