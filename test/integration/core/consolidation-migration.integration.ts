import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ConsolidationBus,
  ConsolidationGateway,
  ConsolidationMigrator,
  SourceModule__MockForConsolidationMigrator,
  TargetModule__MockForConsolidationMigrator,
} from "typechain-types";

import { findEventsWithInterfaces } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

/**
 * Integration test for the full consolidation migration flow.
 *
 * The flow tested:
 * 1. ConsolidationMigrator validates source/target keys and submits to ConsolidationBus
 * 2. ConsolidationBus stores the batch for later execution
 * 3. Executor calls executeConsolidation on ConsolidationBus
 * 4. ConsolidationBus forwards to ConsolidationGateway
 * 5. ConsolidationGateway forwards to WithdrawalVault
 * 6. WithdrawalVault processes EIP-7251 consolidation requests
 *
 * TODO: Rewrite this test to use real NOR modules once tests in master branch are fixed.
 * Currently uses mocked staking modules for source/target key validation.
 */
describe("Integration: Consolidation Migration Flow", () => {
  let ctx: ProtocolContext;
  let consolidationGateway: ConsolidationGateway;
  let consolidationBus: ConsolidationBus;
  let consolidationMigrator: ConsolidationMigrator;
  let sourceModule: SourceModule__MockForConsolidationMigrator;
  let targetModule: TargetModule__MockForConsolidationMigrator;

  let admin: HardhatEthersSigner;
  let allowPairManager: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let operatorRewardAddress: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  // Test pubkeys (48 bytes each)
  const SOURCE_PUBKEY_1 = "0x" + "aa".repeat(48);
  const SOURCE_PUBKEY_2 = "0x" + "bb".repeat(48);
  const TARGET_PUBKEY_1 = "0x" + "cc".repeat(48);
  const TARGET_PUBKEY_2 = "0x" + "dd".repeat(48);

  // Module and operator IDs
  const SOURCE_MODULE_ID = 100n;
  const TARGET_MODULE_ID = 200n;
  const SOURCE_OPERATOR_ID = 1n;
  const TARGET_OPERATOR_ID = 2n;

  let globalSnapshot: string;
  let testSnapshot: string;

  before(async () => {
    ctx = await getProtocolContext();
    [admin, allowPairManager, executor, operatorRewardAddress, stranger] = await ethers.getSigners();

    consolidationGateway = ctx.contracts.consolidationGateway;

    // Deploy mock staking modules
    sourceModule = await ethers.deployContract("SourceModule__MockForConsolidationMigrator");
    targetModule = await ethers.deployContract("TargetModule__MockForConsolidationMigrator");

    // Deploy a mock StakingRouter that returns our mock modules
    const stakingRouterMock = await ethers.deployContract("StakingRouter__MockForConsolidationMigrator");
    await stakingRouterMock.mock__setStakingModule(SOURCE_MODULE_ID, await sourceModule.getAddress());
    await stakingRouterMock.mock__setStakingModule(TARGET_MODULE_ID, await targetModule.getAddress());

    // Deploy ConsolidationBus
    consolidationBus = await ethers.deployContract("ConsolidationBus", [
      admin.address,
      await consolidationGateway.getAddress(),
      100, // batch size limit
    ]);

    // Deploy ConsolidationMigrator
    consolidationMigrator = await ethers.deployContract("ConsolidationMigrator", [
      admin.address,
      await stakingRouterMock.getAddress(),
      await consolidationBus.getAddress(),
      SOURCE_MODULE_ID,
      TARGET_MODULE_ID,
    ]);

    // Set up roles on ConsolidationBus
    const MANAGER_ROLE = await consolidationBus.MANAGER_ROLE();
    const PUBLISHER_ROLE = await consolidationBus.PUBLISHER_ROLE();
    const EXECUTER_ROLE = await consolidationBus.EXECUTER_ROLE();

    await consolidationBus.connect(admin).grantRole(MANAGER_ROLE, admin.address);
    await consolidationBus.connect(admin).grantRole(PUBLISHER_ROLE, await consolidationMigrator.getAddress());
    await consolidationBus.connect(admin).grantRole(EXECUTER_ROLE, executor.address);

    // Set up roles on ConsolidationMigrator
    const ALLOW_PAIR_ROLE = await consolidationMigrator.ALLOW_PAIR_ROLE();
    await consolidationMigrator.connect(admin).grantRole(ALLOW_PAIR_ROLE, allowPairManager.address);

    // Set up roles on ConsolidationGateway
    const agentSigner = await ctx.getSigner("agent");
    const ADD_CONSOLIDATION_REQUEST_ROLE = await consolidationGateway.ADD_CONSOLIDATION_REQUEST_ROLE();
    await consolidationGateway
      .connect(agentSigner)
      .grantRole(ADD_CONSOLIDATION_REQUEST_ROLE, await consolidationBus.getAddress());

    // Set up source module: operator with deposited (used) keys
    await sourceModule.mock__setNodeOperator(SOURCE_OPERATOR_ID, operatorRewardAddress.address, true);
    await sourceModule.mock__setSigningKey(SOURCE_OPERATOR_ID, 0, SOURCE_PUBKEY_1, true); // used
    await sourceModule.mock__setSigningKey(SOURCE_OPERATOR_ID, 1, SOURCE_PUBKEY_2, true); // used

    // Set up target module: operator with undeposited keys
    await targetModule.mock__setOperatorData(TARGET_OPERATOR_ID, 0, [TARGET_PUBKEY_1, TARGET_PUBKEY_2]);

    // Allow the consolidation pair
    await consolidationMigrator.connect(allowPairManager).allowPair(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID);

    globalSnapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(globalSnapshot));

  beforeEach(async () => {
    testSnapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(testSnapshot));

  context("Full consolidation flow", () => {
    it("Should successfully complete the full consolidation flow with single validator", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Single validator consolidation
      const sourceIndices = [0n];
      const targetIndices = [0n];

      await consolidationMigrator
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, sourceIndices, targetIndices);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      const tx = await consolidationBus
        .connect(executor)
        .executeConsolidation([SOURCE_PUBKEY_1], [TARGET_PUBKEY_1], { value: fee });

      const receipt = await tx.wait();
      const consolidationEvents = findEventsWithInterfaces(receipt!, "ConsolidationRequestAdded", [
        withdrawalVault.interface,
      ]);
      expect(consolidationEvents?.length).to.equal(1);
    });

    it("Should successfully complete the full consolidation flow with multiple validators", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Step 1: Operator submits consolidation batch via ConsolidationMigrator
      const sourceIndices = [0n, 1n];
      const targetIndices = [0n, 1n];

      await expect(
        consolidationMigrator
          .connect(operatorRewardAddress)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, sourceIndices, targetIndices),
      )
        .to.emit(consolidationMigrator, "ConsolidationSubmitted")
        .withArgs(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, sourceIndices, targetIndices);

      // Step 2: Verify batch is stored in ConsolidationBus
      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes[]", "bytes[]"],
          [
            [SOURCE_PUBKEY_1, SOURCE_PUBKEY_2],
            [TARGET_PUBKEY_1, TARGET_PUBKEY_2],
          ],
        ),
      );
      expect(await consolidationBus.isBatchAdded(batchHash)).to.be.true;
      expect(await consolidationBus.addedBy(batchHash)).to.equal(await consolidationMigrator.getAddress());

      // Step 3: Executor calls executeConsolidation
      const fee = await withdrawalVault.getConsolidationRequestFee();
      const totalFee = fee * BigInt(sourceIndices.length);

      const initialLimit = (await consolidationGateway.getConsolidationRequestLimitFullInfo())
        .currentConsolidationRequestsLimit;

      const tx = await consolidationBus
        .connect(executor)
        .executeConsolidation([SOURCE_PUBKEY_1, SOURCE_PUBKEY_2], [TARGET_PUBKEY_1, TARGET_PUBKEY_2], {
          value: totalFee,
        });

      // Step 4: Verify batch is marked as executed
      expect(await consolidationBus.isBatchAdded(batchHash)).to.be.false; // returns false for executed batches

      // Step 5: Verify ConsolidationGateway rate limit was consumed
      const finalLimit = (await consolidationGateway.getConsolidationRequestLimitFullInfo())
        .currentConsolidationRequestsLimit;
      expect(finalLimit).to.equal(initialLimit - BigInt(sourceIndices.length));

      // Step 6: Verify consolidation requests reached WithdrawalVault
      const receipt = await tx.wait();
      expect(receipt).not.to.be.null;

      const consolidationEvents = findEventsWithInterfaces(receipt!, "ConsolidationRequestAdded", [
        withdrawalVault.interface,
      ]);
      expect(consolidationEvents?.length).to.equal(sourceIndices.length);
    });

    it("Should revert submitConsolidationBatch if caller is not reward address", async () => {
      await expect(
        consolidationMigrator
          .connect(stranger)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0n], [0n]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "NotAuthorized")
        .withArgs(stranger.address, SOURCE_OPERATOR_ID);
    });

    it("Should revert submitConsolidationBatch if pair is not allowed", async () => {
      const unknownTargetOpId = 999n;

      await expect(
        consolidationMigrator
          .connect(operatorRewardAddress)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, unknownTargetOpId, [0n], [0n]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "PairNotAllowed")
        .withArgs(SOURCE_OPERATOR_ID, unknownTargetOpId);
    });

    it("Should revert executeConsolidation if batch not found", async () => {
      const fakePubkey = "0x" + "ff".repeat(48);

      await expect(
        consolidationBus.connect(executor).executeConsolidation([fakePubkey], [fakePubkey], { value: 1n }),
      ).to.be.revertedWithCustomError(consolidationBus, "BatchNotFound");
    });

    it("Should revert executeConsolidation if insufficient fee", async () => {
      // Submit batch first
      await consolidationMigrator
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0n], [0n]);

      // Try to execute with insufficient fee (0)
      await expect(
        consolidationBus.connect(executor).executeConsolidation([SOURCE_PUBKEY_1], [TARGET_PUBKEY_1], { value: 0n }),
      ).to.be.reverted; // The actual error comes from WithdrawalVault
    });

    it("Should revert executeConsolidation if caller does not have EXECUTER_ROLE", async () => {
      // Submit batch first
      await consolidationMigrator
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0n], [0n]);

      const EXECUTER_ROLE = await consolidationBus.EXECUTER_ROLE();

      await expect(
        consolidationBus.connect(stranger).executeConsolidation([SOURCE_PUBKEY_1], [TARGET_PUBKEY_1], { value: 1n }),
      )
        .to.be.revertedWithCustomError(consolidationBus, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, EXECUTER_ROLE);
    });

    it("Should revert executeConsolidation if batch already executed", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Submit batch
      await consolidationMigrator
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0n], [0n]);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Execute first time
      await consolidationBus
        .connect(executor)
        .executeConsolidation([SOURCE_PUBKEY_1], [TARGET_PUBKEY_1], { value: fee });

      // Try to execute again
      await expect(
        consolidationBus.connect(executor).executeConsolidation([SOURCE_PUBKEY_1], [TARGET_PUBKEY_1], { value: fee }),
      ).to.be.revertedWithCustomError(consolidationBus, "BatchAlreadyExecuted");
    });
  });

  context("Batch management", () => {
    it("Should allow manager to remove a pending batch", async () => {
      // Submit batch
      await consolidationMigrator
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0n], [0n]);

      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [[SOURCE_PUBKEY_1], [TARGET_PUBKEY_1]]),
      );

      expect(await consolidationBus.isBatchAdded(batchHash)).to.be.true;

      // Manager removes the batch
      await consolidationBus.connect(admin).removeBatches([batchHash]);

      expect(await consolidationBus.isBatchAdded(batchHash)).to.be.false;
    });
  });

  context("Allowlist management", () => {
    it("Should allow disallowing a pair after submission", async () => {
      // Submit a batch
      await consolidationMigrator
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0n], [0n]);

      // Disallow the pair
      await consolidationMigrator.connect(allowPairManager).disallowPair(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID);

      // Verify new submissions are blocked
      await expect(
        consolidationMigrator
          .connect(operatorRewardAddress)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [1n], [1n]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "PairNotAllowed")
        .withArgs(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID);

      // But existing batch can still be executed
      const { withdrawalVault } = ctx.contracts;
      const fee = await withdrawalVault.getConsolidationRequestFee();

      await expect(
        consolidationBus.connect(executor).executeConsolidation([SOURCE_PUBKEY_1], [TARGET_PUBKEY_1], { value: fee }),
      ).to.not.be.reverted;
    });

    it("Should allow one source operator to consolidate to multiple targets", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Set up a second target operator
      const TARGET_OPERATOR_ID_2 = 3n;
      const TARGET_PUBKEY_3 = "0x" + "ee".repeat(48);
      await targetModule.mock__setOperatorData(TARGET_OPERATOR_ID_2, 0, [TARGET_PUBKEY_3]);

      // Allow second pair
      await consolidationMigrator.connect(allowPairManager).allowPair(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID_2);

      // Submit batch to first target
      await consolidationMigrator
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0n], [0n]);

      // Submit batch to second target
      await consolidationMigrator
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID_2, [1n], [0n]);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Execute both batches
      await consolidationBus
        .connect(executor)
        .executeConsolidation([SOURCE_PUBKEY_1], [TARGET_PUBKEY_1], { value: fee });

      await consolidationBus
        .connect(executor)
        .executeConsolidation([SOURCE_PUBKEY_2], [TARGET_PUBKEY_3], { value: fee });
    });
  });

  context("Key validation in E2E", () => {
    it("Should revert submitConsolidationBatch if source key is NOT used", async () => {
      // Set up an unused source key
      const UNUSED_SOURCE_PUBKEY = "0x" + "11".repeat(48);
      await sourceModule.mock__setSigningKey(SOURCE_OPERATOR_ID, 2, UNUSED_SOURCE_PUBKEY, false); // NOT used

      await expect(
        consolidationMigrator
          .connect(operatorRewardAddress)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [2n], [0n]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "SourceKeyNotUsed")
        .withArgs(SOURCE_OPERATOR_ID, 2n);
    });

    it("Should revert submitConsolidationBatch if target key is already deposited", async () => {
      // Set target operator with deposited keys (totalDepositedValidators = 1)
      const TARGET_OP_WITH_DEPOSITS = 4n;
      const DEPOSITED_TARGET_PUBKEY = "0x" + "22".repeat(48);
      await targetModule.mock__setOperatorData(TARGET_OP_WITH_DEPOSITS, 1, [DEPOSITED_TARGET_PUBKEY]); // 1 deposited

      // Allow the pair
      await consolidationMigrator.connect(allowPairManager).allowPair(SOURCE_OPERATOR_ID, TARGET_OP_WITH_DEPOSITS);

      // Try to consolidate to already deposited key (index 0 < totalDepositedValidators 1)
      await expect(
        consolidationMigrator
          .connect(operatorRewardAddress)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OP_WITH_DEPOSITS, [0n], [0n]),
      )
        .to.be.revertedWithCustomError(consolidationMigrator, "TargetKeyAlreadyDeposited")
        .withArgs(TARGET_OP_WITH_DEPOSITS, 0n, 1n);
    });
  });

  context("ConsolidationGateway integration", () => {
    it("Should revert executeConsolidation when ConsolidationGateway is paused", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Submit batch first
      await consolidationMigrator
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0n], [0n]);

      // Grant PAUSE_ROLE to agent and pause the gateway
      const agentSigner = await ctx.getSigner("agent");
      const PAUSE_ROLE = await consolidationGateway.PAUSE_ROLE();
      await consolidationGateway.connect(agentSigner).grantRole(PAUSE_ROLE, agentSigner.address);
      await consolidationGateway.connect(agentSigner).pauseFor(3600); // 1 hour

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Try to execute - should revert because gateway is paused
      await expect(
        consolidationBus.connect(executor).executeConsolidation([SOURCE_PUBKEY_1], [TARGET_PUBKEY_1], { value: fee }),
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
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0n], [0n]);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Execute first batch - this should consume the limit
      await consolidationBus
        .connect(executor)
        .executeConsolidation([SOURCE_PUBKEY_1], [TARGET_PUBKEY_1], { value: fee });

      // Submit second batch
      await consolidationMigrator
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [1n], [1n]);

      // Execute second batch - should fail due to rate limit
      await expect(
        consolidationBus.connect(executor).executeConsolidation([SOURCE_PUBKEY_2], [TARGET_PUBKEY_2], { value: fee }),
      ).to.be.revertedWithCustomError(consolidationGateway, "ConsolidationRequestsLimitExceeded");
    });

    it("Should refund excess ETH to executor", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Submit batch
      await consolidationMigrator
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0n], [0n]);

      const fee = await withdrawalVault.getConsolidationRequestFee();
      const excessFee = fee * 10n; // Send 10x the required fee

      const executorBalanceBefore = await ethers.provider.getBalance(executor.address);

      const tx = await consolidationBus
        .connect(executor)
        .executeConsolidation([SOURCE_PUBKEY_1], [TARGET_PUBKEY_1], { value: excessFee });

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
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0n], [0n]);

      // Submit second batch
      await consolidationMigrator
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [1n], [1n]);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Execute first batch
      await consolidationBus
        .connect(executor)
        .executeConsolidation([SOURCE_PUBKEY_1], [TARGET_PUBKEY_1], { value: fee });

      // Verify first batch is executed
      const batchHash1 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [[SOURCE_PUBKEY_1], [TARGET_PUBKEY_1]]),
      );
      expect(await consolidationBus.isBatchAdded(batchHash1)).to.be.false;

      // Execute second batch
      await consolidationBus
        .connect(executor)
        .executeConsolidation([SOURCE_PUBKEY_2], [TARGET_PUBKEY_2], { value: fee });

      // Verify second batch is executed
      const batchHash2 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [[SOURCE_PUBKEY_2], [TARGET_PUBKEY_2]]),
      );
      expect(await consolidationBus.isBatchAdded(batchHash2)).to.be.false;
    });

    it("Should revert executeConsolidation if batch was removed", async () => {
      const { withdrawalVault } = ctx.contracts;

      // Submit batch
      await consolidationMigrator
        .connect(operatorRewardAddress)
        .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0n], [0n]);

      const batchHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "bytes[]"], [[SOURCE_PUBKEY_1], [TARGET_PUBKEY_1]]),
      );

      // Remove batch
      await consolidationBus.connect(admin).removeBatches([batchHash]);

      const fee = await withdrawalVault.getConsolidationRequestFee();

      // Try to execute removed batch
      await expect(
        consolidationBus.connect(executor).executeConsolidation([SOURCE_PUBKEY_1], [TARGET_PUBKEY_1], { value: fee }),
      ).to.be.revertedWithCustomError(consolidationBus, "BatchNotFound");
    });

    it("Should revert addConsolidationRequests if batch size exceeds limit", async () => {
      // Set a very small batch size limit on ConsolidationBus
      await consolidationBus.connect(admin).setBatchSize(1);

      // Try to submit batch with 2 validators (exceeds limit of 1)
      await expect(
        consolidationMigrator
          .connect(operatorRewardAddress)
          .submitConsolidationBatch(SOURCE_OPERATOR_ID, TARGET_OPERATOR_ID, [0n, 1n], [0n, 1n]),
      )
        .to.be.revertedWithCustomError(consolidationBus, "BatchTooLarge")
        .withArgs(2, 1);
    });
  });
});
