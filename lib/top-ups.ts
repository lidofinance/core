import { BigNumberish, BytesLike, getBytes, hexlify } from "ethers";

type Lodestar = typeof import("@lodestar/types");

// Lodestar is ESM-only and exports just an `import` condition, so the `require()` our CommonJS TypeScript
// compiles to cannot load it. `eval` keeps a real dynamic import, the same approach as lib/deposit.ts.
const loadSsz = async () => ((await eval('import("@lodestar/types")')) as Lodestar).ssz;

const FAR_FUTURE_EPOCH = 2n ** 64n - 1n;

// Lodestar keeps epochs as JS numbers and represents FAR_FUTURE_EPOCH as Infinity.
const toEpoch = (epoch: BigNumberish) => (BigInt(epoch) === FAR_FUTURE_EPOCH ? Infinity : Number(epoch));

export interface ValidatorContainer {
  pubkey: BytesLike;
  withdrawalCredentials: BytesLike;
  effectiveBalance: BigNumberish;
  slashed: boolean;
  activationEligibilityEpoch: BigNumberish;
  activationEpoch: BigNumberish;
  exitEpoch: BigNumberish;
  withdrawableEpoch: BigNumberish;
}

interface BeaconHeader {
  slot: BigNumberish;
  proposerIndex: BigNumberish;
  parentRoot: BytesLike;
  stateRoot: BytesLike;
  bodyRoot: BytesLike;
}

interface MerkleNode {
  readonly root: Uint8Array;
  readonly left: MerkleNode;
  readonly right: MerkleNode;
}

/** Sibling hashes from the node at `gindex` up to the root, leaf side first. */
function getProof(root: MerkleNode, gindex: bigint): string[] {
  let node = root;
  const witnesses: string[] = [];
  for (const bit of gindex.toString(2).slice(1)) {
    witnesses.push(hexlify(bit === "0" ? node.right.root : node.left.root));
    node = bit === "0" ? node.left : node.right;
  }
  return witnesses.reverse();
}

/** Root of a beacon block header and the proof of its `stateRoot` field. */
export const buildBeaconHeaderProof = async (value: BeaconHeader) => {
  const { BeaconBlockHeader } = (await loadSsz()).phase0;
  const view = BeaconBlockHeader.toView({
    slot: Number(value.slot),
    proposerIndex: Number(value.proposerIndex),
    parentRoot: getBytes(value.parentRoot),
    stateRoot: getBytes(value.stateRoot),
    bodyRoot: getBytes(value.bodyRoot),
  });
  return {
    root: hexlify(view.node.root),
    proof: getProof(view.node, BeaconBlockHeader.getPathInfo(["stateRoot"]).gindex),
  };
};

/**
 * Builds a real Electra (pre-Gloas) or Gloas BeaconState from Lodestar's types, with every field at its
 * default except `validators`, and returns the state root plus each validator's generalized index and proof.
 */
export const buildValidatorStateProofs = async (
  validators: readonly ValidatorContainer[],
  options: { gloas?: boolean } = {},
) => {
  const ssz = await loadSsz();
  // Both layouts expose the same `validators` view API; the cast only collapses the union for TypeScript.
  const BeaconState = (
    options.gloas ? ssz.gloas.BeaconState : ssz.electra.BeaconState
  ) as typeof ssz.electra.BeaconState;

  const state = BeaconState.defaultViewDU();
  for (const v of validators) {
    state.validators.push(
      ssz.phase0.Validator.toViewDU({
        pubkey: getBytes(v.pubkey),
        withdrawalCredentials: getBytes(v.withdrawalCredentials),
        effectiveBalance: Number(v.effectiveBalance),
        slashed: v.slashed,
        activationEligibilityEpoch: toEpoch(v.activationEligibilityEpoch),
        activationEpoch: toEpoch(v.activationEpoch),
        exitEpoch: toEpoch(v.exitEpoch),
        withdrawableEpoch: toEpoch(v.withdrawableEpoch),
      }),
    );
  }
  state.commit();

  const gindices = validators.map((_, index) => BeaconState.getPathInfo(["validators", index]).gindex);
  return {
    root: hexlify(state.node.root),
    gindices,
    proofs: gindices.map((gindex) => getProof(state.node, gindex)),
  };
};
