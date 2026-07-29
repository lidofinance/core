import { expect } from "chai";
import hre from "hardhat";

import type { HardhatEthers, HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import {
  type ConsolidationBus,
  type ConsolidationGateway,
  type ConsolidationMigrator,
  type NodeOperatorsRegistry,
} from "typechain-types/index.js";

import { EIP7251_MIN_CONSOLIDATION_FEE, findEventsWithInterfaces, normalizeEIP7251Excess } from "#lib";
import { getProtocolContext, type ProtocolContext } from "#lib/protocol";
import {
  assertConsolidationTopology,
  calcConsolidationBatchHash,
  cmv2EnsureDepositedOperatorKeys,
  type CMv2OperatorKeys,
  cmv2SuiteEnabled,
  ensureBatchNotPending,
  norEnsureDepositedOperatorKeys,
  type NorOperatorKeys,
  prepareConsolidationTargetWitnesses,
  waitUntilBatchExecutable,
} from "#lib/protocol/helpers";
import { type LoadedContract } from "lib/protocol/types.js";

import { Snapshot } from "#test/suite";

/**
 * Gas measurement for a full consolidation batch (no mocks):
 * ConsolidationMigrator -> ConsolidationBus -> ConsolidationGateway -> WithdrawalVault.
 *
 * The batch fills the deployed ConsolidationBus batchSize (the production worst case),
 * grouped into NUM_GROUPS source groups targeting real deposited CMv2 keys.
 */
describe("Integration: Consolidation gas measurement (full stack via Migrator)", () => {
  let ethers: HardhatEthers;

  let ctx: ProtocolContext;
  let nor: LoadedContract<NodeOperatorsRegistry>;
  let consolidationBus: ConsolidationBus;
  let consolidationGateway: ConsolidationGateway;
  let consolidationMigrator: ConsolidationMigrator;

  let submitter: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;

  const MAX_BLOCK_GAS = 16_000_000n;
  const NUM_GROUPS = 5;

  let requestsPerGroup: number;
  let totalRequests: number;

  let source: NorOperatorKeys;
  let target: CMv2OperatorKeys;

  let sourcePubkeysGroups: string[][];
  let targetPubkeys: string[];
  let consolidationIndexGroups: { sourceKeyIndices: bigint[]; targetKeyIndex: bigint }[];

  let originalState: string;

  before(async function () {
    ({ ethers } = await hre.network.getOrCreate());

    ctx = await getProtocolContext();

    originalState = await Snapshot.take();

    if (!cmv2SuiteEnabled(ctx, "the consolidation gas suite")) {
      return this.skip();
    }

    [, submitter, executor] = await ethers.getSigners();

    nor = ctx.contracts.nor;
    consolidationBus = ctx.contracts.consolidationBus;
    consolidationGateway = ctx.contracts.consolidationGateway;
    consolidationMigrator = ctx.contracts.consolidationMigrator;

    // Pin the topology before measuring anything, so the gas figures can never
    // silently come from a different module pair
    const { sourceModuleId } = await assertConsolidationTopology(ctx);

    agentSigner = await ctx.getSigner("agent");

    // Measure the production worst case: the deployed batch size limit
    const batchSize = await consolidationBus.batchSize();
    requestsPerGroup = Number(batchSize / BigInt(NUM_GROUPS));
    totalRequests = requestsPerGroup * NUM_GROUPS;

    // The fork-frozen EIP-7251 excess sets an arbitrary exponential fee; normalize it
    // (scratch runs a 1-wei-fee mock at the address, which needs no normalization)
    if ((await ctx.contracts.withdrawalVault.getConsolidationRequestFee()) > EIP7251_MIN_CONSOLIDATION_FEE) {
      await normalizeEIP7251Excess();
    }

    // =========================================
    // Source keys in NOR, target keys in CMv2 (all really deposited)
    // =========================================
    source = await norEnsureDepositedOperatorKeys(ctx, nor, sourceModuleId, BigInt(totalRequests), {
      name: "gas_test_source_operator",
    });

    target = await cmv2EnsureDepositedOperatorKeys(ctx, BigInt(NUM_GROUPS), { name: "gas_test_target_operator" });
    targetPubkeys = target.pubkeys;

    sourcePubkeysGroups = [];
    consolidationIndexGroups = [];
    for (let g = 0; g < NUM_GROUPS; g++) {
      const group: string[] = [];
      const indices: bigint[] = [];
      for (let r = 0; r < requestsPerGroup; r++) {
        const position = g * requestsPerGroup + r;
        group.push(source.pubkeys[position]);
        indices.push(source.keyIndices[position]);
      }
      sourcePubkeysGroups.push(group);
      consolidationIndexGroups.push({ sourceKeyIndices: indices, targetKeyIndex: target.keyIndices[g] });
    }

    // =========================================
    // Roles and limits
    // =========================================

    const ALLOW_PAIR_ROLE = await consolidationMigrator.ALLOW_PAIR_ROLE();
    await consolidationMigrator.connect(agentSigner).grantRole(ALLOW_PAIR_ROLE, agentSigner.address);
    await consolidationMigrator.connect(agentSigner).allowPair(source.operatorId, target.operatorId, submitter.address);

    const REMOVE_ROLE = await consolidationBus.REMOVE_ROLE();
    await consolidationBus.connect(agentSigner).grantRole(REMOVE_ROLE, agentSigner.address);

    // Normalize the gateway rate limit so it never bounds the measurement
    const EXIT_LIMIT_MANAGER_ROLE = await consolidationGateway.EXIT_LIMIT_MANAGER_ROLE();
    await (
      await consolidationGateway.connect(agentSigner).grantRole(EXIT_LIMIT_MANAGER_ROLE, agentSigner.address)
    ).wait();
    await (
      await consolidationGateway.connect(agentSigner).setConsolidationRequestLimit(totalRequests, totalRequests, 1)
    ).wait();

    await ethers.provider.send("evm_increaseTime", [1]);
    await ethers.provider.send("evm_mine", []);
  });

  after(async () => await Snapshot.restore(originalState));

  it("should execute a deployed-batchSize batch within the block gas limit", async () => {
    const { witnesses: targetWitnesses } = await prepareConsolidationTargetWitnesses(ctx, targetPubkeys);

    const batchHash = calcConsolidationBatchHash(
      sourcePubkeysGroups.map((sourcePubkeys, i) => ({ sourcePubkeys, targetPubkey: targetPubkeys[i] })),
    );
    // An identical batch may already be pending on a live fork block
    await ensureBatchNotPending(consolidationBus, agentSigner, batchHash);

    const submitTx = await consolidationMigrator
      .connect(submitter)
      .submitConsolidationBatch(source.operatorId, target.operatorId, consolidationIndexGroups);
    const submitReceipt = await submitTx.wait();

    await waitUntilBatchExecutable(consolidationBus, batchHash);

    const { withdrawalVault } = ctx.contracts;
    const fee = await withdrawalVault.getConsolidationRequestFee();
    const totalFee = fee * BigInt(totalRequests);

    const consolidationWitnessGroups = sourcePubkeysGroups.map((sourcePubkeys, i) => ({
      sourcePubkeys,
      targetWitness: targetWitnesses[i],
    }));

    const executeTx = await consolidationBus.connect(executor).executeConsolidation(consolidationWitnessGroups, {
      value: totalFee,
    });
    const executeReceipt = await executeTx.wait();

    // The measurement only counts if every request really reached the WithdrawalVault
    const requestEvents = findEventsWithInterfaces(executeReceipt!, "ConsolidationRequestAdded", [
      withdrawalVault.interface,
    ]);
    expect(requestEvents.length).to.equal(totalRequests);

    expect(submitReceipt!.gasUsed).to.be.lessThan(MAX_BLOCK_GAS);
    expect(executeReceipt!.gasUsed).to.be.lessThan(MAX_BLOCK_GAS);

    const submitGas = submitReceipt!.gasUsed;
    const execGas = executeReceipt!.gasUsed;
    const totalGas = submitGas + execGas;
    const perRequest = totalGas / BigInt(totalRequests);

    console.log(`\n  Gas usage for ${NUM_GROUPS} x ${requestsPerGroup} (${totalRequests}) requests (NOR -> CMv2):`);
    console.log(`    submitConsolidationBatch: ${Number(submitGas).toLocaleString()}`);
    console.log(`    executeConsolidation:     ${Number(execGas).toLocaleString()}`);
    console.log(`    Total:                    ${Number(totalGas).toLocaleString()}`);
    console.log(`    Per request:              ${Number(perRequest).toLocaleString()}`);
  });
});
