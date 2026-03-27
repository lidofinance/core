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

/** Creates dummy (empty-proof) validator witnesses for use in ConsolidationGateway tests. */
export const witnessesForTargets = (targets: string[]) =>
  targets.map((pubkey) => ({
    proof: [] as string[],
    pubkey,
    validatorIndex: 0,
    childBlockTimestamp: 0,
    slot: 0,
    proposerIndex: 0,
  }));

/** Creates ConsolidationWitnessGroup[] for ConsolidationBus.executeConsolidation */
export const buildWitnessGroups = (sourcePubkeysGroups: string[][], targetPubkeys: string[]) =>
  sourcePubkeysGroups.map((sourcePubkeys, i) => ({
    sourcePubkeys,
    targetWitness: {
      proof: [] as string[],
      pubkey: targetPubkeys[i],
      validatorIndex: 0,
      childBlockTimestamp: 0,
      slot: 0,
      proposerIndex: 0,
    },
  }));
