/**
 * Independent derivation of the beacon-state generalized indices hardcoded in
 * `contracts/common/lib/CLGIndices.sol`.
 *
 * The point is that nothing here restates the library's hex literals: everything follows from the
 * consensus-layer facts below. Changing one of those is a deliberate statement about the state
 * layout, which is exactly the decision a reviewer should have to make — copying a new hex literal
 * over a failing assertion is not.
 */

// Before Gloas `BeaconState` is a flat SSZ container: 37 fields in Electra, 38 in Fulu, which appends
// `proposer_lookahead`. Gloas turns it into a `ProgressiveContainer` (EIP-7688/7495) but keeps the field
// order, and `historical_summaries` stays a plain `List` in both.
export const BEACON_STATE_FIELD_COUNT = 38n;
export const VALIDATORS_FIELD_INDEX = 11n;
export const HISTORICAL_SUMMARIES_FIELD_INDEX = 27n;

// https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#state-list-lengths
export const VALIDATOR_REGISTRY_LIMIT_LOG2 = 40n;
export const HISTORICAL_ROOTS_LIMIT_LOG2 = 24n;

/** Depth of the smallest binary tree that holds `fieldCount` leaves. */
export function containerDepth(fieldCount: bigint): bigint {
  let depth = 0n;
  while (1n << depth < fieldCount) depth += 1n;
  return depth;
}

/**
 * Concatenation of generalized indices: the path to `rhs` appended to the path to `lhs`.
 * A generalized index is a leading 1 followed by the path bits, so the leading bit of `rhs` is dropped.
 */
export function concatGIndices(...gIs: bigint[]): bigint {
  return gIs.reduce((lhs, rhs) => {
    if (lhs <= 0n || rhs <= 0n) throw new Error("Invalid generalized index");
    const rhsDepth = BigInt(rhs.toString(2).length - 1);
    return (lhs << rhsDepth) | (rhs ^ (1n << rhsDepth));
  });
}

/**
 * Generalized index of node `i` of a `ProgressiveList` (EIP-7916), derived by walking the chunks:
 * chunk `k` holds `4^k` elements and hangs off the left branch of the `k`-th recursion step.
 *
 * Deliberately iterative, unlike `progressiveListNodeGIndex` in `contracts/common/lib/GIndex.sol`,
 * which jumps to the chunk with a closed-form geometric-series step.
 */
export function progressiveListNodeGIndexReference(i: bigint): bigint {
  let depth = 0n;
  let gI = 2n;

  for (;;) {
    const chunkSize = 1n << depth;
    if (i < chunkSize) {
      return ((gI << 1n) << depth) + i;
    }

    i -= chunkSize;
    depth += 2n;
    gI = (gI << 1n) + 1n;
  }
}

/** Generalized index of node `i` of a `Vector[type, length]`, relative to the vector root. */
export const vectorNodeGIndexReference = (i: bigint, length: bigint): bigint => (1n << containerDepth(length)) + i;

/**
 * Generalized index of node `i` of a `List[type, 2^depth]`, relative to the list root. A `List` roots as
 * `hash(vector_root, length)`, so its elements live under the left child of the root.
 */
export const staticListNodeGIndexReference = (i: bigint, depth: bigint): bigint =>
  concatGIndices(2n, vectorNodeGIndexReference(i, 1n << depth));

/** Generalized index of field `index` in a flat container, as the state is laid out before Gloas. */
export const flatContainerField = (index: bigint): bigint => (1n << containerDepth(BEACON_STATE_FIELD_COUNT)) + index;

/** `BeaconState.validators` before Gloas, where the registry is a fixed-capacity `List`. */
export const giValidatorsPreGloas = (): bigint => flatContainerField(VALIDATORS_FIELD_INDEX);

/** `BeaconState.historical_summaries` before Gloas. */
export const giHistoricalSummariesPreGloas = (): bigint => flatContainerField(HISTORICAL_SUMMARIES_FIELD_INDEX);

/**
 * `BeaconState.validators` after Gloas. The state becomes a `ProgressiveContainer`, so the field sits where
 * a `ProgressiveList` would keep its element with the same index.
 */
export const giValidators = (): bigint => progressiveListNodeGIndexReference(VALIDATORS_FIELD_INDEX);

/** `BeaconState.historical_summaries` after Gloas, still a plain `List` under a progressive field. */
export const giHistoricalSummaries = (): bigint => progressiveListNodeGIndexReference(HISTORICAL_SUMMARIES_FIELD_INDEX);

/** `HistoricalSummary.block_summary_root` is field 0 of a two-field container, so it sits at gI 2. */
export const giBlockRootInSummary = (): bigint => 2n;

/** `BeaconState.validators[i]` before Gloas. */
export const giValidatorPreGloas = (i: bigint): bigint =>
  concatGIndices(giValidatorsPreGloas(), staticListNodeGIndexReference(i, VALIDATOR_REGISTRY_LIMIT_LOG2));

/** `BeaconState.validators[i]` after Gloas. */
export const giValidator = (i: bigint): bigint => concatGIndices(giValidators(), progressiveListNodeGIndexReference(i));

/** `BeaconState.historical_summaries[summaryIndex].block_summary_root[rootIndex]` under the given summaries field. */
export const giHistoricalBlockRoot = (
  historicalSummariesGI: bigint,
  summaryIndex: bigint,
  rootIndex: bigint,
  slotsPerHistoricalRoot: bigint,
): bigint =>
  concatGIndices(
    historicalSummariesGI,
    staticListNodeGIndexReference(summaryIndex, HISTORICAL_ROOTS_LIMIT_LOG2),
    giBlockRootInSummary(),
    vectorNodeGIndexReference(rootIndex, slotsPerHistoricalRoot),
  );
