// SSZ for the exact Gloas layout pinned by zap-net's gloas:stable bake.
// Schema source: sigp/lighthouse@2d281dfa1b407f7c81cd123954a9fd18ee8f02d2.
// Root equality with Lighthouse is mandatory before any witness is used.
import assert from "node:assert/strict";

import type { Node } from "@chainsafe/persistent-merkle-tree";

let tree: typeof import("@chainsafe/persistent-merkle-tree");
export async function initializeSSZ(): Promise<void> {
  // Preserve native ESM import under the repository's CommonJS ts-node config.
  tree ??= await eval('import("@chainsafe/persistent-merkle-tree")');
}
interface SSZType {
  size?: number;
  encode?(value: unknown): Buffer;
  node(value: unknown): Node;
}
interface SSZContainer extends SSZType {
  fields: Record<string, SSZType>;
  index(key: string): bigint;
}
export interface BeaconHeader {
  slot: string;
  proposer_index: string;
  parent_root: string;
  state_root: string;
  body_root: string;
}
export interface BeaconValidator {
  pubkey: string;
  withdrawal_credentials: string;
  effective_balance: string;
  slashed: boolean;
  activation_eligibility_epoch: string;
  activation_epoch: string;
  exit_epoch: string;
  withdrawable_epoch: string;
}
export interface BeaconState {
  slot: string;
  validators: BeaconValidator[];
  block_roots: string[];
  historical_summaries: { block_summary_root: string; state_summary_root: string }[];
  pending_deposits: { pubkey: string }[];
}

export const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;
const leaf = (bytes: Uint8Array): Node => {
  assert.ok(bytes.length <= 32);
  const padded = Buffer.alloc(32);
  padded.set(bytes);
  return tree.LeafNode.fromRoot(padded);
};
const merkle = (nodes: Node[], capacity = nodes.length): Node => {
  assert.ok(nodes.length <= capacity);
  return tree.subtreeFillToContents(nodes, Math.ceil(Math.log2(Math.max(1, capacity))));
};
const chunks = (bytes: Buffer): Node[] =>
  Array.from({ length: Math.ceil(bytes.length / 32) }, (_, i) => leaf(bytes.subarray(i * 32, i * 32 + 32)));
const uint = (size: number): SSZType => ({
  size,
  encode(v: unknown) {
    assert.ok(typeof v === "string" || typeof v === "number" || typeof v === "bigint");
    let n = BigInt(v);
    assert.ok(n >= 0n && n < 1n << BigInt(size * 8), "SSZ integer out of range");
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i++, n >>= 8n) bytes[i] = Number(n & 255n);
    return bytes;
  },
  node(v: unknown) {
    return leaf(this.encode!(v));
  },
});
const u64 = uint(8),
  u8 = uint(1);
const bytes = (size: number): SSZType => ({
  node(v: unknown) {
    assert.ok(typeof v === "string");
    assert.match(v, /^0x(?:[0-9a-fA-F]{2})*$/);
    const value = Buffer.from(v.slice(2), "hex");
    assert.equal(value.length, size, "SSZ byte vector length");
    return merkle(chunks(value));
  },
});
const root = bytes(32),
  pubkey = bytes(48);
const boolean: SSZType = {
  node(v: unknown) {
    assert.equal(typeof v, "boolean");
    return u8.node(v ? 1 : 0);
  },
};

// SSZ progressive subtrees have capacities 1, 4, 16, ... with a zero right tail.
function progressive(nodes: Node[], capacity = 1): Node {
  if (!nodes.length) return tree.zeroNode(0);
  return new tree.BranchNode(
    merkle(nodes.slice(0, capacity), capacity),
    progressive(nodes.slice(capacity), capacity * 4),
  );
}
export function progressiveIndex(index: number): bigint {
  assert.ok(Number.isSafeInteger(index) && index >= 0);
  let capacity = 1,
    depth = 0,
    prefix = 2n;
  while (index >= capacity) {
    index -= capacity;
    capacity *= 4;
    depth += 2;
    prefix = prefix * 2n + 1n;
  }
  return ((prefix * 2n) << BigInt(depth)) + BigInt(index);
}
export const concatIndex = (parent: bigint, child: bigint): bigint =>
  (parent << BigInt(child.toString(2).length - 1)) | (child ^ (1n << BigInt(child.toString(2).length - 1)));
const container = (fields: Record<string, SSZType>, prog = false): SSZContainer => ({
  fields,
  node(value: unknown) {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
    const v = value as Record<string, unknown>;
    assert.deepEqual(Object.keys(v).sort(), Object.keys(fields).sort(), "Unexpected SSZ container fields");
    const nodes = Object.entries(fields).map(([key, type]) => type.node(v[key]));
    if (!prog) return merkle(nodes);
    return new tree.BranchNode(progressive(nodes), uint(32).node((1n << BigInt(nodes.length)) - 1n));
  },
  index(key: string) {
    const i = Object.keys(fields).indexOf(key);
    assert.ok(i >= 0, `Unknown field ${key}`);
    return prog ? progressiveIndex(i) : BigInt(2 ** Math.ceil(Math.log2(Object.keys(fields).length)) + i);
  },
});
const sequence = (type: SSZType, size: number, kind: "vector" | "list" | "progressive" = "vector"): SSZType => ({
  node(v: unknown) {
    assert.ok(Array.isArray(v));
    if (kind === "vector") assert.equal(v.length, size, "SSZ vector length");
    if (kind === "list") assert.ok(v.length <= size, "SSZ list limit");
    const nodes = type.size ? chunks(Buffer.concat(v.map((x) => type.encode!(x)))) : v.map((x) => type.node(x));
    const limit = type.size ? Math.ceil((size * type.size) / 32) : size;
    const contents = kind === "progressive" ? progressive(nodes) : merkle(nodes, limit);
    return kind === "vector" ? contents : new tree.BranchNode(contents, u64.node(v.length));
  },
});
const vector = (type: SSZType, size: number) => sequence(type, size);
const list = (type: SSZType, limit: number) => sequence(type, limit, "list");
const progList = (type: SSZType) => sequence(type, 0, "progressive");
export const Validator = container({
  pubkey,
  withdrawal_credentials: root,
  effective_balance: u64,
  slashed: boolean,
  activation_eligibility_epoch: u64,
  activation_epoch: u64,
  exit_epoch: u64,
  withdrawable_epoch: u64,
});
export const Header = container({
  slot: u64,
  proposer_index: u64,
  parent_root: root,
  state_root: root,
  body_root: root,
});
export const DepositMessage = container({ pubkey, withdrawal_credentials: root, amount: u64 });
export const DepositData = container({ pubkey, withdrawal_credentials: root, amount: u64, signature: bytes(96) });
export const ForkData = container({ current_version: bytes(4), genesis_validators_root: root });
export const SigningData = container({ object_root: root, domain: root });
export const VoluntaryExit = container({ epoch: u64, validator_index: u64 });
const checkpoint = container({ epoch: u64, root });
const eth1 = container({ deposit_root: root, deposit_count: u64, block_hash: root });
const summary = container({ block_summary_root: root, state_summary_root: root });
const sync = container({ pubkeys: vector(pubkey, 512), aggregate_pubkey: pubkey });
const withdrawal = container({ index: u64, validator_index: u64, address: bytes(20), amount: u64 });
const builderWithdrawal = container({ fee_recipient: bytes(20), amount: u64, builder_index: u64 });
const bid = container(
  {
    parent_block_hash: root,
    parent_block_root: root,
    block_hash: root,
    prev_randao: root,
    fee_recipient: bytes(20),
    gas_limit: u64,
    builder_index: u64,
    slot: u64,
    value: u64,
    execution_payment: u64,
    blob_kzg_commitments: progList(bytes(48)),
    execution_requests_root: root,
  },
  true,
);
export const State = container(
  {
    genesis_time: u64,
    genesis_validators_root: root,
    slot: u64,
    fork: container({ previous_version: bytes(4), current_version: bytes(4), epoch: u64 }),
    latest_block_header: Header,
    block_roots: vector(root, 8192),
    state_roots: vector(root, 8192),
    historical_roots: list(root, 2 ** 24),
    eth1_data: eth1,
    eth1_data_votes: list(eth1, 2048),
    eth1_deposit_index: u64,
    validators: progList(Validator),
    balances: progList(u64),
    randao_mixes: vector(root, 65536),
    slashings: vector(u64, 8192),
    previous_epoch_participation: progList(u8),
    current_epoch_participation: progList(u8),
    justification_bits: bytes(1),
    previous_justified_checkpoint: checkpoint,
    current_justified_checkpoint: checkpoint,
    finalized_checkpoint: checkpoint,
    inactivity_scores: progList(u64),
    current_sync_committee: sync,
    next_sync_committee: sync,
    latest_block_hash: root,
    next_withdrawal_index: u64,
    next_withdrawal_validator_index: u64,
    historical_summaries: list(summary, 2 ** 24),
    deposit_requests_start_index: u64,
    deposit_balance_to_consume: u64,
    exit_balance_to_consume: u64,
    earliest_exit_epoch: u64,
    consolidation_balance_to_consume: u64,
    earliest_consolidation_epoch: u64,
    pending_deposits: progList(
      container({ pubkey, withdrawal_credentials: root, amount: u64, signature: bytes(96), slot: u64 }),
    ),
    pending_partial_withdrawals: progList(container({ validator_index: u64, amount: u64, withdrawable_epoch: u64 })),
    pending_consolidations: progList(container({ source_index: u64, target_index: u64 })),
    proposer_lookahead: vector(u64, 64),
    builders: progList(
      container({
        pubkey,
        version: u8,
        execution_address: bytes(20),
        balance: u64,
        deposit_epoch: u64,
        withdrawable_epoch: u64,
      }),
    ),
    next_withdrawal_builder_index: u64,
    execution_payload_availability: bytes(1024),
    builder_pending_payments: vector(
      container({ weight: u64, withdrawal: builderWithdrawal, proposer_index: u64 }),
      64,
    ),
    builder_pending_withdrawals: progList(builderWithdrawal),
    latest_execution_payload_bid: bid,
    payload_expected_withdrawals: progList(withdrawal),
    ptc_window: vector(vector(u64, 512), 96),
  },
  true,
);
export function proof(node: Node, index: bigint): string[] {
  return new tree.Tree(node).getSingleProof(index).map(hex);
}
export function validatorProof(stateNode: Node, index: number) {
  return proof(stateNode, concatIndex(State.index("validators"), progressiveIndex(index)));
}
export function validatorWitness(
  stateNode: Node,
  state: BeaconState,
  header: BeaconHeader,
  index: number,
  timestamp: number,
) {
  const v = state.validators[index];
  assert.ok(v);
  const stateProof = validatorProof(stateNode, index);
  const headerProof = proof(Header.node(header), Header.index("state_root"));
  const beacon = { childBlockTimestamp: timestamp, slot: header.slot, proposerIndex: header.proposer_index };
  const common = {
    pubkey: v.pubkey,
    effectiveBalance: v.effective_balance,
    activationEligibilityEpoch: v.activation_eligibility_epoch,
    activationEpoch: v.activation_epoch,
    exitEpoch: v.exit_epoch,
    withdrawableEpoch: v.withdrawable_epoch,
    slashed: v.slashed,
  };
  return {
    beacon,
    validator: { ...common, proofValidator: [...stateProof, ...headerProof] },
    pubkey: {
      ...beacon,
      pubkey: v.pubkey,
      validatorIndex: index,
      proof: [...proof(Validator.node(v), 4n), ...stateProof, ...headerProof],
    },
    exit: {
      exitRequestIndex: 0,
      withdrawalCredentials: v.withdrawal_credentials,
      effectiveBalance: v.effective_balance,
      slashed: v.slashed,
      activationEligibilityEpoch: v.activation_eligibility_epoch,
      activationEpoch: v.activation_epoch,
      withdrawableEpoch: v.withdrawable_epoch,
      validatorProof: stateProof,
    },
  };
}
