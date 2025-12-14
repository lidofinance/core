/**
 * In-memory entity store for Graph Simulator
 *
 * This store mimics the Graph's database for storing entities during simulation.
 * Entities are keyed by their ID (transaction hash for TotalReward).
 *
 * Reference: The Graph's store API provides load/save operations for entities
 */

import { TotalRewardEntity } from "./entities";

/**
 * Entity store interface containing all entity collections
 *
 * Each entity type has its own Map keyed by entity ID.
 * Future iterations will add more entity types (NodeOperatorFees, etc.)
 */
export interface EntityStore {
  /** TotalReward entities keyed by transaction hash */
  totalRewards: Map<string, TotalRewardEntity>;

  // Future entity collections (Iteration 2+):
  // nodeOperatorFees: Map<string, NodeOperatorFeesEntity>;
  // nodeOperatorsShares: Map<string, NodeOperatorsSharesEntity>;
  // oracleReports: Map<string, OracleReportEntity>;
}

/**
 * Create a new empty entity store
 *
 * @returns Fresh EntityStore with empty collections
 */
export function createEntityStore(): EntityStore {
  return {
    totalRewards: new Map<string, TotalRewardEntity>(),
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
  store.totalRewards.clear();
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
