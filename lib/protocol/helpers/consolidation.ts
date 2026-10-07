import { type BigNumberish, ethers } from "ethers";

import { type HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import { type ConsolidationBus } from "typechain-types/index.js";

import { advanceChainTime, getCurrentBlockTimestamp } from "#lib";
import { addressToWC, type LocalMerkleTree, prepareLocalMerkleTree } from "#lib/pdg.js";

import { type ProtocolContext } from "../types.js";

const FAR_FUTURE_EPOCH = 2n ** 64n - 1n;

export interface ConsolidationPubkeyGroup {
  sourcePubkeys: string[];
  targetPubkey: string;
}

export interface ConsolidationTargetWitness {
  proof: string[];
  pubkey: string;
  validatorIndex: number;
  childBlockTimestamp: number;
  slot: BigNumberish;
  proposerIndex: BigNumberish;
}

export interface ConsolidationWitnessSet {
  witnesses: ConsolidationTargetWitness[];
  merkleTree: LocalMerkleTree;
  addTargetWitness: (pubkey: string) => Promise<ConsolidationTargetWitness>;
}

/**
 * Build CL witnesses for consolidation target pubkeys against a local state tree
 * committed to EIP-4788.
 *
 * The generalized index and slot come from the deployed ConsolidationGateway
 * (GI_FIRST_VALIDATOR_CURR / PIVOT_SLOT), so the proofs stay valid for any verifier
 * constants a deployment uses. Validators are active, non-exited, with 0x02
 * withdrawal credentials pointing to the real WithdrawalVault.
 */
export const prepareConsolidationTargetWitnesses = async (
  ctx: ProtocolContext,
  pubkeys: string[],
): Promise<ConsolidationWitnessSet> => {
  const { consolidationGateway, withdrawalVault } = ctx.contracts;

  const gIFirstValidator = await consolidationGateway.GI_FIRST_VALIDATOR_CURR();
  const pivotSlot = await consolidationGateway.PIVOT_SLOT();
  // Any slot at/after the pivot resolves to GI_FIRST_VALIDATOR_CURR in the verifier
  const slot = Number(pivotSlot) + 3200;

  const merkleTree = await prepareLocalMerkleTree(gIFirstValidator);
  const withdrawalCredentials = addressToWC(await withdrawalVault.getAddress(), 2);

  const makeContainer = (pubkey: string) => ({
    pubkey,
    withdrawalCredentials,
    effectiveBalance: 32_000_000_000n,
    slashed: false,
    activationEligibilityEpoch: 0,
    activationEpoch: 0,
    exitEpoch: FAR_FUTURE_EPOCH,
    withdrawableEpoch: FAR_FUTURE_EPOCH,
  });

  const buildWitnesses = async (witnessEntries: { pubkey: string; validatorIndex: number }[]) => {
    const { childBlockTimestamp, beaconBlockHeader } = await merkleTree.commitChangesToBeaconRoot(slot);
    return Promise.all(
      witnessEntries.map(async ({ pubkey, validatorIndex }) => ({
        proof: await merkleTree.buildProof(validatorIndex, beaconBlockHeader),
        pubkey,
        validatorIndex,
        childBlockTimestamp,
        slot: beaconBlockHeader.slot,
        proposerIndex: beaconBlockHeader.proposerIndex,
      })),
    );
  };

  const entries: { pubkey: string; validatorIndex: number }[] = [];
  for (const pubkey of pubkeys) {
    const { validatorIndex } = await merkleTree.addValidator(makeContainer(pubkey));
    entries.push({ pubkey, validatorIndex });
  }
  const witnesses = await buildWitnesses(entries);

  // Extend the same tree with one more target (fresh root commit re-proves everything,
  // but existing witness objects stay valid against their own committed root)
  const addTargetWitness = async (pubkey: string) => {
    const { validatorIndex } = await merkleTree.addValidator(makeContainer(pubkey));
    const [witness] = await buildWitnesses([{ pubkey, validatorIndex }]);
    return witness;
  };

  return { witnesses, merkleTree, addTargetWitness };
};

/**
 * Pin the migration topology (NOR source -> CMv2 target) against the deployed
 * migrator and router, and return the module ids. Suites assert this before doing
 * anything else so a green run can never silently come from a different topology.
 */
export const assertConsolidationTopology = async (ctx: ProtocolContext) => {
  const { consolidationMigrator, stakingRouter } = ctx.contracts;

  const sourceModuleId = await consolidationMigrator.sourceModuleId();
  const targetModuleId = await consolidationMigrator.targetModuleId();

  if (sourceModuleId !== ctx.modules.nor.id) {
    throw new Error(`Migrator source module ${sourceModuleId} is not NOR (${ctx.modules.nor.id})`);
  }
  if (targetModuleId !== ctx.modules.cmv2!.id) {
    throw new Error(`Migrator target module ${targetModuleId} is not CMv2 (${ctx.modules.cmv2!.id})`);
  }
  const routerTargetAddress = (await stakingRouter.getStakingModule(targetModuleId)).stakingModuleAddress;
  if (routerTargetAddress !== ctx.modules.cmv2!.stakingModuleAddress) {
    throw new Error(`Router target module address ${routerTargetAddress} does not match CMv2`);
  }

  return { sourceModuleId, targetModuleId };
};

/**
 * Decode a WithdrawalVault ConsolidationRequestAdded request:
 * abi.encodePacked(sourcePubkey[48], targetPubkey[48]).
 */
export const decodeConsolidationRequest = (request: string): { sourcePubkey: string; targetPubkey: string } => {
  const bytes = ethers.getBytes(request);
  if (bytes.length !== 96) throw new Error(`Unexpected consolidation request length ${bytes.length}`);
  return {
    sourcePubkey: ethers.hexlify(bytes.slice(0, 48)),
    targetPubkey: ethers.hexlify(bytes.slice(48)),
  };
};

/**
 * Compute the batch hash exactly as ConsolidationBus does:
 * keccak256(abi.encode(ConsolidationGroup[])).
 */
export const calcConsolidationBatchHash = (groups: ConsolidationPubkeyGroup[]) =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes[] sourcePubkeys, bytes targetPubkey)[]"], [groups]),
  );

/**
 * Remove an identical pending batch left over from live chain state, so a fresh
 * submission of the same pubkey grouping cannot revert with BatchAlreadyPending.
 * The remover signer must hold REMOVE_ROLE on the bus.
 */
export const ensureBatchNotPending = async (
  consolidationBus: ConsolidationBus,
  remover: HardhatEthersSigner,
  batchHash: string,
) => {
  if ((await consolidationBus.getBatchInfo(batchHash)).publisher !== ethers.ZeroAddress) {
    await consolidationBus.connect(remover).removeBatches([batchHash]);
  }
};

/**
 * Advance chain time until a pending batch passes the ConsolidationBus execution delay.
 *
 * Real deployments use a non-zero delay (86400s on Hoodi/mainnet), so executing right
 * after submission reverts with ExecutionDelayNotPassed. The delay is read from the
 * contract and the batch's own addedAt timestamp; the delay itself is never modified.
 */
export const waitUntilBatchExecutable = async (consolidationBus: ConsolidationBus, batchHash: string) => {
  const batchInfo = await consolidationBus.getBatchInfo(batchHash);
  if (batchInfo.publisher === ethers.ZeroAddress) {
    throw new Error(`Batch ${batchHash} is not pending in ConsolidationBus`);
  }

  const executeAfter = batchInfo.addedAt + (await consolidationBus.executionDelay());
  const now = await getCurrentBlockTimestamp();
  if (now < executeAfter) {
    await advanceChainTime(executeAfter - now);
  }
};
