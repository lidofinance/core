/**
 * Helper functions for Graph Simulator
 *
 * This module contains APR calculations and other derived value computations.
 * All functions include defensive checks for edge cases (division by zero,
 * very small/large values) to ensure robust behavior.
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
 * Maximum safe value for APR to prevent overflow when converting to number
 * This represents approximately 1 trillion percent APR
 */
export const MAX_APR_SCALED = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Minimum meaningful share rate to prevent precision loss
 * Share rates below this are treated as zero
 */
export const MIN_SHARE_RATE = 1n;

/**
 * Calculate V2 APR based on share rate changes
 *
 * The APR is calculated as the annualized percentage change in share rate:
 * APR = (postShareRate - preShareRate) / preShareRate * secondsPerYear / timeElapsed * 100
 *
 * ## Edge Cases Handled
 *
 * - **Zero time elapsed**: Returns 0 (no meaningful APR can be calculated)
 * - **Zero shares**: Returns 0 (prevents division by zero)
 * - **Zero share rate**: Returns 0 (prevents division by zero)
 * - **Very large values**: Capped to prevent JavaScript number overflow
 * - **Negative share rate change**: Returns negative APR (slashing/penalties scenario)
 *
 * Reference: lido-subgraph/src/helpers.ts _calcAPR_v2() lines 318-348
 *
 * @param preTotalEther - Total ether before rebase
 * @param postTotalEther - Total ether after rebase
 * @param preTotalShares - Total shares before rebase
 * @param postTotalShares - Total shares after rebase
 * @param timeElapsed - Time elapsed in seconds
 * @returns APR as a percentage (e.g., 5.0 for 5%), or 0 for edge cases
 */
export function calcAPR_v2(
  preTotalEther: bigint,
  postTotalEther: bigint,
  preTotalShares: bigint,
  postTotalShares: bigint,
  timeElapsed: bigint,
): number {
  // Edge case: zero time elapsed - no meaningful APR
  if (timeElapsed === 0n) {
    return 0;
  }

  // Edge case: zero shares - prevents division by zero
  if (preTotalShares === 0n || postTotalShares === 0n) {
    return 0;
  }

  // Edge case: zero ether - share rate would be 0
  if (preTotalEther === 0n) {
    return 0;
  }

  // APR formula from lido-subgraph:
  // preShareRate = preTotalEther * E27 / preTotalShares
  // postShareRate = postTotalEther * E27 / postTotalShares
  // apr = secondsInYear * (postShareRate - preShareRate) * 100 / preShareRate / timeElapsed

  const preShareRate = (preTotalEther * E27_PRECISION_BASE) / preTotalShares;
  const postShareRate = (postTotalEther * E27_PRECISION_BASE) / postTotalShares;

  // Edge case: pre share rate too small (would cause division by zero or precision loss)
  if (preShareRate < MIN_SHARE_RATE) {
    return 0;
  }

  // Calculate rate change (can be negative for slashing scenarios)
  const rateChange = postShareRate - preShareRate;

  // Edge case: zero rate change - APR is exactly 0
  if (rateChange === 0n) {
    return 0;
  }

  // Use BigInt arithmetic then convert to number at the end
  // Multiply by 10000 for precision, then divide by 100 at the end
  // Formula: secondsPerYear * rateChange * 100 * 10000 / preShareRate / timeElapsed
  const aprScaled = (SECONDS_PER_YEAR * rateChange * 10000n * 100n) / (preShareRate * timeElapsed);

  // Edge case: very large APR (prevent overflow when converting to number)
  if (aprScaled > MAX_APR_SCALED) {
    return Number(MAX_APR_SCALED) / 10000;
  }
  if (aprScaled < -MAX_APR_SCALED) {
    return -Number(MAX_APR_SCALED) / 10000;
  }

  return Number(aprScaled) / 10000;
}

/**
 * Safely calculate APR with explicit edge case information
 *
 * This is an extended version of calcAPR_v2 that returns additional
 * information about which edge case (if any) was encountered.
 *
 * @param preTotalEther - Total ether before rebase
 * @param postTotalEther - Total ether after rebase
 * @param preTotalShares - Total shares before rebase
 * @param postTotalShares - Total shares after rebase
 * @param timeElapsed - Time elapsed in seconds
 * @returns Object with APR value and edge case information
 */
export function calcAPR_v2Extended(
  preTotalEther: bigint,
  postTotalEther: bigint,
  preTotalShares: bigint,
  postTotalShares: bigint,
  timeElapsed: bigint,
): APRResult {
  // Edge case: zero time elapsed
  if (timeElapsed === 0n) {
    return { apr: 0, edgeCase: "zero_time_elapsed" };
  }

  // Edge case: zero shares
  if (preTotalShares === 0n) {
    return { apr: 0, edgeCase: "zero_pre_shares" };
  }
  if (postTotalShares === 0n) {
    return { apr: 0, edgeCase: "zero_post_shares" };
  }

  // Edge case: zero ether
  if (preTotalEther === 0n) {
    return { apr: 0, edgeCase: "zero_pre_ether" };
  }

  const preShareRate = (preTotalEther * E27_PRECISION_BASE) / preTotalShares;
  const postShareRate = (postTotalEther * E27_PRECISION_BASE) / postTotalShares;

  // Edge case: share rate too small
  if (preShareRate < MIN_SHARE_RATE) {
    return { apr: 0, edgeCase: "share_rate_too_small" };
  }

  const rateChange = postShareRate - preShareRate;

  // Edge case: zero rate change
  if (rateChange === 0n) {
    return { apr: 0, edgeCase: "zero_rate_change" };
  }

  const aprScaled = (SECONDS_PER_YEAR * rateChange * 10000n * 100n) / (preShareRate * timeElapsed);

  // Edge case: APR overflow
  if (aprScaled > MAX_APR_SCALED) {
    return { apr: Number(MAX_APR_SCALED) / 10000, edgeCase: "apr_overflow_positive" };
  }
  if (aprScaled < -MAX_APR_SCALED) {
    return { apr: -Number(MAX_APR_SCALED) / 10000, edgeCase: "apr_overflow_negative" };
  }

  return { apr: Number(aprScaled) / 10000, edgeCase: null };
}

/**
 * APR calculation result with edge case information
 */
export interface APRResult {
  /** Calculated APR as percentage */
  apr: number;

  /** Which edge case was encountered, or null if normal calculation */
  edgeCase: APREdgeCase | null;
}

/**
 * Edge cases that can occur during APR calculation
 */
export type APREdgeCase =
  | "zero_time_elapsed"
  | "zero_pre_shares"
  | "zero_post_shares"
  | "zero_pre_ether"
  | "share_rate_too_small"
  | "zero_rate_change"
  | "apr_overflow_positive"
  | "apr_overflow_negative";

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
