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
  createNodeOperatorFeesEntity,
  createNodeOperatorsSharesEntity,
  createSharesBurnEntity,
  createSharesEntity,
  createTotalsEntity,
  LidoSubmissionEntity,
  LidoTransferEntity,
  NodeOperatorFeesEntity,
  NodeOperatorsSharesEntity,
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

  /** NodeOperatorFees entities keyed by txHash-logIndex */
  nodeOperatorFees: Map<string, NodeOperatorFeesEntity>;

  /** NodeOperatorsShares entities keyed by txHash-address */
  nodeOperatorsShares: Map<string, NodeOperatorsSharesEntity>;
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
    nodeOperatorFees: new Map<string, NodeOperatorFeesEntity>(),
    nodeOperatorsShares: new Map<string, NodeOperatorsSharesEntity>(),
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
  store.nodeOperatorFees.clear();
  store.nodeOperatorsShares.clear();
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

// ============================================================================
// NodeOperatorFees Entity Functions
// ============================================================================

/**
 * Generate entity ID for NodeOperatorFees (txHash-logIndex)
 *
 * @param txHash - Transaction hash
 * @param logIndex - Log index
 * @returns Entity ID
 */
export function makeNodeOperatorFeesId(txHash: string, logIndex: number | bigint): string {
  return `${txHash.toLowerCase()}-${logIndex.toString()}`;
}

/**
 * Load or create a NodeOperatorFees entity
 *
 * @param store - The entity store
 * @param id - Entity ID (txHash-logIndex)
 * @param create - Whether to create if not exists
 * @returns The NodeOperatorFees entity or null if not exists and create=false
 */
export function loadNodeOperatorFeesEntity(
  store: EntityStore,
  id: string,
  create: boolean = false,
): NodeOperatorFeesEntity | null {
  const normalizedId = id.toLowerCase();
  let entity = store.nodeOperatorFees.get(normalizedId);
  if (!entity && create) {
    entity = createNodeOperatorFeesEntity(normalizedId);
    store.nodeOperatorFees.set(normalizedId, entity);
  }
  return entity ?? null;
}

/**
 * Save a NodeOperatorFees entity to the store
 *
 * @param store - The entity store
 * @param entity - The entity to save
 */
export function saveNodeOperatorFees(store: EntityStore, entity: NodeOperatorFeesEntity): void {
  store.nodeOperatorFees.set(entity.id.toLowerCase(), entity);
}

/**
 * Get a NodeOperatorFees entity by ID
 *
 * @param store - The entity store
 * @param id - Entity ID (txHash-logIndex)
 * @returns The entity if found, undefined otherwise
 */
export function getNodeOperatorFees(store: EntityStore, id: string): NodeOperatorFeesEntity | undefined {
  return store.nodeOperatorFees.get(id.toLowerCase());
}

/**
 * Get all NodeOperatorFees entities for a given TotalReward
 *
 * @param store - The entity store
 * @param totalRewardId - TotalReward transaction hash
 * @returns Array of NodeOperatorFees entities
 */
export function getNodeOperatorFeesForReward(store: EntityStore, totalRewardId: string): NodeOperatorFeesEntity[] {
  const result: NodeOperatorFeesEntity[] = [];
  const normalizedId = totalRewardId.toLowerCase();
  for (const entity of store.nodeOperatorFees.values()) {
    if (entity.totalRewardId.toLowerCase() === normalizedId) {
      result.push(entity);
    }
  }
  return result;
}

// ============================================================================
// NodeOperatorsShares Entity Functions
// ============================================================================

/**
 * Generate entity ID for NodeOperatorsShares (txHash-address)
 *
 * @param txHash - Transaction hash
 * @param address - Recipient address
 * @returns Entity ID
 */
export function makeNodeOperatorsSharesId(txHash: string, address: string): string {
  return `${txHash.toLowerCase()}-${address.toLowerCase()}`;
}

/**
 * Load or create a NodeOperatorsShares entity
 *
 * @param store - The entity store
 * @param id - Entity ID (txHash-address)
 * @param create - Whether to create if not exists
 * @returns The NodeOperatorsShares entity or null if not exists and create=false
 */
export function loadNodeOperatorsSharesEntity(
  store: EntityStore,
  id: string,
  create: boolean = false,
): NodeOperatorsSharesEntity | null {
  const normalizedId = id.toLowerCase();
  let entity = store.nodeOperatorsShares.get(normalizedId);
  if (!entity && create) {
    entity = createNodeOperatorsSharesEntity(normalizedId);
    store.nodeOperatorsShares.set(normalizedId, entity);
  }
  return entity ?? null;
}

/**
 * Save a NodeOperatorsShares entity to the store
 *
 * @param store - The entity store
 * @param entity - The entity to save
 */
export function saveNodeOperatorsShares(store: EntityStore, entity: NodeOperatorsSharesEntity): void {
  store.nodeOperatorsShares.set(entity.id.toLowerCase(), entity);
}

/**
 * Get a NodeOperatorsShares entity by ID
 *
 * @param store - The entity store
 * @param id - Entity ID (txHash-address)
 * @returns The entity if found, undefined otherwise
 */
export function getNodeOperatorsShares(store: EntityStore, id: string): NodeOperatorsSharesEntity | undefined {
  return store.nodeOperatorsShares.get(id.toLowerCase());
}

/**
 * Get all NodeOperatorsShares entities for a given TotalReward
 *
 * @param store - The entity store
 * @param totalRewardId - TotalReward transaction hash
 * @returns Array of NodeOperatorsShares entities
 */
export function getNodeOperatorsSharesForReward(
  store: EntityStore,
  totalRewardId: string,
): NodeOperatorsSharesEntity[] {
  const result: NodeOperatorsSharesEntity[] = [];
  const normalizedId = totalRewardId.toLowerCase();
  for (const entity of store.nodeOperatorsShares.values()) {
    if (entity.totalRewardId.toLowerCase() === normalizedId) {
      result.push(entity);
    }
  }
  return result;
}
