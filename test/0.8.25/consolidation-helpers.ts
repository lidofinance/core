/**
 * Shared test helpers for ConsolidationGateway, ConsolidationBus, and ConsolidationMigrator tests.
 */

/** Sample 48-byte validator public keys for testing. */
export const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
];

/** Creates dummy (empty-proof) validator witnesses for use in ConsolidationBus/Gateway tests. */
export const witnessesForTargets = (targets: string[]) =>
  targets.map((pubkey) => ({
    proof: [] as string[],
    pubkey,
    validatorIndex: 0,
    childBlockTimestamp: 0,
    slot: 0,
    proposerIndex: 0,
  }));
