import { expect } from "chai";
import hre from "hardhat";

import type { HardhatEthers, HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import {
  type ConsolidationBus,
  type ConsolidationGateway,
  type ConsolidationMigrator,
  type NodeOperatorsRegistry,
} from "typechain-types/index.js";

import { certainAddress, findEventsWithInterfaces } from "#lib";
import { getProtocolContext, type ProtocolContext } from "#lib/protocol";
import {
  assertConsolidationTopology,
  calcConsolidationBatchHash,
  cmv2CreateOperatorWithKeys,
  cmv2EnsureDepositedOperatorKeys,
  type CMv2OperatorKeys,
  cmv2SuiteEnabled,
  type ConsolidationWitnessSet,
  decodeConsolidationRequest,
  ensureBatchNotPending,
  norEnsureDepositedOperatorKeys,
  type NorOperatorKeys,
  norSdvtAddNodeOperator,
  norSdvtAddOperatorKeys,
  norSdvtSetOperatorStakingLimit,
  prepareConsolidationTargetWitnesses,
  waitUntilBatchExecutable,
} from "#lib/protocol/helpers";
import { type LoadedContract } from "lib/protocol/types.js";

import { Snapshot } from "#test/suite";

const fakeWitnessForTarget = (pubkey: string) => ({
  proof: [],
  pubkey,
  validatorIndex: 0,
  childBlockTimestamp: 0,
  slot: 0,
  proposerIndex: 0,
});

/**
 * Integration test for the full consolidation migration flow over the real production
 * topology: source keys in NOR, target keys in CMv2 (curated-onchain-v2).
 *
 * The flow tested:
 * 1. ConsolidationMigrator validates source (NOR) / target (CMv2) keys and submits to ConsolidationBus
 * 2. ConsolidationBus stores the batch for later execution
 * 3. After the execution delay passes, executor calls executeConsolidation on ConsolidationBus
 * 4. ConsolidationBus forwards to ConsolidationGateway
 * 5. ConsolidationGateway forwards to WithdrawalVault
 * 6. WithdrawalVault processes EIP-7251 consolidation requests
 *
 * The suite requires a CMv2 module in the StakingRouter that matches the migrator's
 * immutable targetModuleId. When CMv2 is unavailable the suite fails loudly; skipping
 * is allowed only via the explicit INTEGRATION_WITH_CMv2=off opt-out.
 */
describe("Integration: Consolidation Migration Flow (Real NOR -> Real CMv2)", () => {
  let ethers: HardhatEthers;

  let ctx: ProtocolContext;
  let nor: LoadedContract<NodeOperatorsRegistry>;
  let consolidationGateway: ConsolidationGateway;
  let consolidationBus: ConsolidationBus;
  let consolidationMigrator: ConsolidationMigrator;

  let executor: HardhatEthersSigner;
  let submitter: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let sourceModuleId: bigint;
  let targetModuleId: bigint;

  let source: NorOperatorKeys;
  let target: CMv2OperatorKeys;

  let sourceOperatorId: bigint;
  let targetOperatorId: bigint;

  let SOURCE_PUBKEY_1: string;
  let SOURCE_PUBKEY_2: string;
  let TARGET_PUBKEY_1: string;
  let TARGET_PUBKEY_2: string;

  let witnessSet: ConsolidationWitnessSet;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let targetWitness1: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let targetWitness2: any;

  let agentSigner: HardhatEthersSigner;

  let globalSnapshot: string;
  let testSnapshot: string;

  before(async function () {
    ({ ethers } = await hre.network.getOrCreate());

    ctx = await getProtocolContext();

    globalSnapshot = await Snapshot.take();

    if (!cmv2SuiteEnabled(ctx, "the consolidation migration suite")) {
      return this.skip();
    }

    [, executor, submitter, stranger] = await ethers.getSigners();

    // Get real contracts from protocol context
    nor = ctx.contracts.nor;
    consolidationGateway = ctx.contracts.consolidationGateway;
    consolidationBus = ctx.contracts.consolidationBus;
    consolidationMigrator = ctx.contracts.consolidationMigrator;

    ({ sourceModuleId, targetModuleId } = await assertConsolidationTopology(ctx));

    agentSigner = await ctx.getSigner("agent");

    // =========================================
    // Source: NOR operator with deposited keys
    // =========================================

    source = await norEnsureDepositedOperatorKeys(ctx, nor, sourceModuleId, 2n, {
      name: "consolidation_source_operator",
    });
    sourceOperatorId = source.operatorId;
    [SOURCE_PUBKEY_1, SOURCE_PUBKEY_2] = source.pubkeys;

    // =========================================
    // Target: CMv2 operator with deposited keys (active validators)
    // Per EIP-7251, consolidation can only happen TO deposited validators;
    // activity on CL is proven later by the witness check in the Gateway
    // =========================================

    target = await cmv2EnsureDepositedOperatorKeys(ctx, 2n, { name: "consolidation_target_operator" });
    targetOperatorId = target.operatorId;
    [TARGET_PUBKEY_1, TARGET_PUBKEY_2] = target.pubkeys;

    // =========================================
    // CL proof witnesses for the target keys (tree parameters come from the deployed
    // ConsolidationGateway verifier)
    // =========================================
    witnessSet = await prepareConsolidationTargetWitnesses(ctx, [TARGET_PUBKEY_1, TARGET_PUBKEY_2]);
    [targetWitness1, targetWitness2] = witnessSet.witnesses;

    // =========================================
    // Setup roles
    // =========================================

    // Grant MANAGE_ROLE on ConsolidationBus to agent (for batch management tests)
    const MANAGE_ROLE = await consolidationBus.MANAGE_ROLE();
    const REMOVE_ROLE = await consolidationBus.REMOVE_ROLE();
    await consolidationBus.connect(agentSigner).grantRole(MANAGE_ROLE, agentSigner.address);
    await consolidationBus.connect(agentSigner).grantRole(REMOVE_ROLE, agentSigner.address);

    // Grant ALLOW_PAIR_ROLE and DISALLOW_PAIR_ROLE on ConsolidationMigrator to agent
    const ALLOW_PAIR_ROLE = await consolidationMigrator.ALLOW_PAIR_ROLE();
    const DISALLOW_PAIR_ROLE = await consolidationMigrator.DISALLOW_PAIR_ROLE();
    await consolidationMigrator.connect(agentSigner).grantRole(ALLOW_PAIR_ROLE, agentSigner.address);
    await consolidationMigrator.connect(agentSigner).grantRole(DISALLOW_PAIR_ROLE, agentSigner.address);

    // Allow the consolidation pair with submitter
    await consolidationMigrator.connect(agentSigner).allowPair(sourceOperatorId, targetOperatorId, submitter.address);
  });

  after(async () => await Snapshot.restore(globalSnapshot));

  beforeEach(async () => {
    testSnapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(testSnapshot));

  /** Map key-index groups back to the pubkey groups the bus hashes. */
  const pubkeysForGroups = (groups: { sourceKeyIndices: bigint[]; targetKeyIndex: bigint }[]) =>
    groups.map((g) => ({
      sourcePubkeys: g.sourceKeyIndices.map((ki) => source.pubkeys[source.keyIndices.indexOf(ki)]),
      targetPubkey: target.pubkeys[target.keyIndices.indexOf(g.targetKeyIndex)],
    }));

  /**
   * Submit a batch of source/target key-index groups through the migrator.
   * The key-reuse helpers return real on-chain pubkeys, so an identical batch may
   * already be pending on a live fork block; remove it first.
   */
  const submitBatch = async (groups: { sourceKeyIndices: bigint[]; targetKeyIndex: bigint }[]) => {
    if (groups.length > 0 && groups.every((g) => g.sourceKeyIndices.length > 0)) {
      await ensureBatchNotPending(consolidationBus, agentSigner, calcConsolidationBatchHash(pubkeysForGroups(groups)));
    }
    return consolidationMigrator
      .connect(submitter)
      .submitConsolidationBatch(sourceOperatorId, targetOperatorId, groups);
  };

  /** Map local 0-based key positions to real module key indices/pubkeys. */
  const sourceGroup = (sourcePositions: number[], targetPosition: number) => ({
    sourceKeyIndices: sourcePositions.map((p) => source.keyIndices[p]),
    targetKeyIndex: target.keyIndices[targetPosition],
  });

  const pubkeyGroup = (sourcePositions: number[], targetPosition: number) => ({
    sourcePubkeys: sourcePositions.map((p) => source.pubkeys[p]),
    targetPubkey: target.pubkeys[targetPosition],
  });

  context("Full consolidation flow (NOR -> CMv2)", () => {
    it("Should successfully complete the full consolidation flow with single validator", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Single validator consolidation
      await submitBatch([sourceGroup([0], 0)]);
      await waitUntilBatchExecutable(consolidationBus, calcConsolidationBatchHash([pubkeyGroup([0], 0)]));

      const fee = await withdrawalVault.getConsolidationRequestFee();

      const tx = await consolidationBus
        .connect(executor)
        .executeConsolidation([{ sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: targetWitness1 }], {
          value: fee,
        });

      const receipt = await tx.wait();
      const consolidationEvents = findEventsWithInterfaces(receipt!, "ConsolidationRequestAdded", [
        withdrawalVault.interface,
      ]);

      // The request payload is packed (sourcePubkey, targetPubkey): verify the exact
      // pair reached the WithdrawalVault, not just that some request was added
      expect(consolidationEvents.map((e) => decodeConsolidationRequest(e.args.request))).to.deep.equal([
        { sourcePubkey: SOURCE_PUBKEY_1.toLowerCase(), targetPubkey: TARGET_PUBKEY_1.toLowerCase() },
      ]);
    });

    it("Should successfully complete the full consolidation flow with multiple validators", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Step 1: Operator submits consolidation batch via ConsolidationMigrator
      const groups = [sourceGroup([0], 0), sourceGroup([1], 1)];

      await expect(submitBatch(groups))
        .to.emit(consolidationMigrator, "ConsolidationSubmitted")
        .withArgs(
          sourceOperatorId,
          targetOperatorId,
          groups.map((g) => [g.sourceKeyIndices, g.targetKeyIndex]),
        );

      // Step 2: Verify batch is stored in ConsolidationBus
      const batchHash = calcConsolidationBatchHash([pubkeyGroup([0], 0), pubkeyGroup([1], 1)]);
      expect((await consolidationBus.getBatchInfo(batchHash)).publisher).to.equal(
        await consolidationMigrator.getAddress(),
      );

      // Step 3: After the execution delay, executor calls executeConsolidation
      await waitUntilBatchExecutable(consolidationBus, batchHash);

      const fee = await withdrawalVault.getConsolidationRequestFee();
      const totalFee = fee * BigInt(groups.length);

      // Normalize the live rate-limit state: the exact-delta assertion below only
      // holds when the limit is at max, so per-frame replenishment cannot interfere
      const EXIT_LIMIT_MANAGER_ROLE = await consolidationGateway.EXIT_LIMIT_MANAGER_ROLE();
      await consolidationGateway.connect(agentSigner).grantRole(EXIT_LIMIT_MANAGER_ROLE, agentSigner.address);
      await consolidationGateway.connect(agentSigner).setConsolidationRequestLimit(100, 100, 86400);

      const initialLimit = (await consolidationGateway.getConsolidationRequestLimitFullInfo())
        .currentConsolidationRequestsLimit;
      expect(initialLimit).to.equal(100n);

      const tx = await consolidationBus.connect(executor).executeConsolidation(
        [
          { sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: targetWitness1 },
          { sourcePubkeys: [SOURCE_PUBKEY_2], targetWitness: targetWitness2 },
        ],
        {
          value: totalFee,
        },
      );

      // Step 4: Verify batch is removed from storage after execution
      expect((await consolidationBus.getBatchInfo(batchHash)).publisher).to.equal(ethers.ZeroAddress);

      // Step 5: Verify ConsolidationGateway rate limit was consumed
      const finalLimit = (await consolidationGateway.getConsolidationRequestLimitFullInfo())
        .currentConsolidationRequestsLimit;
      expect(finalLimit).to.equal(initialLimit - BigInt(groups.length));

      // Step 6: Verify the exact source/target pairs reached WithdrawalVault
      const receipt = await tx.wait();
      expect(receipt).not.to.be.null;

      const consolidationEvents = findEventsWithInterfaces(receipt!, "ConsolidationRequestAdded", [
        withdrawalVault.interface,
      ]);
      expect(consolidationEvents.map((e) => decodeConsolidationRequest(e.args.request))).to.deep.equal([
        { sourcePubkey: SOURCE_PUBKEY_1.toLowerCase(), targetPubkey: TARGET_PUBKEY_1.toLowerCase() },
        { sourcePubkey: SOURCE_PUBKEY_2.toLowerCase(), targetPubkey: TARGET_PUBKEY_2.toLowerCase() },
      ]);
    });

    it("Should revert submitConsolidationBatch if caller is not the designated submitter", async () => {
      await expect(
        consolidationMigrator
          .connect(stranger)
          .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [sourceGroup([0], 0)]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(stranger.address, sourceOperatorId, targetOperatorId);
    });

    it("Should revert submitConsolidationBatch if pair is not allowed (no submitter set)", async () => {
      const unknownTargetOpId = 999_999n;

      // When pair is not allowed, there's no submitter set (address(0))
      // So caller will fail authorization check first
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, unknownTargetOpId, [sourceGroup([0], 0)]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(submitter.address, sourceOperatorId, unknownTargetOpId);
    });

    it("Should revert executeConsolidation if batch not found", async () => {
      const fakePubkey = "0x" + "ff".repeat(48);

      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation([{ sourcePubkeys: [fakePubkey], targetWitness: fakeWitnessForTarget(fakePubkey) }], {
            value: 1n,
          }),
      ).to.be.revertedWithCustomError(consolidationBus, "BatchNotFound");
    });

    it("Should revert executeConsolidation if zero fee is sent", async () => {
      // Submit batch first
      await submitBatch([sourceGroup([0], 0)]);
      await waitUntilBatchExecutable(consolidationBus, calcConsolidationBatchHash([pubkeyGroup([0], 0)]));

      // Zero value is rejected by ConsolidationGateway before the fee check
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation([{ sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: targetWitness1 }], {
            value: 0n,
          }),
      )
        .to.be.revertedWithCustomError(consolidationGateway, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("Should revert executeConsolidation if insufficient fee", async () => {
      // Two requests make the total fee at least 2 wei, so 1 wei is always insufficient
      await submitBatch([sourceGroup([0], 0), sourceGroup([1], 1)]);
      await waitUntilBatchExecutable(
        consolidationBus,
        calcConsolidationBatchHash([pubkeyGroup([0], 0), pubkeyGroup([1], 1)]),
      );

      // ConsolidationGateway checks the fee before forwarding to WithdrawalVault
      await expect(
        consolidationBus.connect(executor).executeConsolidation(
          [
            { sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: targetWitness1 },
            { sourcePubkeys: [SOURCE_PUBKEY_2], targetWitness: targetWitness2 },
          ],
          {
            value: 1n,
          },
        ),
      ).to.be.revertedWithCustomError(consolidationGateway, "InsufficientFee");
    });

    it("Should revert executeConsolidation if batch already executed", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Submit batch
      await submitBatch([sourceGroup([0], 0)]);
      await waitUntilBatchExecutable(consolidationBus, calcConsolidationBatchHash([pubkeyGroup([0], 0)]));

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Execute first time
      await consolidationBus
        .connect(executor)
        .executeConsolidation([{ sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: targetWitness1 }], {
          value: fee,
        });

      // Try to execute again
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(
            [{ sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: fakeWitnessForTarget(TARGET_PUBKEY_1) }],
            {
              value: fee,
            },
          ),
      ).to.be.revertedWithCustomError(consolidationBus, "BatchNotFound");
    });

    it("Should revert executeConsolidation before the execution delay passes", async () => {
      // Scratch deploys use a zero delay; normalize to the production value so the
      // delay path is exercised on every setup instead of being skipped
      if ((await consolidationBus.executionDelay()) === 0n) {
        await consolidationBus.connect(agentSigner).setExecutionDelay(86400);
      }

      const { withdrawalVault } = ctx.contracts;

      await submitBatch([sourceGroup([0], 0)]);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation([{ sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: targetWitness1 }], {
            value: fee,
          }),
      ).to.be.revertedWithCustomError(consolidationBus, "ExecutionDelayNotPassed");
    });
  });

  context("Batch management", () => {
    it("Should allow manager to remove a pending batch", async () => {
      // Submit batch
      await submitBatch([sourceGroup([0], 0)]);

      const batchHash = calcConsolidationBatchHash([pubkeyGroup([0], 0)]);

      expect((await consolidationBus.getBatchInfo(batchHash)).publisher).to.not.equal(ethers.ZeroAddress);

      // Manager removes the batch
      await consolidationBus.connect(agentSigner).removeBatches([batchHash]);

      expect((await consolidationBus.getBatchInfo(batchHash)).publisher).to.equal(ethers.ZeroAddress);
    });
  });

  context("Allowlist management", () => {
    it("Should allow disallowing a pair after submission", async () => {
      // Submit a batch
      await submitBatch([sourceGroup([0], 0)]);

      // Disallow the pair
      await consolidationMigrator.connect(agentSigner).disallowPair(sourceOperatorId, targetOperatorId);

      // Verify new submissions are blocked (submitter is cleared, so NotAuthorized is thrown)
      await expect(submitBatch([sourceGroup([1], 1)]))
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(submitter.address, sourceOperatorId, targetOperatorId);

      // But existing batch can still be executed
      const { withdrawalVault } = ctx.contracts;
      const fee = await withdrawalVault.getConsolidationRequestFee();

      await waitUntilBatchExecutable(consolidationBus, calcConsolidationBatchHash([pubkeyGroup([0], 0)]));

      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation([{ sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: targetWitness1 }], {
            value: fee,
          }),
      ).to.not.be.revert(ethers);
    });

    it("Should allow one source operator to consolidate to multiple targets", async () => {
      const { withdrawalVault } = ctx.contracts;
      // Set up a second CMv2 target operator with deposited validators
      const target2 = await cmv2EnsureDepositedOperatorKeys(ctx, 1n, {
        name: "consolidation_target_operator_2",
        excludeOperatorIds: [targetOperatorId],
      });
      const TARGET_PUBKEY_3 = target2.pubkeys[0];

      const targetWitness3 = await witnessSet.addTargetWitness(TARGET_PUBKEY_3);

      // Allow second pair with the same submitter
      await consolidationMigrator
        .connect(agentSigner)
        .allowPair(sourceOperatorId, target2.operatorId, submitter.address);

      // Submit batch to first target
      await submitBatch([sourceGroup([0], 0)]);

      // Submit batch to second target
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, target2.operatorId, [
          { sourceKeyIndices: [source.keyIndices[1]], targetKeyIndex: target2.keyIndices[0] },
        ]);

      // Both batches were submitted before a single delay wait; execute them back to back
      await waitUntilBatchExecutable(
        consolidationBus,
        calcConsolidationBatchHash([{ sourcePubkeys: [SOURCE_PUBKEY_2], targetPubkey: TARGET_PUBKEY_3 }]),
      );

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Execute both batches
      await consolidationBus
        .connect(executor)
        .executeConsolidation([{ sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: targetWitness1 }], {
          value: fee,
        });

      await consolidationBus
        .connect(executor)
        .executeConsolidation([{ sourcePubkeys: [SOURCE_PUBKEY_2], targetWitness: targetWitness3 }], {
          value: fee,
        });
    });
  });

  context("Key validation (NOR source, CMv2 target)", () => {
    it("Should revert submitConsolidationBatch if source key is NOT deposited", async () => {
      // Create a new NOR source operator with keys that are NOT deposited
      const unusedSourceOperatorId = await norSdvtAddNodeOperator(ctx, nor, {
        name: "consolidation_unused_source",
        rewardAddress: certainAddress("consolidation:unused:reward"),
      });

      await norSdvtAddOperatorKeys(ctx, nor, {
        operatorId: unusedSourceOperatorId,
        keysToAdd: 2n,
      });

      // Set staking limit but DO NOT deposit - keys remain unused
      await norSdvtSetOperatorStakingLimit(ctx, nor, {
        operatorId: unusedSourceOperatorId,
        limit: 2n,
      });

      // Allow the pair
      await consolidationMigrator
        .connect(agentSigner)
        .allowPair(unusedSourceOperatorId, targetOperatorId, submitter.address);

      // Try to consolidate from an undeposited key - should fail
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(unusedSourceOperatorId, targetOperatorId, [
            { sourceKeyIndices: [0n], targetKeyIndex: target.keyIndices[0] },
          ]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "KeyNotDeposited")
        .withArgs(sourceModuleId, unusedSourceOperatorId, 0n);
    });

    it("Should revert submitConsolidationBatch if target key is NOT deposited", async () => {
      // Create a new CMv2 target operator with bonded keys that are NOT deposited
      const undepositedTarget = await cmv2CreateOperatorWithKeys(ctx, {
        name: "consolidation_undeposited_target",
        keysCount: 2n,
      });

      // Allow the pair
      await consolidationMigrator
        .connect(agentSigner)
        .allowPair(sourceOperatorId, undepositedTarget.operatorId, submitter.address);

      // Try to consolidate to an undeposited target key - should fail:
      // the migrator requires the target key to be deposited in the target module
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, undepositedTarget.operatorId, [
            { sourceKeyIndices: [source.keyIndices[0]], targetKeyIndex: undepositedTarget.keyIndices[0] },
          ]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "KeyNotDeposited")
        .withArgs(targetModuleId, undepositedTarget.operatorId, undepositedTarget.keyIndices[0]);
    });
  });

  context("ConsolidationGateway integration", () => {
    it("Should revert executeConsolidation when ConsolidationGateway is paused", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Submit batch first and let the execution delay pass BEFORE pausing,
      // so the pause is still active at execution time
      await submitBatch([sourceGroup([0], 0)]);
      await waitUntilBatchExecutable(consolidationBus, calcConsolidationBatchHash([pubkeyGroup([0], 0)]));

      // Grant PAUSE_ROLE to agent and pause the gateway
      const PAUSE_ROLE = await consolidationGateway.PAUSE_ROLE();
      await consolidationGateway.connect(agentSigner).grantRole(PAUSE_ROLE, agentSigner.address);
      await consolidationGateway.connect(agentSigner).pauseFor(3600); // 1 hour

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Try to execute - should revert because gateway is paused
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(
            [{ sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: fakeWitnessForTarget(TARGET_PUBKEY_1) }],
            {
              value: fee,
            },
          ),
      ).to.be.revertedWithCustomError(consolidationGateway, "ResumedExpected");
    });

    it("Should revert executeConsolidation when rate limit is exhausted", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Grant EXIT_LIMIT_MANAGER_ROLE to agent and set a small limit
      const EXIT_LIMIT_MANAGER_ROLE = await consolidationGateway.EXIT_LIMIT_MANAGER_ROLE();
      await consolidationGateway.connect(agentSigner).grantRole(EXIT_LIMIT_MANAGER_ROLE, agentSigner.address);

      // Submit BOTH batches before a single delay wait: the first execution consumes
      // the quota and the second must fail without the limit recovering in between
      await submitBatch([sourceGroup([0], 0)]);
      await submitBatch([sourceGroup([1], 1)]);

      await waitUntilBatchExecutable(consolidationBus, calcConsolidationBatchHash([pubkeyGroup([1], 1)]));

      // Set the limit AFTER the delay wait so it cannot replenish before the second execution
      await consolidationGateway.connect(agentSigner).setConsolidationRequestLimit(1, 1, 86400);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Execute first batch - this should consume the limit
      await consolidationBus
        .connect(executor)
        .executeConsolidation([{ sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: targetWitness1 }], {
          value: fee,
        });

      // Execute second batch - should fail due to rate limit
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation([{ sourcePubkeys: [SOURCE_PUBKEY_2], targetWitness: targetWitness2 }], {
            value: fee,
          }),
      ).to.be.revertedWithCustomError(consolidationGateway, "ConsolidationRequestsLimitExceeded");
    });

    it("Should refund excess ETH to executor", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Submit batch
      await submitBatch([sourceGroup([0], 0)]);
      await waitUntilBatchExecutable(consolidationBus, calcConsolidationBatchHash([pubkeyGroup([0], 0)]));

      const fee = await withdrawalVault.getConsolidationRequestFee();
      const excessFee = fee * 10n; // Send 10x the required fee

      const executorBalanceBefore = await ethers.provider.getBalance(executor.address);

      const tx = await consolidationBus
        .connect(executor)
        .executeConsolidation([{ sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: targetWitness1 }], {
          value: excessFee,
        });

      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const executorBalanceAfter = await ethers.provider.getBalance(executor.address);

      // Executor should only pay fee + gas, not excessFee
      // Balance after = Balance before - fee - gas
      const expectedBalance = executorBalanceBefore - fee - gasUsed;
      expect(executorBalanceAfter).to.equal(expectedBalance);
    });
  });

  context("Batch management extended", () => {
    it("Should execute multiple batches sequentially", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Submit both batches before a single delay wait
      await submitBatch([sourceGroup([0], 0)]);
      await submitBatch([sourceGroup([1], 1)]);

      await waitUntilBatchExecutable(consolidationBus, calcConsolidationBatchHash([pubkeyGroup([1], 1)]));

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Execute first batch
      await consolidationBus
        .connect(executor)
        .executeConsolidation([{ sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: targetWitness1 }], {
          value: fee,
        });

      // Verify first batch is executed
      const batchHash1 = calcConsolidationBatchHash([pubkeyGroup([0], 0)]);
      expect((await consolidationBus.getBatchInfo(batchHash1)).publisher).to.equal(ethers.ZeroAddress);

      // Execute second batch
      await consolidationBus
        .connect(executor)
        .executeConsolidation([{ sourcePubkeys: [SOURCE_PUBKEY_2], targetWitness: targetWitness2 }], {
          value: fee,
        });

      // Verify second batch is executed
      const batchHash2 = calcConsolidationBatchHash([pubkeyGroup([1], 1)]);
      expect((await consolidationBus.getBatchInfo(batchHash2)).publisher).to.equal(ethers.ZeroAddress);
    });

    it("Should revert executeConsolidation if batch was removed", async () => {
      const { withdrawalVault } = ctx.contracts;
      // Submit batch
      await submitBatch([sourceGroup([0], 0)]);

      const batchHash = calcConsolidationBatchHash([pubkeyGroup([0], 0)]);
      await waitUntilBatchExecutable(consolidationBus, batchHash);

      // Remove batch
      await consolidationBus.connect(agentSigner).removeBatches([batchHash]);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Try to execute removed batch
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation(
            [{ sourcePubkeys: [SOURCE_PUBKEY_1], targetWitness: fakeWitnessForTarget(TARGET_PUBKEY_1) }],
            {
              value: fee,
            },
          ),
      ).to.be.revertedWithCustomError(consolidationBus, "BatchNotFound");
    });

    it("Should revert addConsolidationRequests if batch already pending (duplicate submission)", async () => {
      // Submit batch first time
      await submitBatch([sourceGroup([0], 0)]);

      const batchHash = calcConsolidationBatchHash([pubkeyGroup([0], 0)]);

      // Re-submit the same batch directly (the submitBatch helper would clean up the
      // pending batch first, which is exactly what this test must not do)
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [sourceGroup([0], 0)]),
      )
        .to.be.revertedWithCustomError(consolidationBus, "BatchAlreadyPending")
        .withArgs(batchHash);
    });
  });

  context("Input validation", () => {
    it("Should revert submitConsolidationBatch with EmptyBatch if groups array is empty", async () => {
      await expect(submitBatch([])).to.be.revertedWithCustomError(consolidationBus, "EmptyBatch");
    });

    it("Should revert submitConsolidationBatch with EmptyGroup if a source group is empty", async () => {
      // Second group has empty sourceKeyIndices - ConsolidationBus catches this after migrator passes it through
      await expect(submitBatch([sourceGroup([0], 0), { sourceKeyIndices: [], targetKeyIndex: target.keyIndices[1] }]))
        .to.be.revertedWithCustomError(consolidationBus, "EmptyGroup")
        .withArgs(1);
    });

    it("Should revert submitConsolidationBatch with TooManyGroups if groups exceed maxGroupsInBatch", async () => {
      await consolidationBus.connect(agentSigner).setMaxGroupsInBatch(1);

      await expect(submitBatch([sourceGroup([0], 0), sourceGroup([1], 1)]))
        .to.be.revertedWithCustomError(consolidationBus, "TooManyGroups")
        .withArgs(2, 1);
    });

    it("Should revert submitConsolidationBatch with BatchTooLarge if total keys exceed batchSize", async () => {
      // Reduce limits so a single group with 2 source keys exceeds the batch size
      await consolidationBus.connect(agentSigner).setMaxGroupsInBatch(1);
      await consolidationBus.connect(agentSigner).setBatchSize(1);

      await expect(submitBatch([sourceGroup([0, 1], 0)]))
        .to.be.revertedWithCustomError(consolidationBus, "BatchTooLarge")
        .withArgs(2, 1);
    });
  });
});
