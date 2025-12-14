/**
 * Helper functions for Graph Simulator
 *
 * This module will contain APR calculations and other derived value
 * computations in future iterations.
 *
 * Reference: lido-subgraph/src/helpers.ts - _calcAPR_v2()
 */

/**
 * Calculation unit for basis points (10000 = 100%)
 */
export const CALCULATION_UNIT = 10000n;

/**
 * Precision base for share rate calculations (1e27)
 */
export const E27_PRECISION_BASE = 10n ** 27n;

/**
 * Seconds per year for APR calculations
 */
export const SECONDS_PER_YEAR = BigInt(60 * 60 * 24 * 365);

/**
 * Placeholder for APR calculation (Iteration 2)
 *
 * This will implement the V2 APR calculation based on share rate changes.
 *
 * Reference: lido-subgraph/src/helpers.ts _calcAPR_v2() lines 318-348
 *
 * @param preTotalEther - Total ether before rebase
 * @param postTotalEther - Total ether after rebase
 * @param preTotalShares - Total shares before rebase
 * @param postTotalShares - Total shares after rebase
 * @param timeElapsed - Time elapsed in seconds
 * @returns APR as a percentage (e.g., 5.0 for 5%)
 */
export function calcAPR_v2(
  preTotalEther: bigint,
  postTotalEther: bigint,
  preTotalShares: bigint,
  postTotalShares: bigint,
  timeElapsed: bigint,
): number {
  // Will be implemented in Iteration 2
  // For now, return 0
  if (timeElapsed === 0n || preTotalShares === 0n || postTotalShares === 0n) {
    return 0;
  }

  // APR formula from lido-subgraph:
  // preShareRate = preTotalEther * E27 / preTotalShares
  // postShareRate = postTotalEther * E27 / postTotalShares
  // apr = secondsInYear * (postShareRate - preShareRate) * 100 / preShareRate / timeElapsed

  const preShareRate = (preTotalEther * E27_PRECISION_BASE) / preTotalShares;
  const postShareRate = (postTotalEther * E27_PRECISION_BASE) / postTotalShares;

  if (preShareRate === 0n) {
    return 0;
  }

  // Use BigInt arithmetic then convert to number at the end
  // Multiply by 10000 for precision, then divide by 100 at the end
  const aprScaled = (SECONDS_PER_YEAR * (postShareRate - preShareRate) * 10000n * 100n) / (preShareRate * timeElapsed);

  return Number(aprScaled) / 10000;
}

/**
 * Calculate fee basis points
 *
 * @param totalFee - Total fee amount
 * @param totalRewardsWithFees - Total rewards including fees
 * @returns Fee in basis points (0-10000)
 */
export function calcFeeBasis(totalFee: bigint, totalRewardsWithFees: bigint): bigint {
  if (totalRewardsWithFees === 0n) {
    return 0n;
  }
  return (totalFee * CALCULATION_UNIT) / totalRewardsWithFees;
}

/**
 * Calculate component fee basis points
 *
 * @param componentFee - Component fee amount (treasury or operators)
 * @param totalFee - Total fee amount
 * @returns Component fee as fraction of total in basis points
 */
export function calcComponentFeeBasisPoints(componentFee: bigint, totalFee: bigint): bigint {
  if (totalFee === 0n) {
    return 0n;
  }
  return (componentFee * CALCULATION_UNIT) / totalFee;
}
