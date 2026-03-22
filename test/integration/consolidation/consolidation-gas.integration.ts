import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationBus, ConsolidationGateway, ConsolidationMigrator, NodeOperatorsRegistry } from "typechain-types";

import { addressToWC, certainAddress } from "lib";
import { LocalMerkleTree, prepareLocalMerkleTree } from "lib/pdg";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import {
  depositAndReportValidators,
  norSdvtAddNodeOperator,
  norSdvtAddOperatorKeys,
  norSdvtSetOperatorStakingLimit,
} from "lib/protocol/helpers";
import { NOR_MODULE_ID } from "lib/protocol/helpers/staking-module";
import { LoadedContract } from "lib/protocol/types";

import { Snapshot } from "test/suite";

/**
 * Gas measurement integration test for consolidation (full stack, no mocks).
 * Uses: ConsolidationMigrator → ConsolidationBus → ConsolidationGateway → WithdrawalVault
 *
 * Results for batch of 5 x 63 requests:
 * ┌──────────────────────────┬─────────────┐
 * │ Operation                │ Gas         │
 * ├──────────────────────────┼─────────────┤
 * │ submitConsolidationBatch │ 7,941,893   │
 * │ executeConsolidation     │ 6,463,147   │
 * │ Total                    │ 14,405,040  │
 * │ Per request              │ 45,730      │
 * └──────────────────────────┴─────────────┘
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

  let sourceOperatorId: bigint;
  let targetOperatorId: bigint;

  // Source pubkeys grouped: 5 groups × 63 pubkeys
  let sourcePubkeysGroups: string[][];
  // Target pubkeys: 5
  let targetPubkeys: string[];

  // Key indices for submitConsolidationBatch
  let sourceKeyIndicesGroups: bigint[][];
  let targetKeyIndices: bigint[];

  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();

    // Take snapshot before any modifications to restore clean state for other tests
    originalState = await Snapshot.take();

    [, submitter, executor] = await ethers.getSigners();

    nor = ctx.contracts.nor;
    consolidationBus = ctx.contracts.consolidationBus;
    consolidationGateway = ctx.contracts.consolidationGateway;
    consolidationMigrator = ctx.contracts.consolidationMigrator;

    const agentSigner = await ctx.getSigner("agent");

    // =========================================
    // Deposit all existing depositable validators first to clear them
    // =========================================
    const { stakingRouter } = ctx.contracts;
    const existingDepositable = await stakingRouter.getStakingModuleMaxDepositsCount(
      NOR_MODULE_ID,
      await ctx.contracts.lido.getDepositableEther(),
    );
    if (existingDepositable > 0n) {
      const DEPOSIT_BATCH = 50n;
      for (let deposited = 0n; deposited < existingDepositable; deposited += DEPOSIT_BATCH) {
        const batch = deposited + DEPOSIT_BATCH > existingDepositable ? existingDepositable - deposited : DEPOSIT_BATCH;
        await depositAndReportValidators(ctx, NOR_MODULE_ID, batch);
      }
    }

    // =========================================
    // Setup source operator with deposited keys
    // =========================================
    sourceOperatorId = await norSdvtAddNodeOperator(ctx, nor, {
      name: "gas_test_source_operator",
      rewardAddress: certainAddress("gas:source:reward"),
    });

    // Add keys in batches to avoid exceeding block gas limit
    const KEYS_BATCH = 100n;
    for (let added = 0n; added < TOTAL_SOURCE_KEYS; added += KEYS_BATCH) {
      const batch = added + KEYS_BATCH > TOTAL_SOURCE_KEYS ? TOTAL_SOURCE_KEYS - added : KEYS_BATCH;
      await norSdvtAddOperatorKeys(ctx, nor, {
        operatorId: sourceOperatorId,
        keysToAdd: batch,
      });
    }

    await norSdvtSetOperatorStakingLimit(ctx, nor, {
      operatorId: sourceOperatorId,
      limit: TOTAL_SOURCE_KEYS,
    });

    // Deposit source keys in batches
    const DEPOSIT_BATCH = 50n;
    for (let deposited = 0n; deposited < TOTAL_SOURCE_KEYS; deposited += DEPOSIT_BATCH) {
      const batch = deposited + DEPOSIT_BATCH > TOTAL_SOURCE_KEYS ? TOTAL_SOURCE_KEYS - deposited : DEPOSIT_BATCH;
      await depositAndReportValidators(ctx, NOR_MODULE_ID, batch);
    }

    // =========================================
    // Setup target operator with deposited keys
    // =========================================
    targetOperatorId = await norSdvtAddNodeOperator(ctx, nor, {
      name: "gas_test_target_operator",
      rewardAddress: certainAddress("gas:target:reward"),
    });

    await norSdvtAddOperatorKeys(ctx, nor, {
      operatorId: targetOperatorId,
      keysToAdd: TOTAL_TARGET_KEYS,
    });

    await norSdvtSetOperatorStakingLimit(ctx, nor, {
      operatorId: targetOperatorId,
      limit: TOTAL_TARGET_KEYS,
    });

    await depositAndReportValidators(ctx, NOR_MODULE_ID, TOTAL_TARGET_KEYS);

    // =========================================
    // Retrieve pubkeys from NOR
    // =========================================
    sourcePubkeysGroups = [];
    sourceKeyIndicesGroups = [];
    for (let g = 0; g < NUM_GROUPS; g++) {
      const group: string[] = [];
      const indices: bigint[] = [];
      for (let r = 0; r < REQUESTS_PER_GROUP; r++) {
        const keyIndex = g * REQUESTS_PER_GROUP + r;
        const key = await nor.getSigningKey(sourceOperatorId, keyIndex);
        expect(key.used).to.be.true;
        group.push(key.key);
        indices.push(BigInt(keyIndex));
      }
      sourcePubkeysGroups.push(group);
      sourceKeyIndicesGroups.push(indices);
    }

    targetPubkeys = [];
    targetKeyIndices = [];
    for (let t = 0; t < NUM_GROUPS; t++) {
      const key = await nor.getSigningKey(targetOperatorId, t);
      expect(key.used).to.be.true;
      targetPubkeys.push(key.key);
      targetKeyIndices.push(BigInt(t));
    }

    // =========================================
    // Setup roles and limits
    // =========================================

    // Allow pair in ConsolidationMigrator
    const ALLOW_PAIR_ROLE = await consolidationMigrator.ALLOW_PAIR_ROLE();
    await consolidationMigrator.connect(agentSigner).grantRole(ALLOW_PAIR_ROLE, agentSigner.address);
    await consolidationMigrator.connect(agentSigner).allowPair(sourceOperatorId, targetOperatorId, submitter.address);

    // Increase ConsolidationBus batch size to accommodate 315 requests in 5 groups
    const MANAGE_ROLE = await consolidationBus.MANAGE_ROLE();
    await consolidationBus.connect(agentSigner).grantRole(MANAGE_ROLE, agentSigner.address);
    await consolidationBus.connect(agentSigner).setBatchSize(TOTAL_REQUESTS);

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

    // Submit batch via ConsolidationMigrator → ConsolidationBus
    const submitTx = await consolidationMigrator
      .connect(submitter)
      .submitConsolidationBatch(sourceOperatorId, targetOperatorId, sourceKeyIndicesGroups, targetKeyIndices);
    const submitReceipt = await submitTx.wait();

    // Get fee from real WithdrawalVault
    const { withdrawalVault } = ctx.contracts;
    const fee = await withdrawalVault.getConsolidationRequestFee();
    const totalFee = fee * BigInt(TOTAL_REQUESTS);

    // Execute batch through full stack
    const executeTx = await consolidationBus
      .connect(executor)
      .executeConsolidation(sourcePubkeysGroups, targetWitnesses, {
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

    console.log(`\n  Gas usage for ${NUM_GROUPS} x ${REQUESTS_PER_GROUP} (${TOTAL_REQUESTS}) requests:`);
    console.log(`    submitConsolidationBatch: ${Number(submitGas).toLocaleString()}`);
    console.log(`    executeConsolidation:     ${Number(execGas).toLocaleString()}`);
    console.log(`    Total:                    ${Number(totalGas).toLocaleString()}`);
    console.log(`    Per request:              ${Number(perRequest).toLocaleString()}`);
  });
});
