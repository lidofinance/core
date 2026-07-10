import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationBus, ConsolidationGateway, ConsolidationMigrator, NodeOperatorsRegistry } from "typechain-types";

import { addressToWC, log } from "lib";
import { LocalMerkleTree, prepareLocalMerkleTree } from "lib/pdg";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import {
  calcConsolidationBatchHash,
  cmv2EnsureDepositedOperatorKeys,
  CMv2OperatorKeys,
  norEnsureDepositedOperatorKeys,
  NorOperatorKeys,
  waitUntilBatchExecutable,
} from "lib/protocol/helpers";
import { LoadedContract } from "lib/protocol/types";

import { Snapshot } from "test/suite";

/**
 * Gas measurement integration test for consolidation (full stack, no mocks) over the
 * real production topology: 315 source keys in NOR, 5 target keys in CMv2.
 * Uses: ConsolidationMigrator -> ConsolidationBus -> ConsolidationGateway -> WithdrawalVault
 *
 * Measured for a batch of 5 x 63 requests (NOR -> CMv2); reading target keys from CMv2
 * changes the submit cost compared to the old NOR -> NOR fixture:
 * ┌──────────────────────────┬─────────────┬─────────────┬───────────────────────┐
 * │ Operation                │ Scratch     │ Hoodi fork  │ Mainnet fork+upgrade  │
 * ├──────────────────────────┼─────────────┼─────────────┼───────────────────────┤
 * │ submitConsolidationBatch │ 7,988,430   │ 7,994,431   │ 7,948,602             │
 * │ executeConsolidation     │ 6,568,750   │ 11,524,913  │ 12,353,797            │
 * │ Total                    │ 14,557,180  │ 19,519,344  │ 20,302,399            │
 * │ Per request              │ 46,213      │ 61,966      │ 64,452                │
 * └──────────────────────────┴─────────────┴─────────────┴───────────────────────┘
 * (execute on a fork costs more mainly due to the EIP-7251 system contract fee/queue
 * state at the forked block)
 */
describe("Integration: Consolidation gas measurement (full stack via Migrator)", () => {
  let ctx: ProtocolContext;
  let nor: LoadedContract<NodeOperatorsRegistry>;
  let consolidationBus: ConsolidationBus;
  let consolidationGateway: ConsolidationGateway;
  let consolidationMigrator: ConsolidationMigrator;

  let submitter: HardhatEthersSigner;
  let executor: HardhatEthersSigner;

  const MAX_BLOCK_GAS = 16_000_000n;
  const NUM_GROUPS = 5;
  const REQUESTS_PER_GROUP = 63;
  const TOTAL_REQUESTS = NUM_GROUPS * REQUESTS_PER_GROUP; // 315
  const TOTAL_SOURCE_KEYS = BigInt(TOTAL_REQUESTS); // 315
  const TOTAL_TARGET_KEYS = BigInt(NUM_GROUPS); // 5

  const FAR_FUTURE_EPOCH = 2n ** 64n - 1n;

  let source: NorOperatorKeys;
  let target: CMv2OperatorKeys;

  // Source pubkeys grouped: 5 groups x 63 pubkeys
  let sourcePubkeysGroups: string[][];
  // Target pubkeys: 5
  let targetPubkeys: string[];

  // Key index groups for submitConsolidationBatch
  let consolidationIndexGroups: { sourceKeyIndices: bigint[]; targetKeyIndex: bigint }[];

  let originalState: string;

  before(async function () {
    ctx = await getProtocolContext();

    originalState = await Snapshot.take();

    // Explicit runner contract: CMv2 is required unless deliberately opted out
    if (!ctx.flags.withCMv2) {
      log.warning("Skipping consolidation gas suite: INTEGRATION_WITH_CMv2=off");
      this.skip();
    }
    if (!ctx.modules.cmv2) {
      throw new Error(
        "CMv2 (curated-onchain-v2) module is not registered in StakingRouter. " +
          "The consolidation suites require the real NOR -> CMv2 topology; " +
          "set INTEGRATION_WITH_CMv2=off to skip them explicitly.",
      );
    }

    [, submitter, executor] = await ethers.getSigners();

    nor = ctx.contracts.nor;
    consolidationBus = ctx.contracts.consolidationBus;
    consolidationGateway = ctx.contracts.consolidationGateway;
    consolidationMigrator = ctx.contracts.consolidationMigrator;

    // Pin the migration topology before measuring anything, so the gas figures
    // can never silently come from a NOR -> NOR setup
    const sourceModuleId = await consolidationMigrator.sourceModuleId();
    const targetModuleId = await consolidationMigrator.targetModuleId();
    expect(sourceModuleId).to.equal(ctx.modules.nor.id, "migrator source module must be NOR");
    expect(targetModuleId).to.equal(ctx.modules.cmv2.id, "migrator target module must be CMv2");
    expect((await ctx.contracts.stakingRouter.getStakingModule(targetModuleId)).stakingModuleAddress).to.equal(
      ctx.modules.cmv2.stakingModuleAddress,
      "router target module address must match CMv2",
    );

    const agentSigner = await ctx.getSigner("agent");

    // =========================================
    // Source: NOR operator with 315 deposited keys
    // =========================================
    source = await norEnsureDepositedOperatorKeys(ctx, nor, sourceModuleId, TOTAL_SOURCE_KEYS, {
      name: "gas_test_source_operator",
    });

    // =========================================
    // Target: CMv2 operator with 5 deposited keys
    // =========================================
    target = await cmv2EnsureDepositedOperatorKeys(ctx, TOTAL_TARGET_KEYS, { name: "gas_test_target_operator" });
    targetPubkeys = target.pubkeys;

    // =========================================
    // Group source keys: 5 groups x 63 keys
    // =========================================
    sourcePubkeysGroups = [];
    consolidationIndexGroups = [];
    for (let g = 0; g < NUM_GROUPS; g++) {
      const group: string[] = [];
      const indices: bigint[] = [];
      for (let r = 0; r < REQUESTS_PER_GROUP; r++) {
        const position = g * REQUESTS_PER_GROUP + r;
        group.push(source.pubkeys[position]);
        indices.push(source.keyIndices[position]);
      }
      sourcePubkeysGroups.push(group);
      consolidationIndexGroups.push({ sourceKeyIndices: indices, targetKeyIndex: target.keyIndices[g] });
    }

    // =========================================
    // Setup roles and limits
    // =========================================

    // Allow pair in ConsolidationMigrator
    const ALLOW_PAIR_ROLE = await consolidationMigrator.ALLOW_PAIR_ROLE();
    const DISALLOW_PAIR_ROLE = await consolidationMigrator.DISALLOW_PAIR_ROLE();
    await consolidationMigrator.connect(agentSigner).grantRole(ALLOW_PAIR_ROLE, agentSigner.address);
    await consolidationMigrator.connect(agentSigner).grantRole(DISALLOW_PAIR_ROLE, agentSigner.address);
    await consolidationMigrator.connect(agentSigner).allowPair(source.operatorId, target.operatorId, submitter.address);

    // Increase ConsolidationBus batch size to accommodate 315 requests in 5 groups
    const MANAGE_ROLE = await consolidationBus.MANAGE_ROLE();
    await consolidationBus.connect(agentSigner).grantRole(MANAGE_ROLE, agentSigner.address);
    if ((await consolidationBus.batchSize()) < TOTAL_REQUESTS) {
      await consolidationBus.connect(agentSigner).setBatchSize(TOTAL_REQUESTS);
    }

    // Set rate limit high enough for all requests
    const EXIT_LIMIT_MANAGER_ROLE = await consolidationGateway.EXIT_LIMIT_MANAGER_ROLE();
    await (
      await consolidationGateway.connect(agentSigner).grantRole(EXIT_LIMIT_MANAGER_ROLE, agentSigner.address)
    ).wait();
    await (
      await consolidationGateway.connect(agentSigner).setConsolidationRequestLimit(TOTAL_REQUESTS, TOTAL_REQUESTS, 1)
    ).wait();

    // Advance time by 1 second so the rate limit replenishes to maxLimit
    await ethers.provider.send("evm_increaseTime", [1]);
    await ethers.provider.send("evm_mine", []);
  });

  after(async () => await Snapshot.restore(originalState));

  it(`should execute batch of ${NUM_GROUPS} x ${REQUESTS_PER_GROUP} (${TOTAL_REQUESTS}) requests within gas limit`, async () => {
    // Build merkle tree witnesses for target pubkeys
    const merkleTree: LocalMerkleTree = await prepareLocalMerkleTree();

    const validatorIndices: number[] = [];
    const withdrawalCredentials = addressToWC(await ctx.contracts.withdrawalVault.getAddress(), 2);
    for (const pubkey of targetPubkeys) {
      const { validatorIndex } = await merkleTree.addValidator({
        pubkey,
        withdrawalCredentials,
        effectiveBalance: 32_000_000_000n,
        slashed: false,
        activationEligibilityEpoch: 0,
        activationEpoch: 0,
        exitEpoch: FAR_FUTURE_EPOCH,
        withdrawableEpoch: FAR_FUTURE_EPOCH,
      });
      validatorIndices.push(validatorIndex);
    }

    const { childBlockTimestamp, beaconBlockHeader } = await merkleTree.commitChangesToBeaconRoot();

    const targetWitnesses = await Promise.all(
      targetPubkeys.map(async (pubkey, i) => ({
        proof: await merkleTree.buildProof(validatorIndices[i], beaconBlockHeader),
        pubkey,
        validatorIndex: validatorIndices[i],
        childBlockTimestamp,
        slot: beaconBlockHeader.slot,
        proposerIndex: beaconBlockHeader.proposerIndex,
      })),
    );

    // Submit batch via ConsolidationMigrator -> ConsolidationBus
    const submitTx = await consolidationMigrator
      .connect(submitter)
      .submitConsolidationBatch(source.operatorId, target.operatorId, consolidationIndexGroups);
    const submitReceipt = await submitTx.wait();

    // Respect the real execution delay before executing the batch
    const batchHash = calcConsolidationBatchHash(
      sourcePubkeysGroups.map((sourcePubkeys, i) => ({ sourcePubkeys, targetPubkey: targetPubkeys[i] })),
    );
    await waitUntilBatchExecutable(consolidationBus, batchHash);

    // Get fee from real WithdrawalVault
    const { withdrawalVault } = ctx.contracts;
    const fee = await withdrawalVault.getConsolidationRequestFee();
    const totalFee = fee * BigInt(TOTAL_REQUESTS);

    // Execute batch through full stack - build ConsolidationWitnessGroup array
    const consolidationWitnessGroups = sourcePubkeysGroups.map((sourcePubkeys, i) => ({
      sourcePubkeys,
      targetWitness: targetWitnesses[i],
    }));

    const executeTx = await consolidationBus.connect(executor).executeConsolidation(consolidationWitnessGroups, {
      value: totalFee,
    });
    const executeReceipt = await executeTx.wait();

    // Gas assertions
    expect(submitReceipt!.gasUsed).to.be.lessThan(MAX_BLOCK_GAS);
    expect(executeReceipt!.gasUsed).to.be.lessThan(MAX_BLOCK_GAS);

    // Log gas usage
    const submitGas = submitReceipt!.gasUsed;
    const execGas = executeReceipt!.gasUsed;
    const totalGas = submitGas + execGas;
    const perRequest = totalGas / BigInt(TOTAL_REQUESTS);

    console.log(`\n  Gas usage for ${NUM_GROUPS} x ${REQUESTS_PER_GROUP} (${TOTAL_REQUESTS}) requests (NOR -> CMv2):`);
    console.log(`    submitConsolidationBatch: ${Number(submitGas).toLocaleString()}`);
    console.log(`    executeConsolidation:     ${Number(execGas).toLocaleString()}`);
    console.log(`    Total:                    ${Number(totalGas).toLocaleString()}`);
    console.log(`    Per request:              ${Number(perRequest).toLocaleString()}`);
  });
});
