import { ethers } from "ethers";

/**
 * Independent derivation of the beacon-state generalized indices hardcoded in
 * `contracts/common/lib/CLGIndices.sol`.
 *
 * The point is that nothing here restates the library's hex literals: everything follows from the
 * consensus-layer facts below. Changing one of those is a deliberate statement about the state
 * layout, which is exactly the decision a reviewer should have to make — copying a new hex literal
 * over a failing assertion is not.
 */

// Electra `BeaconState` is a flat SSZ container; Gloas turns it into a `ProgressiveContainer`
// (EIP-7688/7495) but keeps the field order, and `historical_summaries` stays a plain `List` in both.
export const BEACON_STATE_FIELD_COUNT = 37n;
export const VALIDATORS_FIELD_INDEX = 11n;
export const HISTORICAL_SUMMARIES_FIELD_INDEX = 27n;

// https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#state-list-lengths
export const VALIDATOR_REGISTRY_LIMIT_LOG2 = 40n;
export const HISTORICAL_ROOTS_LIMIT_LOG2 = 24n;

/** `GIndex` packs the tree index into the high bits and the level width exponent into the low byte. */
export const pack = (index: bigint, pow: bigint): string =>
  ethers.zeroPadValue(ethers.toBeHex((index << 8n) | pow), 32);

/** Depth of the smallest binary tree that holds `fieldCount` leaves. */
export function containerDepth(fieldCount: bigint): bigint {
  let depth = 0n;
  while (1n << depth < fieldCount) depth += 1n;
  return depth;
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

/** Generalized index of field `index` in a flat container, as the state is laid out before Gloas. */
export const flatContainerField = (index: bigint): bigint => (1n << containerDepth(BEACON_STATE_FIELD_COUNT)) + index;

/** An SSZ `List` roots as `hash(vector_root, length)`, so its elements live under `2 * fieldGI`. */
export const listFirstElement = (fieldGI: bigint, capacityLog2: bigint): string =>
  pack((fieldGI * 2n) << capacityLog2, capacityLog2);

/** `BeaconState.validators[0]` before Gloas, where the registry is a fixed-capacity `List`. */
export const giFirstValidatorPreGloas = (): string =>
  listFirstElement(flatContainerField(VALIDATORS_FIELD_INDEX), VALIDATOR_REGISTRY_LIMIT_LOG2);

/** `BeaconState.historical_summaries[0]` before Gloas. */
export const giFirstHistoricalSummaryPreGloas = (): string =>
  listFirstElement(flatContainerField(HISTORICAL_SUMMARIES_FIELD_INDEX), HISTORICAL_ROOTS_LIMIT_LOG2);

/**
 * `BeaconState.validators` after Gloas. The registry becomes a `ProgressiveList`, so the constant
 * is the list root itself: the verifier concatenates a per-element index onto it rather than
 * shifting off a first element.
 */
export const giValidators = (): string => pack(progressiveListNodeGIndexReference(VALIDATORS_FIELD_INDEX), 0n);

/** `BeaconState.historical_summaries[0]` after Gloas, still a plain `List` under a progressive field. */
export const giFirstHistoricalSummary = (): string =>
  listFirstElement(progressiveListNodeGIndexReference(HISTORICAL_SUMMARIES_FIELD_INDEX), HISTORICAL_ROOTS_LIMIT_LOG2);
