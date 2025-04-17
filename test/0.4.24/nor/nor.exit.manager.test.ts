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
    }
  ];

  const moduleType = encodeBytes32String("curated-onchain-v1");
  const penaltyDelay = 86400n;

  const testPublicKey = "0x123456";
  const eligibleToExitInSec = 172800n; // 2 days
  const proofSlotTimestamp = 1234567890n;
  const withdrawalRequestPaidFee = 100000n;
  const exitType = 1n;

  before(async () => {
    [deployer, user, stakingRouter, nodeOperatorsManager, signingKeysManager, stranger] =
      await ethers.getSigners();

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
    await expect(nor.initialize(locator, moduleType, penaltyDelay))
      .to.emit(nor, "RewardDistributionStateChanged")
      .withArgs(RewardDistributionState.Distributed);

    // Add a node operator for testing
    expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
      firstNodeOperatorId,
    );

    nor = nor.connect(user);
    originalState = await Snapshot.take();
  });

  afterEach(async () => (originalState = await Snapshot.refresh(originalState)));

  context("reportValidatorExitDelay", () => {
    it("reverts when called by sender without STAKING_ROUTER_ROLE", async () => {
      expect(await acl["hasPermission(address,address,bytes32)"](stranger, nor, await nor.STAKING_ROUTER_ROLE())).to.be
        .false;

      await expect(
        nor.connect(stranger).reportValidatorExitDelay(
          firstNodeOperatorId,
          proofSlotTimestamp,
          testPublicKey,
          eligibleToExitInSec
        )
      ).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("emits events when called by sender with STAKING_ROUTER_ROLE", async () => {
      expect(await acl["hasPermission(address,address,bytes32)"](stakingRouter, nor, await nor.STAKING_ROUTER_ROLE()))
        .to.be.true;

      await expect(
        nor.connect(stakingRouter).reportValidatorExitDelay(
          firstNodeOperatorId,
          proofSlotTimestamp,
          testPublicKey,
          eligibleToExitInSec
        )
      )
        .to.emit(nor, "PenaltyApplied")
        .withArgs(firstNodeOperatorId, testPublicKey, ethers.parseEther("1"), "EXCESS_EXIT_TIME")
        .and.to.emit(nor, "ValidatorExitStatusUpdated")
        .withArgs(firstNodeOperatorId, testPublicKey, eligibleToExitInSec, proofSlotTimestamp);
    });

    it("reverts when public key is empty", async () => {
      await expect(
        nor.connect(stakingRouter).reportValidatorExitDelay(
          firstNodeOperatorId,
          proofSlotTimestamp,
          "0x",
          eligibleToExitInSec
        )
      ).to.be.revertedWith("INVALID_PUBLIC_KEY");
    });
  });

  context("onValidatorExitTriggered", () => {
    it("reverts when called by sender without STAKING_ROUTER_ROLE", async () => {
      expect(await acl["hasPermission(address,address,bytes32)"](stranger, nor, await nor.STAKING_ROUTER_ROLE())).to.be
        .false;

      await expect(
        nor.connect(stranger).onValidatorExitTriggered(
          firstNodeOperatorId,
          testPublicKey,
          withdrawalRequestPaidFee,
          exitType
        )
      ).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("emits an event when called by sender with STAKING_ROUTER_ROLE", async () => {
      expect(await acl["hasPermission(address,address,bytes32)"](stakingRouter, nor, await nor.STAKING_ROUTER_ROLE()))
        .to.be.true;

      await expect(
        nor.connect(stakingRouter).onValidatorExitTriggered(
          firstNodeOperatorId,
          testPublicKey,
          withdrawalRequestPaidFee,
          exitType
        )
      )
        .to.emit(nor, "TriggerableExitFeeSet")
        .withArgs(firstNodeOperatorId, testPublicKey, withdrawalRequestPaidFee, exitType);
    });

    it("reverts when public key is empty", async () => {
      await expect(
        nor.connect(stakingRouter).onValidatorExitTriggered(
          firstNodeOperatorId,
          "0x",
          withdrawalRequestPaidFee,
          exitType
        )
      ).to.be.revertedWith("INVALID_PUBLIC_KEY");
    });
  });

  context("exitDeadlineThreshold", () => {
    it("returns the expected value", async () => {
      const threshold = await nor.exitDeadlineThreshold(firstNodeOperatorId);
      expect(threshold).to.equal(172800n); // 2 days in seconds
    });
  });

  context("isValidatorExitDelayPenaltyApplicable", () => {
    it("returns true when eligible to exit time exceeds the threshold", async () => {
      const shouldPenalize = await nor.isValidatorExitDelayPenaltyApplicable(
        firstNodeOperatorId,
        proofSlotTimestamp,
        testPublicKey,
        172800n // Equal to the threshold
      );
      expect(shouldPenalize).to.be.true;

      const shouldPenalizeMore = await nor.isValidatorExitDelayPenaltyApplicable(
        firstNodeOperatorId,
        proofSlotTimestamp,
        testPublicKey,
        172801n // Greater than the threshold
      );
      expect(shouldPenalizeMore).to.be.true;
    });

    it("returns false when eligible to exit time is less than the threshold", async () => {
      const shouldPenalize = await nor.isValidatorExitDelayPenaltyApplicable(
        firstNodeOperatorId,
        proofSlotTimestamp,
        testPublicKey,
        172799n // Less than the threshold
      );
      expect(shouldPenalize).to.be.false;
    });
  });
});
