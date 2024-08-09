/**
 * NB: ATM, there is no native support for BigInt math in TS/JS, so we're using this workaround.
 */
export const BigIntMath = {
  abs: (x: bigint) => (x < 0n ? -x : x),
  min: (x: bigint, y: bigint) => (x < y ? x : y),
  max: (x: bigint, y: bigint) => (x > y ? x : y),
};
