import { expect } from "chai";
import type { ContractTransactionResponse } from "ethers";
import { artifacts, ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationBus, ConsolidationGateway, ConsolidationMigrator, NodeOperatorsRegistry } from "typechain-types";

import { advanceChainTime, EIP7251_ADDRESS, findEventsWithInterfaces } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import {
  assertConsolidationTopology,
  calcConsolidationBatchHash,
  cmv2EnsureDepositedOperatorKeys,
  CMv2OperatorKeys,
  cmv2SuiteEnabled,
  decodeConsolidationRequest,
  ensureBatchNotPending,
  norEnsureDepositedOperatorKeys,
  NorOperatorKeys,
  prepareConsolidationTargetWitnesses,
  waitUntilBatchExecutable,
} from "lib/protocol/helpers";
import { LoadedContract } from "lib/protocol/types";

import { resetState, Snapshot } from "test/suite";

/**
 * Batch limits and multi-batch migration through the full contract stack:
 * ConsolidationMigrator -> ConsolidationBus -> ConsolidationGateway -> WithdrawalVault.
 *
 * The native gas measurement fills the deployed ConsolidationBus batchSize,
 * using the maximum group count and empty EIP-7251 queue slots. Previously used
 * queue slots are cheaper to overwrite and understate the production worst case.
 * Limit rejection and multi-batch flow also run against the scratch EIP-7251 mock.
 */
describe("Integration: Consolidation batch limits and gas (full stack via Migrator)", function () {
  let ctx: ProtocolContext;

  // Deployment is shared and memoized across suites; retain it when restoring
  // this suite's role grants, limits, and other fixture mutations.
  before(async () => {
    ctx = await getProtocolContext();
  });
  resetState(this);
  let nor: LoadedContract<NodeOperatorsRegistry>;
  let consolidationBus: ConsolidationBus;
  let consolidationGateway: ConsolidationGateway;
  let consolidationMigrator: ConsolidationMigrator;

  let submitter: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;

  // Operational headroom below EIP-7825's 2^24 per-transaction cap.
  const TRANSACTION_GAS_BUDGET = 16_000_000n;
  const MIGRATION_REQUESTS = 350;
  const RATE_LIMIT_FRAME_SECONDS = 1n;
  let nativeQueue: boolean;
  let testSnapshot: string;
  let numGroups: number;
  let totalRequests: number;

  let source: NorOperatorKeys;
  let target: CMv2OperatorKeys;

  let sourcePubkeysGroups: string[][];
  let targetPubkeys: string[];
  let consolidationIndexGroups: { sourceKeyIndices: bigint[]; targetKeyIndex: bigint }[];

  before(async function () {
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

    // Exercise both deployed limits: request count and group count.
    const batchSize = await consolidationBus.batchSize();
    totalRequests = Number(batchSize);
    if (ctx.isScratch) expect(totalRequests, "scratch maximum batch size").to.equal(100);
    numGroups = Number(await consolidationBus.maxGroupsInBatch());

    // Scratch nodes can use a Solidity mock with a different storage layout.
    // Its gas cost cannot stand in for the native queue's SSTORE costs.
    // Runtime specified at https://eips.ethereum.org/EIPS/eip-7251#bytecode
    const code = await ethers.provider.getCode(EIP7251_ADDRESS);
    const codeHash = ethers.keccak256(code);
    nativeQueue = [
      "0x78c6cb5202685228bbcbfb992b1c4e116c7ec5ef11e25b8e92716cfc628ddd60",
      // Anvil 1.8.1's blank genesis appends exactly two unreachable STOP bytes
      // to the canonical runtime. The executable code and storage layout match.
      "0xaf54b3a24a530e342bfc2f9f135e77c58588ba05f9fadd81e41b45e1ac403c2c",
    ].includes(codeHash);
    const mock = await artifacts.readArtifact("EIP7251MaxEffectiveBalanceRequest__Mock");
    expect(
      nativeQueue || codeHash === ethers.keccak256(mock.deployedBytecode),
      `Unrecognized EIP-7251 runtime ${codeHash}; review its code and storage layout before measuring or resetting it`,
    ).to.equal(true);

    // =========================================
    // Source keys in NOR, target keys in CMv2 (all really deposited)
    // =========================================
    source = await norEnsureDepositedOperatorKeys(
      ctx,
      nor,
      sourceModuleId,
      BigInt(Math.max(MIGRATION_REQUESTS, totalRequests + 1)),
      {
        name: "gas_test_source_operator",
      },
    );

    target = await cmv2EnsureDepositedOperatorKeys(ctx, BigInt(numGroups), { name: "gas_test_target_operator" });
    targetPubkeys = target.pubkeys;

    const groups = makeGroups(0, totalRequests);
    sourcePubkeysGroups = groups.pubkeys.map((group) => group.sourcePubkeys);
    consolidationIndexGroups = groups.indices;

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
      await consolidationGateway
        .connect(agentSigner)
        .setConsolidationRequestLimit(totalRequests, totalRequests, RATE_LIMIT_FRAME_SECONDS)
    ).wait();

    await advanceChainTime(RATE_LIMIT_FRAME_SECONDS);
  });

  beforeEach(async () => {
    testSnapshot = await Snapshot.take();
  });
  afterEach(async () => {
    if (testSnapshot) await Snapshot.restore(testSnapshot);
  });

  function makeGroups(offset: number, count: number) {
    const groupsCount = Math.min(numGroups, count);
    const indices: { sourceKeyIndices: bigint[]; targetKeyIndex: bigint }[] = [];
    const pubkeys: { sourcePubkeys: string[]; targetPubkey: string }[] = [];
    let position = offset;
    for (let g = 0; g < groupsCount; g++) {
      const size = Math.floor(count / groupsCount) + (g < count % groupsCount ? 1 : 0);
      indices.push({
        sourceKeyIndices: source.keyIndices.slice(position, position + size),
        targetKeyIndex: target.keyIndices[g],
      });
      pubkeys.push({ sourcePubkeys: source.pubkeys.slice(position, position + size), targetPubkey: target.pubkeys[g] });
      position += size;
    }
    return { indices, pubkeys };
  }

  async function withinGasBudget(operation: string, send: () => Promise<ContractTransactionResponse>) {
    try {
      const receipt = await (await send()).wait();
      if (!receipt) throw new Error("No transaction receipt");
      expect(receipt.gasUsed, operation).to.be.lessThan(TRANSACTION_GAS_BUDGET);
      return receipt;
    } catch (cause) {
      throw new Error(
        `${operation} failed with a ${TRANSACTION_GAS_BUDGET} gas limit; inspect the cause for a revert or out-of-gas`,
        { cause },
      );
    }
  }

  async function clearNativeQueue() {
    if (!nativeQueue) return;
    // Canonical EIP-7251: fee/count/head/tail in slots 0..3, then four
    // storage words per request. Do this inside the suite snapshot and before
    // constructing witnesses so RPC time does not consume their validity window.
    for (let start = 0; start < 4 + 4 * totalRequests; start += 32) {
      await Promise.all(
        Array.from({ length: Math.min(32, 4 + 4 * totalRequests - start) }, (_, i) =>
          ethers.provider.send("hardhat_setStorageAt", [
            EIP7251_ADDRESS,
            ethers.toBeHex(start + i, 32),
            ethers.ZeroHash,
          ]),
        ),
      );
    }
  }

  it("should reject a batch exceeding the deployed request limit", async () => {
    await expect(
      consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(source.operatorId, target.operatorId, makeGroups(0, totalRequests + 1).indices),
    )
      .to.be.revertedWithCustomError(consolidationBus, "BatchTooLarge")
      .withArgs(totalRequests + 1, totalRequests);
  });

  it("should execute a deployed-batchSize batch within the transaction gas budget", async function () {
    if (!nativeQueue) {
      console.warn(
        "Consolidation gas measurement requires the canonical EIP-7251 predeploy; skipping the known Solidity mock",
      );
      return this.skip();
    }
    await clearNativeQueue();

    const batchHash = calcConsolidationBatchHash(
      sourcePubkeysGroups.map((sourcePubkeys, i) => ({ sourcePubkeys, targetPubkey: targetPubkeys[i] })),
    );
    // An identical batch may already be pending on a live fork block
    await ensureBatchNotPending(consolidationBus, agentSigner, batchHash);

    const submitReceipt = await withinGasBudget(`submission of ${totalRequests} requests`, () =>
      consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(source.operatorId, target.operatorId, consolidationIndexGroups, {
          gasLimit: TRANSACTION_GAS_BUDGET,
        }),
    );

    await waitUntilBatchExecutable(consolidationBus, batchHash);
    const { witnesses: targetWitnesses } = await prepareConsolidationTargetWitnesses(ctx, targetPubkeys);

    const { withdrawalVault } = ctx.contracts;
    const fee = await withdrawalVault.getConsolidationRequestFee();
    const totalFee = fee * BigInt(totalRequests);

    const consolidationWitnessGroups = sourcePubkeysGroups.map((sourcePubkeys, i) => ({
      sourcePubkeys,
      targetWitness: targetWitnesses[i],
    }));

    const executeReceipt = await withinGasBudget(
      `execution of ${totalRequests} requests with empty EIP-7251 storage`,
      () =>
        consolidationBus.connect(executor).executeConsolidation(consolidationWitnessGroups, {
          value: totalFee,
          gasLimit: TRANSACTION_GAS_BUDGET,
        }),
    );

    // The measurement only counts if every request really reached the WithdrawalVault
    const requestEvents = findEventsWithInterfaces(executeReceipt!, "ConsolidationRequestAdded", [
      withdrawalVault.interface,
    ]);
    expect(requestEvents.length).to.equal(totalRequests);

    const submitGas = submitReceipt!.gasUsed;
    const execGas = executeReceipt!.gasUsed;
    const totalGas = submitGas + execGas;
    const perRequest = totalGas / BigInt(totalRequests);

    console.log(
      `\n  Gas usage for ${numGroups} groups (${totalRequests} requests), empty EIP-7251 queue (NOR -> CMv2):`,
    );
    console.log(`    submitConsolidationBatch: ${Number(submitGas).toLocaleString()}`);
    console.log(`    executeConsolidation:     ${Number(execGas).toLocaleString()}`);
    console.log(`    Total:                    ${Number(totalGas).toLocaleString()}`);
    console.log(`    Per request:              ${Number(perRequest).toLocaleString()}`);
  });
  it("should migrate 350 requests in separate transactions below the gas budget", async () => {
    // Normalize the native queue once. Preserve its evolving fee and storage
    // across batches; only the separate maximum-batch test forces empty slots.
    await clearNativeQueue();
    const batchSizes: number[] = [];
    const executionHashes = new Set<string>();
    const executedSources: string[] = [];
    const batchHashes: string[] = [];
    const { withdrawalVault } = ctx.contracts;

    for (let offset = 0; offset < MIGRATION_REQUESTS; offset += totalRequests) {
      // Replenish the gateway explicitly, independent of client mining timestamps
      // and of the beacon-root witness helper's Anvil workaround.
      if (offset > 0) await advanceChainTime(RATE_LIMIT_FRAME_SECONDS);
      const count = Math.min(totalRequests, MIGRATION_REQUESTS - offset);
      const groups = makeGroups(offset, count);
      const hash = calcConsolidationBatchHash(groups.pubkeys);
      await ensureBatchNotPending(consolidationBus, agentSigner, hash);
      await withinGasBudget(`submission of batch ${batchSizes.length + 1} (${count} requests)`, () =>
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(source.operatorId, target.operatorId, groups.indices, {
            gasLimit: TRANSACTION_GAS_BUDGET,
          }),
      );
      expect((await consolidationBus.getBatchInfo(hash)).publisher).to.equal(await consolidationMigrator.getAddress());

      await waitUntilBatchExecutable(consolidationBus, hash);
      // Rebuild witnesses after each delay, and quote the current queue fee.
      const { witnesses } = await prepareConsolidationTargetWitnesses(
        ctx,
        groups.pubkeys.map((g) => g.targetPubkey),
      );
      const fee = await withdrawalVault.getConsolidationRequestFee();
      const receipt = await withinGasBudget(`execution of batch ${batchSizes.length + 1} (${count} requests)`, () =>
        consolidationBus.connect(executor).executeConsolidation(
          groups.pubkeys.map((group, i) => ({ sourcePubkeys: group.sourcePubkeys, targetWitness: witnesses[i] })),
          { value: fee * BigInt(count), gasLimit: TRANSACTION_GAS_BUDGET },
        ),
      );
      const requests = findEventsWithInterfaces(receipt!, "ConsolidationRequestAdded", [withdrawalVault.interface]).map(
        (event) => decodeConsolidationRequest(event.args.request),
      );
      expect(requests).to.deep.equal(
        groups.pubkeys.flatMap((group) =>
          group.sourcePubkeys.map((sourcePubkey) => ({
            sourcePubkey: sourcePubkey.toLowerCase(),
            targetPubkey: group.targetPubkey.toLowerCase(),
          })),
        ),
      );
      executedSources.push(...requests.map((request) => request.sourcePubkey));
      expect((await consolidationBus.getBatchInfo(hash)).publisher).to.equal(ethers.ZeroAddress);
      executionHashes.add(receipt.hash);
      batchHashes.push(hash);
      batchSizes.push(count);
      console.log(`    Batch ${batchSizes.length}: ${count} requests, execution gas ${receipt!.gasUsed}`);
    }

    expect(executedSources).to.deep.equal(
      source.pubkeys.slice(0, MIGRATION_REQUESTS).map((pubkey) => pubkey.toLowerCase()),
    );
    expect(new Set(executedSources).size).to.equal(MIGRATION_REQUESTS);
    expect(executionHashes.size).to.equal(batchSizes.length);
    expect(new Set(batchHashes).size).to.equal(batchSizes.length);
    if (ctx.isScratch) expect(batchSizes).to.deep.equal([100, 100, 100, 50]);
  });
});
