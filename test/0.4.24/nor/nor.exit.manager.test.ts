import { expect } from "chai";
import { encodeBytes32String } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ACL,
  Kernel,
  Lido,
  LidoLocator,
  LidoLocator__factory,
  MinFirstAllocationStrategy__factory,
  NodeOperatorsRegistry__Harness,
  NodeOperatorsRegistry__Harness__factory,
} from "typechain-types";
import { NodeOperatorsRegistryLibraryAddresses } from "typechain-types/factories/contracts/0.4.24/nos/NodeOperatorsRegistry.sol/NodeOperatorsRegistry__factory";

import { addNodeOperator, certainAddress, NodeOperatorConfig, RewardDistributionState } from "lib";

import { addAragonApp, deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

describe("NodeOperatorsRegistry.sol:ExitManager", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let nodeOperatorsManager: HardhatEthersSigner;
  let signingKeysManager: HardhatEthersSigner;
  let stakingRouter: HardhatEthersSigner;
  let lido: Lido;
  let dao: Kernel;
  let acl: ACL;
  let locator: LidoLocator;

  let impl: NodeOperatorsRegistry__Harness;
  let nor: NodeOperatorsRegistry__Harness;

  let originalState: string;

  const firstNodeOperatorId = 0;

  const NODE_OPERATORS: NodeOperatorConfig[] = [
    {
      name: "testOperator",
      rewardAddress: certainAddress("node-operator-1"),
      totalSigningKeysCount: 10n,
      depositedSigningKeysCount: 5n,
      exitedSigningKeysCount: 1n,
      vettedSigningKeysCount: 6n,
      stuckValidatorsCount: 0n,
      refundedValidatorsCount: 0n,
      stuckPenaltyEndAt: 0n,
    },
  ];

  const moduleType = encodeBytes32String("curated-onchain-v1");
  const exitDeadlineThreshold = 86400n;

  const testPublicKey = "0x" + "0".repeat(48 * 2);
  const ONE_DAY = 86400n;
  const eligibleToExitInSec = ONE_DAY;

  let proofSlotTimestamp = 0n;
  const withdrawalRequestPaidFee = 100000n;
  const exitType = 1n;

  before(async () => {
    [deployer, user, stakingRouter, nodeOperatorsManager, signingKeysManager, stranger] = await ethers.getSigners();

    ({ lido, dao, acl } = await deployLidoDao({
      rootAccount: deployer,
      initialized: true,
      locatorConfig: {
        stakingRouter,
      },
    }));

    const allocLib = await new MinFirstAllocationStrategy__factory(deployer).deploy();
    const allocLibAddr: NodeOperatorsRegistryLibraryAddresses = {
      ["__contracts/common/lib/MinFirstAllocat__"]: await allocLib.getAddress(),
    };

    impl = await new NodeOperatorsRegistry__Harness__factory(allocLibAddr, deployer).deploy();
    const appProxy = await addAragonApp({
      dao,
      name: "node-operators-registry",
      impl,
      rootAccount: deployer,
    });

    nor = NodeOperatorsRegistry__Harness__factory.connect(appProxy, deployer);

    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);

    await acl.createPermission(stakingRouter, nor, await nor.STAKING_ROUTER_ROLE(), deployer);
    await acl.createPermission(signingKeysManager, nor, await nor.MANAGE_SIGNING_KEYS(), deployer);
    await acl.createPermission(nodeOperatorsManager, nor, await nor.MANAGE_NODE_OPERATOR_ROLE(), deployer);

    // grant role to nor itself cause it uses solidity's call method to itself
    // inside the harness__requestValidatorsKeysForDeposits() method
    await acl.grantPermission(nor, nor, await nor.STAKING_ROUTER_ROLE());

    locator = LidoLocator__factory.connect(await lido.getLidoLocator(), user);

    // Initialize the nor's proxy
    const tx = nor.initialize(locator, moduleType, exitDeadlineThreshold);
    await expect(tx).to.emit(nor, "RewardDistributionStateChanged").withArgs(RewardDistributionState.Distributed);
    const txRes = await tx;
    proofSlotTimestamp = BigInt((await txRes.getBlock())!.timestamp);
    // Add a node operator for testing
    expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
      firstNodeOperatorId,
    );

    nor = nor.connect(user);
    originalState = await Snapshot.take();
  });

  afterEach(async () => (originalState = await Snapshot.refresh(originalState)));

  context("backward compatibility test", () => {
    it("isOperatorPenalized", async () => {
      expect(await nor.isOperatorPenalized(firstNodeOperatorId)).to.be.false;
    });

    it("isOperatorPenaltyCleared", async () => {
      expect(await nor.isOperatorPenaltyCleared(firstNodeOperatorId)).to.be.true;
    });
    it("getStuckPenaltyDelay", async () => {
      expect(await nor.getStuckPenaltyDelay()).to.be.equal(0n);
    });
  });

  context("reportValidatorExitDelay", () => {
    it("reverts when called by sender without STAKING_ROUTER_ROLE", async () => {
      expect(await acl["hasPermission(address,address,bytes32)"](stranger, nor, await nor.STAKING_ROUTER_ROLE())).to.be
        .false;

      await expect(
        nor
          .connect(stranger)
          .reportValidatorExitDelay(firstNodeOperatorId, proofSlotTimestamp, testPublicKey, eligibleToExitInSec),
      ).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("emits events when called by sender with STAKING_ROUTER_ROLE", async () => {
      expect(await acl["hasPermission(address,address,bytes32)"](stakingRouter, nor, await nor.STAKING_ROUTER_ROLE()))
        .to.be.true;

      await expect(
        nor
          .connect(stakingRouter)
          .reportValidatorExitDelay(firstNodeOperatorId, proofSlotTimestamp, testPublicKey, eligibleToExitInSec),
      )
        .and.to.emit(nor, "ValidatorExitStatusUpdated")
        .withArgs(firstNodeOperatorId, testPublicKey, eligibleToExitInSec, proofSlotTimestamp);
    });

    it("reverts when public key is empty", async () => {
      await expect(
        nor
          .connect(stakingRouter)
          .reportValidatorExitDelay(firstNodeOperatorId, proofSlotTimestamp, "0x", eligibleToExitInSec),
      ).to.be.revertedWith("INVALID_PUBLIC_KEY");
    });

    it("reverts when reporting the same validator key twice", async () => {
      await nor
        .connect(stakingRouter)
        .reportValidatorExitDelay(firstNodeOperatorId, proofSlotTimestamp, testPublicKey, eligibleToExitInSec);
      const tx = nor
        .connect(stakingRouter)
        .reportValidatorExitDelay(firstNodeOperatorId, proofSlotTimestamp, testPublicKey, eligibleToExitInSec);

      await expect(tx).to.not.be.reverted;
      await expect(tx).to.not.emit(nor, "ValidatorExitStatusUpdated");
    });
  });

  context("onValidatorExitTriggered", () => {
    it("reverts when called by sender without STAKING_ROUTER_ROLE", async () => {
      expect(await acl["hasPermission(address,address,bytes32)"](stranger, nor, await nor.STAKING_ROUTER_ROLE())).to.be
        .false;

      await expect(
        nor
          .connect(stakingRouter)
          .reportValidatorExitDelay(firstNodeOperatorId, proofSlotTimestamp, testPublicKey, eligibleToExitInSec),
      )
        .and.to.emit(nor, "ValidatorExitStatusUpdated")
        .withArgs(firstNodeOperatorId, testPublicKey, eligibleToExitInSec, proofSlotTimestamp);

      await expect(
        nor
          .connect(stranger)
          .onValidatorExitTriggered(firstNodeOperatorId, testPublicKey, withdrawalRequestPaidFee, exitType),
      ).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("emits an event when called by sender with STAKING_ROUTER_ROLE", async () => {
      expect(await acl["hasPermission(address,address,bytes32)"](stakingRouter, nor, await nor.STAKING_ROUTER_ROLE()))
        .to.be.true;

      await expect(
        nor
          .connect(stakingRouter)
          .reportValidatorExitDelay(firstNodeOperatorId, proofSlotTimestamp, testPublicKey, eligibleToExitInSec),
      )
        .and.to.emit(nor, "ValidatorExitStatusUpdated")
        .withArgs(firstNodeOperatorId, testPublicKey, eligibleToExitInSec, proofSlotTimestamp);

      await expect(
        nor
          .connect(stakingRouter)
          .onValidatorExitTriggered(firstNodeOperatorId, testPublicKey, withdrawalRequestPaidFee, exitType),
      )
        .to.emit(nor, "ValidatorExitTriggered")
        .withArgs(firstNodeOperatorId, testPublicKey, withdrawalRequestPaidFee, exitType);
    });
  });

  context("exitDeadlineThreshold", () => {
    it("returns the expected value", async () => {
      const threshold = await nor.exitDeadlineThreshold(0);
      expect(threshold).to.equal(86400n);
    });
  });

  context("isValidatorExitDelayPenaltyApplicable", () => {
    it("returns true when eligible to exit time exceeds the threshold", async () => {
      const shouldPenalize = await nor.isValidatorExitDelayPenaltyApplicable(
        firstNodeOperatorId,
        proofSlotTimestamp + ONE_DAY,
        testPublicKey,
        eligibleToExitInSec, // Equal to the threshold
      );
      expect(shouldPenalize).to.be.true;

      const shouldPenalizeMore = await nor.isValidatorExitDelayPenaltyApplicable(
        firstNodeOperatorId,
        proofSlotTimestamp + ONE_DAY,
        testPublicKey,
        eligibleToExitInSec + 1n, // Greater than the threshold
      );
      expect(shouldPenalizeMore).to.be.true;
    });

    it("returns false when eligible to exit time is less than the threshold", async () => {
      const shouldPenalize = await nor.isValidatorExitDelayPenaltyApplicable(
        firstNodeOperatorId,
        proofSlotTimestamp + ONE_DAY,
        testPublicKey,
        1n, // Less than the threshold
      );
      expect(shouldPenalize).to.be.false;
    });
  });

  context("exitPenaltyCutoffTimestamp", () => {
    const reportingWindow = 3600n; // 1 hour

    let cutoff: bigint;

    beforeEach(async () => {
      await deployer.provider.send("hardhat_mine", [
        `0x${(BigInt(await deployer.provider.getBlockNumber()) + 3000n).toString(16)}`,
        12000,
      ]);

      const tx = await nor
        .connect(nodeOperatorsManager)
        .setExitDeadlineThreshold(exitDeadlineThreshold, reportingWindow);

      // Fetch actual cutoff timestamp from the contract
      cutoff = BigInt(await nor.exitPenaltyCutoffTimestamp());

      // Get the block timestamp of the transaction
      const block = await deployer.provider.getBlock(tx.blockNumber!);
      const expectedCutoff = BigInt(block!.timestamp) - exitDeadlineThreshold - reportingWindow;

      // Ensure cutoff was set correctly
      expect(cutoff).to.equal(expectedCutoff);
    });

    it("reverts oldCutoffTimestamp <= currentCutoffTimestamp", async () => {
      await expect(
        nor.connect(nodeOperatorsManager).setExitDeadlineThreshold(eligibleToExitInSec, eligibleToExitInSec + 100_000n),
      ).to.be.revertedWith("INVALID_EXIT_PENALTY_CUTOFF_TIMESTAMP");
    });

    it("returns false when _proofSlotTimestamp < cutoff", async () => {
      const result = await nor.isValidatorExitDelayPenaltyApplicable(
        firstNodeOperatorId,
        cutoff + exitDeadlineThreshold - 1n,
        testPublicKey,
        exitDeadlineThreshold,
      );
      expect(result).to.be.false;
    });

    it("returns true when _proofSlotTimestamp == cutoff", async () => {
      const result = await nor.isValidatorExitDelayPenaltyApplicable(
        firstNodeOperatorId,
        cutoff + exitDeadlineThreshold,
        testPublicKey,
        exitDeadlineThreshold,
      );
      expect(result).to.be.true;
    });

    it("returns true when _proofSlotTimestamp > cutoff", async () => {
      const result = await nor.isValidatorExitDelayPenaltyApplicable(
        firstNodeOperatorId,
        cutoff + exitDeadlineThreshold + 1n,
        testPublicKey,
        exitDeadlineThreshold,
      );
      expect(result).to.be.true;
    });

    it("reverts reportValidatorExitDelay when _proofSlotTimestamp < cutoff", async () => {
      await expect(
        nor
          .connect(stakingRouter)
          .reportValidatorExitDelay(
            firstNodeOperatorId,
            cutoff + exitDeadlineThreshold - 1n,
            testPublicKey,
            eligibleToExitInSec,
          ),
      ).to.be.revertedWith("TOO_LATE_FOR_EXIT_DELAY_REPORT");
    });

    it("emits event when reportValidatorExitDelay is called with _proofSlotTimestamp >= cutoff", async () => {
      await expect(
        nor
          .connect(stakingRouter)
          .reportValidatorExitDelay(
            firstNodeOperatorId,
            cutoff + exitDeadlineThreshold,
            testPublicKey,
            eligibleToExitInSec,
          ),
      )
        .to.emit(nor, "ValidatorExitStatusUpdated")
        .withArgs(firstNodeOperatorId, testPublicKey, eligibleToExitInSec, cutoff + exitDeadlineThreshold);

      const result = await nor.isValidatorExitDelayPenaltyApplicable(
        firstNodeOperatorId,
        cutoff + exitDeadlineThreshold,
        testPublicKey,
        eligibleToExitInSec,
      );
      expect(result).to.be.false;
    });
  });

  context("isValidatorExitingKeyReported", () => {
    it("returns false for keys that haven't been reported yet", async () => {
      const result = await nor.isValidatorExitingKeyReported(testPublicKey);
      expect(result).to.be.false;
    });

    it("returns true for keys that have been reported", async () => {
      expect(await nor.isValidatorExitingKeyReported(testPublicKey)).to.be.false;

      await nor
        .connect(stakingRouter)
        .reportValidatorExitDelay(firstNodeOperatorId, proofSlotTimestamp, testPublicKey, eligibleToExitInSec);

      expect(await nor.isValidatorExitingKeyReported(testPublicKey)).to.be.true;
    });

    it("correctly distinguishes between different validator keys", async () => {
      const testPublicKey2 = "0x" + "1".repeat(48 * 2);

      await nor
        .connect(stakingRouter)
        .reportValidatorExitDelay(firstNodeOperatorId, proofSlotTimestamp, testPublicKey, eligibleToExitInSec);

      expect(await nor.isValidatorExitingKeyReported(testPublicKey)).to.be.true;

      expect(await nor.isValidatorExitingKeyReported(testPublicKey2)).to.be.false;
    });
  });
});
