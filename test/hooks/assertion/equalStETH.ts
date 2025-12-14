/**
 * Custom Chai assertion for stETH value comparisons with fixed rounding margin.
 * The file will be auto-included in the test suite by the chai setup, no need to import it.
 */
import { Assertion, util } from "chai";

const STETH_ROUNDING_MARGIN = 5n;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Chai {
    interface Assertion {
      /**
       * Asserts that the actual value is equal to the expected value within the stETH rounding margin.
       * This uses a fixed margin of 5 wei to account for stETH share rounding.
       *
       * @param {bigint} expected - The expected value in wei.
       *
       * @example
       * expect(mintingCapacity).to.equalStETH(ether("32.8"));
       */
      equalStETH(expected: bigint): Assertion;
    }
  }
}

Assertion.addMethod("equalStETH", function (expected: bigint) {
  const actual = util.flag(this, "object") as bigint;

  // Check if both values are bigints
  this.assert(
    typeof actual === "bigint",
    "expected #{this} to be a bigint",
    "expected #{this} not to be a bigint",
    expected,
    actual,
  );

  this.assert(
    typeof expected === "bigint",
    "expected value must be a bigint",
    "expected value must be a bigint",
    expected,
    actual,
  );

  // Calculate the absolute difference
  const diff = actual > expected ? actual - expected : expected - actual;

  // Assert the difference is within the margin
  this.assert(
    diff <= STETH_ROUNDING_MARGIN,
    `expected #{act} to equal #{exp} ± ${STETH_ROUNDING_MARGIN} wei (stETH rounding margin), but difference was ${diff} wei`,
    `expected #{act} not to equal #{exp} ± ${STETH_ROUNDING_MARGIN} wei (stETH rounding margin)`,
    expected,
    actual,
  );
});
