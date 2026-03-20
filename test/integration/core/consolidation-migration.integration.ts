import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationBus, ConsolidationGateway, ConsolidationMigrator, NodeOperatorsRegistry } from "typechain-types";

import { certainAddress, findEventsWithInterfaces } from "lib";
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

const witnessesForTargets = (targets: string[]) =>
  targets.map((pubkey) => ({
    proof: [],
    pubkey,
    validatorIndex: 0,
    childBlockTimestamp: 0,
    slot: 0,
    proposerIndex: 0,
  }));

/**
 * Integration test for the full consolidation migration flow using real NOR modules.
 *
 * The flow tested:
 * 1. ConsolidationMigrator validates source/target keys and submits to ConsolidationBus
 * 2. ConsolidationBus stores the batch for later execution
 * 3. Executor calls executeConsolidation on ConsolidationBus
 * 4. ConsolidationBus forwards to ConsolidationGateway
 * 5. ConsolidationGateway forwards to WithdrawalVault
 * 6. WithdrawalVault processes EIP-7251 consolidation requests
 */
describe("Integration: Consolidation Migration Flow (Real NOR)", () => {
  let ctx: ProtocolContext;
  let nor: LoadedContract<NodeOperatorsRegistry>;
  let consolidationGateway: ConsolidationGateway;
  let consolidationBus: ConsolidationBus;
  let consolidationMigrator: ConsolidationMigrator;

  let executor: HardhatEthersSigner;
  let submitter: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  // Operator IDs will be assigned during setup
  let sourceOperatorId: bigint;
  let targetOperatorId: bigint;

  // Pubkeys will be retrieved from real NOR
  let SOURCE_PUBKEY_1: string;
  let SOURCE_PUBKEY_2: string;
  let TARGET_PUBKEY_1: string;
  let TARGET_PUBKEY_2: string;

  let globalSnapshot: string;
  let testSnapshot: string;

  before(async () => {
    ctx = await getProtocolContext();
    [, executor, submitter, stranger] = await ethers.getSigners();

    // Get real contracts from protocol context
    nor = ctx.contracts.nor;
    consolidationGateway = ctx.contracts.consolidationGateway;
    consolidationBus = ctx.contracts.consolidationBus;
    consolidationMigrator = ctx.contracts.consolidationMigrator;

    const agentSigner = await ctx.getSigner("agent");

    // =========================================
    // Setup source operator with deposited keys
    // =========================================

    // Create source operator
    sourceOperatorId = await norSdvtAddNodeOperator(ctx, nor, {
      name: "consolidation_source_operator",
      rewardAddress: certainAddress("consolidation:source:reward"),
    });

    // Add signing keys to source operator
    await norSdvtAddOperatorKeys(ctx, nor, {
      operatorId: sourceOperatorId,
      keysToAdd: 5n,
    });

    // Set staking limit to vet the keys
    await norSdvtSetOperatorStakingLimit(ctx, nor, {
      operatorId: sourceOperatorId,
      limit: 5n,
    });

    // Deposit validators to make keys "used"
    await depositAndReportValidators(ctx, NOR_MODULE_ID, 2n);

    // =========================================
    // Setup target operator with deposited keys (active validators)
    // Per EIP-7251, consolidation can only happen TO active validators
    // =========================================

    // Create target operator
    targetOperatorId = await norSdvtAddNodeOperator(ctx, nor, {
      name: "consolidation_target_operator",
      rewardAddress: certainAddress("consolidation:target:reward"),
    });

    // Add signing keys to target operator
    await norSdvtAddOperatorKeys(ctx, nor, {
      operatorId: targetOperatorId,
      keysToAdd: 5n,
    });

    // Set staking limit to vet the keys
    await norSdvtSetOperatorStakingLimit(ctx, nor, {
      operatorId: targetOperatorId,
      limit: 5n,
    });

    // Deposit validators to make target keys "used" (active validators)
    await depositAndReportValidators(ctx, NOR_MODULE_ID, 2n);

    // =========================================
    // Retrieve pubkeys from real NOR
    // =========================================

    // Get source pubkeys (these are deposited/used)
    const sourceKey1 = await nor.getSigningKey(sourceOperatorId, 0);
    const sourceKey2 = await nor.getSigningKey(sourceOperatorId, 1);
    SOURCE_PUBKEY_1 = sourceKey1.key;
    SOURCE_PUBKEY_2 = sourceKey2.key;

    // Verify source keys are used (deposited)
    expect(sourceKey1.used).to.be.true;
    expect(sourceKey2.used).to.be.true;

    // Get target pubkeys (these are deposited - active validators)
    const targetKey1 = await nor.getSigningKey(targetOperatorId, 0);
    const targetKey2 = await nor.getSigningKey(targetOperatorId, 1);
    TARGET_PUBKEY_1 = targetKey1.key;
    TARGET_PUBKEY_2 = targetKey2.key;

    // Verify target keys ARE used (deposited - active validators)
    expect(targetKey1.used).to.be.true;
    expect(targetKey2.used).to.be.true;

    // =========================================
    // Setup roles
    // =========================================

    // Grant MANAGE_ROLE on ConsolidationBus to agent (for batch management tests)
    const MANAGE_ROLE = await consolidationBus.MANAGE_ROLE();
    const REMOVE_ROLE = await consolidationBus.REMOVE_ROLE();
    await consolidationBus.connect(agentSigner).grantRole(MANAGE_ROLE, agentSigner.address);
    await consolidationBus.connect(agentSigner).grantRole(REMOVE_ROLE, agentSigner.address);

    // Grant ALLOW_PAIR_ROLE on ConsolidationMigrator to agent
    const ALLOW_PAIR_ROLE = await consolidationMigrator.ALLOW_PAIR_ROLE();
    await consolidationMigrator.connect(agentSigner).grantRole(ALLOW_PAIR_ROLE, agentSigner.address);

    // Allow the consolidation pair with submitter
    await consolidationMigrator.connect(agentSigner).allowPair(sourceOperatorId, targetOperatorId, submitter.address);

    globalSnapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(globalSnapshot));

  beforeEach(async () => {
    testSnapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(testSnapshot));

  context("Full consolidation flow with real NOR", () => {
    it("Should successfully complete the full consolidation flow with single validator", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Single validator consolidation
      const sourceIndicesPerTarget = [[0n]];
      const targetIndices = [0n];

      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, sourceIndicesPerTarget, targetIndices);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      const tx = await consolidationBus
        .connect(executor)
        .executeConsolidation([[SOURCE_PUBKEY_1]], witnessesForTargets([TARGET_PUBKEY_1]), {
          value: fee,
        });

      const receipt = await tx.wait();
      const consolidationEvents = findEventsWithInterfaces(receipt!, "ConsolidationRequestAdded", [
        withdrawalVault.interface,
      ]);
      expect(consolidationEvents?.length).to.equal(1);
    });

    it("Should successfully complete the full consolidation flow with multiple validators", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Step 1: Operator submits consolidation batch via ConsolidationMigrator
      const sourceIndicesPerTarget = [[0n], [1n]];
      const targetIndices = [0n, 1n];

      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, targetOperatorId, sourceIndicesPerTarget, targetIndices),
      )
        .to.emit(consolidationMigrator, "ConsolidationSubmitted")
        .withArgs(sourceOperatorId, targetOperatorId, sourceIndicesPerTarget, targetIndices);

      // Step 2: Verify batch is stored in ConsolidationBus
      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes[][]", "bytes[]"],
          [
            [[SOURCE_PUBKEY_1], [SOURCE_PUBKEY_2]],
            [TARGET_PUBKEY_1, TARGET_PUBKEY_2],
          ],
        ),
      );
      expect(await consolidationBus.getBatchPublisher(batchHash)).to.equal(await consolidationMigrator.getAddress());

      // Step 3: Executor calls executeConsolidation
      const fee = await withdrawalVault.getConsolidationRequestFee();
      const totalFee = fee * BigInt(sourceIndicesPerTarget.length);

      const initialLimit = (await consolidationGateway.getConsolidationRequestLimitFullInfo())
        .currentConsolidationRequestsLimit;

      const tx = await consolidationBus
        .connect(executor)
        .executeConsolidation(
          [[SOURCE_PUBKEY_1], [SOURCE_PUBKEY_2]],
          witnessesForTargets([TARGET_PUBKEY_1, TARGET_PUBKEY_2]),
          {
            value: totalFee,
          },
        );

      // Step 4: Verify batch is removed from storage after execution
      expect(await consolidationBus.getBatchPublisher(batchHash)).to.equal(ethers.ZeroAddress);

      // Step 5: Verify ConsolidationGateway rate limit was consumed
      const finalLimit = (await consolidationGateway.getConsolidationRequestLimitFullInfo())
        .currentConsolidationRequestsLimit;
      expect(finalLimit).to.equal(initialLimit - BigInt(sourceIndicesPerTarget.length));

      // Step 6: Verify consolidation requests reached WithdrawalVault
      const receipt = await tx.wait();
      expect(receipt).not.to.be.null;

      const consolidationEvents = findEventsWithInterfaces(receipt!, "ConsolidationRequestAdded", [
        withdrawalVault.interface,
      ]);
      expect(consolidationEvents?.length).to.equal(sourceIndicesPerTarget.length);
    });

    it("Should revert submitConsolidationBatch if caller is not the designated submitter", async () => {
      await expect(
        consolidationMigrator
          .connect(stranger)
          .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n]], [0n]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(stranger.address, sourceOperatorId, targetOperatorId);
    });

    it("Should revert submitConsolidationBatch if pair is not allowed (no submitter set)", async () => {
      const unknownTargetOpId = 999n;

      // When pair is not allowed, there's no submitter set (address(0))
      // So caller will fail authorization check first
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, unknownTargetOpId, [[0n]], [0n]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(submitter.address, sourceOperatorId, unknownTargetOpId);
    });

    it("Should revert executeConsolidation if batch not found", async () => {
      const fakePubkey = "0x" + "ff".repeat(48);

      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation([[fakePubkey]], witnessesForTargets([fakePubkey]), { value: 1n }),
      ).to.be.revertedWithCustomError(consolidationBus, "BatchNotFound");
    });

    it("Should revert executeConsolidation if insufficient fee", async () => {
      // Submit batch first
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n]], [0n]);

      // Try to execute with insufficient fee (0)
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation([[SOURCE_PUBKEY_1]], witnessesForTargets([TARGET_PUBKEY_1]), {
            value: 0n,
          }),
      ).to.be.reverted; // The actual error comes from WithdrawalVault
    });

    it("Should revert executeConsolidation if batch already executed", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Submit batch
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n]], [0n]);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Execute first time
      await consolidationBus
        .connect(executor)
        .executeConsolidation([[SOURCE_PUBKEY_1]], witnessesForTargets([TARGET_PUBKEY_1]), {
          value: fee,
        });

      // Try to execute again
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation([[SOURCE_PUBKEY_1]], witnessesForTargets([TARGET_PUBKEY_1]), {
            value: fee,
          }),
      ).to.be.revertedWithCustomError(consolidationBus, "BatchNotFound");
    });
  });

  context("Batch management", () => {
    it("Should allow manager to remove a pending batch", async () => {
      const agentSigner = await ctx.getSigner("agent");

      // Submit batch
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n]], [0n]);

      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[][]", "bytes[]"], [[[SOURCE_PUBKEY_1]], [TARGET_PUBKEY_1]]),
      );

      expect(await consolidationBus.getBatchPublisher(batchHash)).to.not.equal(ethers.ZeroAddress);

      // Manager removes the batch
      await consolidationBus.connect(agentSigner).removeBatches([batchHash]);

      expect(await consolidationBus.getBatchPublisher(batchHash)).to.equal(ethers.ZeroAddress);
    });
  });

  context("Allowlist management", () => {
    it("Should allow disallowing a pair after submission", async () => {
      const agentSigner = await ctx.getSigner("agent");

      // Submit a batch
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n]], [0n]);

      // Disallow the pair
      await consolidationMigrator.connect(agentSigner).disallowPair(sourceOperatorId, targetOperatorId);

      // Verify new submissions are blocked (submitter is cleared, so NotAuthorized is thrown)
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[1n]], [1n]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(submitter.address, sourceOperatorId, targetOperatorId);

      // But existing batch can still be executed
      const { withdrawalVault } = ctx.contracts;
      const fee = await withdrawalVault.getConsolidationRequestFee();

      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation([[SOURCE_PUBKEY_1]], witnessesForTargets([TARGET_PUBKEY_1]), {
            value: fee,
          }),
      ).to.not.be.reverted;
    });

    it("Should allow one source operator to consolidate to multiple targets", async () => {
      const { withdrawalVault } = ctx.contracts;
      const agentSigner = await ctx.getSigner("agent");

      // Set up a second target operator with deposited validators
      const targetOperatorId2 = await norSdvtAddNodeOperator(ctx, nor, {
        name: "consolidation_target_operator_2",
        rewardAddress: certainAddress("consolidation:target2:reward"),
      });

      await norSdvtAddOperatorKeys(ctx, nor, {
        operatorId: targetOperatorId2,
        keysToAdd: 2n,
      });

      await norSdvtSetOperatorStakingLimit(ctx, nor, {
        operatorId: targetOperatorId2,
        limit: 2n,
      });

      // Deposit validators to make target2 keys active
      await depositAndReportValidators(ctx, NOR_MODULE_ID, 1n);

      const targetKey3 = await nor.getSigningKey(targetOperatorId2, 0);
      const TARGET_PUBKEY_3 = targetKey3.key;

      // Allow second pair with the same submitter
      await consolidationMigrator
        .connect(agentSigner)
        .allowPair(sourceOperatorId, targetOperatorId2, submitter.address);

      // Submit batch to first target
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n]], [0n]);

      // Submit batch to second target
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId2, [[1n]], [0n]);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Execute both batches
      await consolidationBus
        .connect(executor)
        .executeConsolidation([[SOURCE_PUBKEY_1]], witnessesForTargets([TARGET_PUBKEY_1]), {
          value: fee,
        });

      await consolidationBus
        .connect(executor)
        .executeConsolidation([[SOURCE_PUBKEY_2]], witnessesForTargets([TARGET_PUBKEY_3]), {
          value: fee,
        });
    });
  });

  context("Key validation with real NOR", () => {
    it("Should revert submitConsolidationBatch if source key is NOT used (not deposited)", async () => {
      const agentSigner = await ctx.getSigner("agent");

      // Create a new source operator with keys that are NOT deposited
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

      // Try to consolidate from unused key - should fail
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(unusedSourceOperatorId, targetOperatorId, [[0n]], [0n]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "KeyNotDeposited")
        .withArgs(NOR_MODULE_ID, unusedSourceOperatorId, 0n);
    });

    it("Should revert submitConsolidationBatch if target key is NOT deposited (not active validator)", async () => {
      const agentSigner = await ctx.getSigner("agent");

      // Create a new target operator with keys that are NOT deposited
      const undepositedTargetOperatorId = await norSdvtAddNodeOperator(ctx, nor, {
        name: "consolidation_undeposited_target",
        rewardAddress: certainAddress("consolidation:undeposited:reward"),
      });

      await norSdvtAddOperatorKeys(ctx, nor, {
        operatorId: undepositedTargetOperatorId,
        keysToAdd: 2n,
      });

      // Set staking limit but DO NOT deposit - keys remain undeposited (not active)
      await norSdvtSetOperatorStakingLimit(ctx, nor, {
        operatorId: undepositedTargetOperatorId,
        limit: 2n,
      });

      // Verify target keys are NOT used (not deposited)
      const targetKey = await nor.getSigningKey(undepositedTargetOperatorId, 0);
      expect(targetKey.used).to.be.false;

      // Allow the pair
      await consolidationMigrator
        .connect(agentSigner)
        .allowPair(sourceOperatorId, undepositedTargetOperatorId, submitter.address);

      // Try to consolidate to undeposited target key - should fail
      // Per EIP-7251, consolidation can only happen TO active (deposited) validators
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, undepositedTargetOperatorId, [[0n]], [0n]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "KeyNotDeposited")
        .withArgs(NOR_MODULE_ID, undepositedTargetOperatorId, 0n);
    });
  });

  context("ConsolidationGateway integration", () => {
    it("Should revert executeConsolidation when ConsolidationGateway is paused", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Submit batch first
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n]], [0n]);

      // Grant PAUSE_ROLE to agent and pause the gateway
      const agentSigner = await ctx.getSigner("agent");
      const PAUSE_ROLE = await consolidationGateway.PAUSE_ROLE();
      await consolidationGateway.connect(agentSigner).grantRole(PAUSE_ROLE, agentSigner.address);
      await consolidationGateway.connect(agentSigner).pauseFor(3600); // 1 hour

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Try to execute - should revert because gateway is paused
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation([[SOURCE_PUBKEY_1]], witnessesForTargets([TARGET_PUBKEY_1]), {
            value: fee,
          }),
      ).to.be.revertedWithCustomError(consolidationGateway, "ResumedExpected");
    });

    it("Should revert executeConsolidation when rate limit is exhausted", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Grant EXIT_LIMIT_MANAGER_ROLE to agent and set a small limit
      const agentSigner = await ctx.getSigner("agent");
      const EXIT_LIMIT_MANAGER_ROLE = await consolidationGateway.EXIT_LIMIT_MANAGER_ROLE();
      await consolidationGateway.connect(agentSigner).grantRole(EXIT_LIMIT_MANAGER_ROLE, agentSigner.address);
      await consolidationGateway.connect(agentSigner).setConsolidationRequestLimit(1, 1, 86400);

      // Submit first batch
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n]], [0n]);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Execute first batch - this should consume the limit
      await consolidationBus
        .connect(executor)
        .executeConsolidation([[SOURCE_PUBKEY_1]], witnessesForTargets([TARGET_PUBKEY_1]), {
          value: fee,
        });

      // Submit second batch
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[1n]], [1n]);

      // Execute second batch - should fail due to rate limit
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation([[SOURCE_PUBKEY_2]], witnessesForTargets([TARGET_PUBKEY_2]), {
            value: fee,
          }),
      ).to.be.revertedWithCustomError(consolidationGateway, "ConsolidationRequestsLimitExceeded");
    });

    it("Should refund excess ETH to executor", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Submit batch
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n]], [0n]);

      const fee = await withdrawalVault.getConsolidationRequestFee();
      const excessFee = fee * 10n; // Send 10x the required fee

      const executorBalanceBefore = await ethers.provider.getBalance(executor.address);

      const tx = await consolidationBus
        .connect(executor)
        .executeConsolidation([[SOURCE_PUBKEY_1]], witnessesForTargets([TARGET_PUBKEY_1]), {
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

      // Submit first batch
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n]], [0n]);

      // Submit second batch
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[1n]], [1n]);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Execute first batch
      await consolidationBus
        .connect(executor)
        .executeConsolidation([[SOURCE_PUBKEY_1]], witnessesForTargets([TARGET_PUBKEY_1]), {
          value: fee,
        });

      // Verify first batch is executed
      const batchHash1 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[][]", "bytes[]"], [[[SOURCE_PUBKEY_1]], [TARGET_PUBKEY_1]]),
      );
      expect(await consolidationBus.getBatchPublisher(batchHash1)).to.equal(ethers.ZeroAddress);

      // Execute second batch
      await consolidationBus
        .connect(executor)
        .executeConsolidation([[SOURCE_PUBKEY_2]], witnessesForTargets([TARGET_PUBKEY_2]), {
          value: fee,
        });

      // Verify second batch is executed
      const batchHash2 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[][]", "bytes[]"], [[[SOURCE_PUBKEY_2]], [TARGET_PUBKEY_2]]),
      );
      expect(await consolidationBus.getBatchPublisher(batchHash2)).to.equal(ethers.ZeroAddress);
    });

    it("Should revert executeConsolidation if batch was removed", async () => {
      const { withdrawalVault } = ctx.contracts;
      const agentSigner = await ctx.getSigner("agent");

      // Submit batch
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n]], [0n]);

      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[][]", "bytes[]"], [[[SOURCE_PUBKEY_1]], [TARGET_PUBKEY_1]]),
      );

      // Remove batch
      await consolidationBus.connect(agentSigner).removeBatches([batchHash]);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Try to execute removed batch
      await expect(
        consolidationBus
          .connect(executor)
          .executeConsolidation([[SOURCE_PUBKEY_1]], witnessesForTargets([TARGET_PUBKEY_1]), {
            value: fee,
          }),
      ).to.be.revertedWithCustomError(consolidationBus, "BatchNotFound");
    });

    it("Should revert addConsolidationRequests if too many groups", async () => {
      const agentSigner = await ctx.getSigner("agent");

      // Set maxGroupsInBatch to 1
      await consolidationBus.connect(agentSigner).setMaxGroupsInBatch(1);

      // Try to submit batch with 2 groups (exceeds maxGroupsInBatch of 1)
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n], [1n]], [0n, 1n]),
      )
        .to.be.revertedWithCustomError(consolidationBus, "TooManyGroups")
        .withArgs(2, 1);
    });

    it("Should revert addConsolidationRequests if batch size exceeds limit", async () => {
      const agentSigner = await ctx.getSigner("agent");

      // Set batchSize to 1 (single group with 2 sources will exceed it)
      // Must reduce maxGroupsInBatch first, since batchSize must be >= maxGroupsInBatch
      await consolidationBus.connect(agentSigner).setMaxGroupsInBatch(1);
      await consolidationBus.connect(agentSigner).setBatchSize(1);

      // Try to submit 1 group with 2 source keys (total count 2 exceeds batchSize of 1)
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n, 1n]], [0n]),
      )
        .to.be.revertedWithCustomError(consolidationBus, "BatchTooLarge")
        .withArgs(2, 1);
    });

    it("Should revert addConsolidationRequests if batch already pending (duplicate submission)", async () => {
      // Submit batch first time
      await consolidationMigrator
        .connect(submitter)
        .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n]], [0n]);

      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[][]", "bytes[]"], [[[SOURCE_PUBKEY_1]], [TARGET_PUBKEY_1]]),
      );

      // Try to submit the same batch again
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n]], [0n]),
      )
        .to.be.revertedWithCustomError(consolidationBus, "BatchAlreadyPending")
        .withArgs(batchHash);
    });
  });

  context("Input validation", () => {
    it("Should revert submitConsolidationBatch with EmptyBatch if arrays are empty", async () => {
      await expect(
        consolidationMigrator.connect(submitter).submitConsolidationBatch(sourceOperatorId, targetOperatorId, [], []),
      ).to.be.revertedWithCustomError(consolidationBus, "EmptyBatch");
    });

    it("Should revert submitConsolidationBatch with ArraysLengthMismatch if arrays have different lengths", async () => {
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n], [1n]], [0n]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "ArraysLengthMismatch")
        .withArgs(2, 1);
    });

    it("Should revert submitConsolidationBatch with EmptyGroup if a source group is empty", async () => {
      // Second group is empty — ConsolidationBus catches this after migrator passes it through
      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n], []], [0n, 1n]),
      )
        .to.be.revertedWithCustomError(consolidationBus, "EmptyGroup")
        .withArgs(1);
    });

    it("Should revert submitConsolidationBatch with TooManyGroups if groups exceed maxGroupsInBatch", async () => {
      const agentSigner = await ctx.getSigner("agent");

      await consolidationBus.connect(agentSigner).setMaxGroupsInBatch(1);

      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n], [1n]], [0n, 1n]),
      )
        .to.be.revertedWithCustomError(consolidationBus, "TooManyGroups")
        .withArgs(2, 1);
    });

    it("Should revert submitConsolidationBatch with BatchTooLarge if total keys exceed batchSize", async () => {
      const agentSigner = await ctx.getSigner("agent");

      // Reduce limits so a single group with 2 source keys exceeds the batch size
      await consolidationBus.connect(agentSigner).setMaxGroupsInBatch(1);
      await consolidationBus.connect(agentSigner).setBatchSize(1);

      await expect(
        consolidationMigrator
          .connect(submitter)
          .submitConsolidationBatch(sourceOperatorId, targetOperatorId, [[0n, 1n]], [0n]),
      )
        .to.be.revertedWithCustomError(consolidationBus, "BatchTooLarge")
        .withArgs(2, 1);
    });
  });
});
