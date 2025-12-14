/**
 * Query functions for Graph Simulator
 *
 * These functions mimic GraphQL queries against the simulator's entity store.
 * They accept parameters similar to the GraphQL query variables.
 *
 * Reference GraphQL query:
 * ```graphql
 * query TotalRewards($skip: Int!, $limit: Int!, $block_from: BigInt!, $block: Bytes!) {
 *   totalRewards(
 *     skip: $skip
 *     first: $limit
 *     block: { hash: $block }
 *     where: { block_gt: $block_from }
 *     orderBy: blockTime
 *     orderDirection: asc
 *   ) {
 *     id
 *     totalPooledEtherBefore
 *     totalPooledEtherAfter
 *     totalSharesBefore
 *     totalSharesAfter
 *     apr
 *     block
 *     blockTime
 *     logIndex
 *   }
 * }
 * ```
 */

import { TotalRewardEntity } from "./entities";
import { EntityStore } from "./store";

/**
 * Query parameters for TotalRewards query
 */
export interface TotalRewardsQueryParams {
  /** Number of results to skip (pagination) */
  skip: number;

  /** Maximum number of results to return */
  limit: number;

  /**
   * Filter: only include entities where block > block_from
   * Maps to GraphQL: where: { block_gt: $block_from }
   */
  blockFrom: bigint;

  /**
   * Block hash for historical query (optional)
   * Maps to GraphQL: block: { hash: $block }
   * Note: In simulator, this is ignored since we don't have historical state
   */
  blockHash?: string;
}

/**
 * Result item from TotalRewards query
 * Contains only the fields requested in the GraphQL query
 */
export interface TotalRewardsQueryResult {
  id: string;
  totalPooledEtherBefore: bigint;
  totalPooledEtherAfter: bigint;
  totalSharesBefore: bigint;
  totalSharesAfter: bigint;
  apr: number;
  block: bigint;
  blockTime: bigint;
  logIndex: bigint;
}

/**
 * Order direction for sorting
 */
export type OrderDirection = "asc" | "desc";

/**
 * Order by field options for TotalRewards
 */
export type TotalRewardsOrderBy = "blockTime" | "block" | "logIndex" | "apr";

/**
 * Extended query parameters with ordering options
 */
export interface TotalRewardsQueryParamsExtended extends TotalRewardsQueryParams {
  /** Field to order by (default: blockTime) */
  orderBy?: TotalRewardsOrderBy;

  /** Order direction (default: asc) */
  orderDirection?: OrderDirection;
}

/**
 * Query TotalRewards entities from the store
 *
 * This function mimics the GraphQL query behavior:
 * - Filters by block_gt (block greater than)
 * - Orders by blockTime ascending (default)
 * - Applies skip/limit pagination
 *
 * @param store - Entity store to query
 * @param params - Query parameters
 * @returns Array of matching TotalReward results
 */
export function queryTotalRewards(
  store: EntityStore,
  params: TotalRewardsQueryParamsExtended,
): TotalRewardsQueryResult[] {
  const { skip, limit, blockFrom, orderBy = "blockTime", orderDirection = "asc" } = params;

  // Get all entities from store
  const allEntities = Array.from(store.totalRewards.values());

  // Filter: block > blockFrom
  const filtered = allEntities.filter((entity) => entity.block > blockFrom);

  // Sort by orderBy field
  const sorted = filtered.sort((a, b) => {
    let comparison: number;

    switch (orderBy) {
      case "blockTime":
        comparison = Number(a.blockTime - b.blockTime);
        break;
      case "block":
        comparison = Number(a.block - b.block);
        break;
      case "logIndex":
        comparison = Number(a.logIndex - b.logIndex);
        break;
      case "apr":
        comparison = a.apr - b.apr;
        break;
      default:
        comparison = Number(a.blockTime - b.blockTime);
    }

    return orderDirection === "asc" ? comparison : -comparison;
  });

  // Apply pagination
  const paginated = sorted.slice(skip, skip + limit);

  // Map to result format (only requested fields)
  return paginated.map(mapToQueryResult);
}

/**
 * Map a TotalRewardEntity to the query result format
 */
function mapToQueryResult(entity: TotalRewardEntity): TotalRewardsQueryResult {
  return {
    id: entity.id,
    totalPooledEtherBefore: entity.totalPooledEtherBefore,
    totalPooledEtherAfter: entity.totalPooledEtherAfter,
    totalSharesBefore: entity.totalSharesBefore,
    totalSharesAfter: entity.totalSharesAfter,
    apr: entity.apr,
    block: entity.block,
    blockTime: entity.blockTime,
    logIndex: entity.logIndex,
  };
}

/**
 * Get a single TotalReward by ID (transaction hash)
 *
 * @param store - Entity store
 * @param id - Transaction hash
 * @returns The entity if found, null otherwise
 */
export function getTotalRewardById(store: EntityStore, id: string): TotalRewardEntity | null {
  return store.totalRewards.get(id.toLowerCase()) ?? null;
}

/**
 * Count TotalRewards matching the filter criteria
 *
 * @param store - Entity store
 * @param blockFrom - Filter: only count entities where block > blockFrom
 * @returns Count of matching entities
 */
export function countTotalRewards(store: EntityStore, blockFrom: bigint = 0n): number {
  let count = 0;
  for (const entity of store.totalRewards.values()) {
    if (entity.block > blockFrom) {
      count++;
    }
  }
  return count;
}

/**
 * Get the latest TotalReward entity by block time
 *
 * @param store - Entity store
 * @returns The most recent entity or null if store is empty
 */
export function getLatestTotalReward(store: EntityStore): TotalRewardEntity | null {
  let latest: TotalRewardEntity | null = null;

  for (const entity of store.totalRewards.values()) {
    if (!latest || entity.blockTime > latest.blockTime) {
      latest = entity;
    }
  }

  return latest;
}

/**
 * Get TotalRewards within a block range
 *
 * @param store - Entity store
 * @param fromBlock - Start block (inclusive)
 * @param toBlock - End block (inclusive)
 * @returns Array of entities within the range, ordered by blockTime asc
 */
export function getTotalRewardsInBlockRange(
  store: EntityStore,
  fromBlock: bigint,
  toBlock: bigint,
): TotalRewardEntity[] {
  const results: TotalRewardEntity[] = [];

  for (const entity of store.totalRewards.values()) {
    if (entity.block >= fromBlock && entity.block <= toBlock) {
      results.push(entity);
    }
  }

  // Sort by blockTime ascending
  return results.sort((a, b) => Number(a.blockTime - b.blockTime));
}
