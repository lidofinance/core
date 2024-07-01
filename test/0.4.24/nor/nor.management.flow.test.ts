import { expect } from "chai";
import { encodeBytes32String, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ACL,
  Kernel,
  Lido,
  LidoLocator,
  LidoLocator__factory,
  NodeOperatorsRegistry__Harness,
  NodeOperatorsRegistry__Harness__factory,
} from "typechain-types";

import { addNodeOperator, certainAddress, NodeOperatorConfig, randomAddress } from "lib";

import { addAragonApp, deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

describe("NodeOperatorsRegistry:management", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let limitsManager: HardhatEthersSigner;
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
  const secondNodeOperatorId = 1;
  const thirdNodeOperatorId = 2;

  const NODE_OPERATORS: NodeOperatorConfig[] = [
    {
      name: "foo",
      rewardAddress: certainAddress("node-operator-1"),
      totalSigningKeysCount: 10n,
      depositedSigningKeysCount: 5n,
      exitedSigningKeysCount: 1n,
      vettedSigningKeysCount: 6n,
      stuckValidatorsCount: 0n,
      refundedValidatorsCount: 0n,
      stuckPenaltyEndAt: 0n,
    },
    {
      name: " bar",
      rewardAddress: certainAddress("node-operator-2"),
      totalSigningKeysCount: 15n,
      depositedSigningKeysCount: 7n,
      exitedSigningKeysCount: 0n,
      vettedSigningKeysCount: 10n,
      stuckValidatorsCount: 0n,
      refundedValidatorsCount: 0n,
      stuckPenaltyEndAt: 0n,
    },
    {
      name: "deactivated",
      isActive: false,
      rewardAddress: certainAddress("node-operator-3"),
      totalSigningKeysCount: 10n,
      depositedSigningKeysCount: 0n,
      exitedSigningKeysCount: 0n,
      vettedSigningKeysCount: 5n,
      stuckValidatorsCount: 0n,
      refundedValidatorsCount: 0n,
      stuckPenaltyEndAt: 0n,
    },
  ];

  const moduleType = encodeBytes32String("curated-onchain-v1");
  const penaltyDelay = 86400n;
  const contractVersion = 2n;

  before(async () => {
    [deployer, user, stakingRouter, nodeOperatorsManager, signingKeysManager, limitsManager] =
      await ethers.getSigners();

    ({ lido, dao, acl } = await deployLidoDao({
      rootAccount: deployer,
      initialized: true,
      locatorConfig: {
        stakingRouter,
      },
    }));

    impl = await new NodeOperatorsRegistry__Harness__factory(deployer).deploy();
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
    await acl.createPermission(limitsManager, nor, await nor.SET_NODE_OPERATOR_LIMIT_ROLE(), deployer);

    // grant role to nor itself cause it uses solidity's call method to itself
    // inside the testing_requestValidatorsKeysForDeposits() method
    await acl.grantPermission(nor, nor, await nor.STAKING_ROUTER_ROLE());

    locator = LidoLocator__factory.connect(await lido.getLidoLocator(), user);

    // Initialize the nor's proxy.
    await expect(nor.initialize(locator, moduleType, penaltyDelay))
      .to.emit(nor, "ContractVersionSet")
      .withArgs(contractVersion)
      .and.to.emit(nor, "LocatorContractSet")
      .withArgs(locator)
      .and.to.emit(nor, "StakingModuleTypeSet")
      .withArgs(moduleType);

    nor = nor.connect(user);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("addNodeOperator", () => {
    beforeEach(async () => {});

    it("Reverts if invalid name", async () => {
      await expect(nor.addNodeOperator("", certainAddress("reward-address-0"))).to.be.revertedWith("WRONG_NAME_LENGTH");

      const maxLength = await nor.MAX_NODE_OPERATOR_NAME_LENGTH();

      const longName = "x".repeat(Number(maxLength + 1n));
      await expect(nor.addNodeOperator(longName, certainAddress("reward-address-0"))).to.be.revertedWith(
        "WRONG_NAME_LENGTH",
      );
    });

    it("Reverts if invalid reward address", async () => {
      await expect(nor.addNodeOperator("abcdef", ZeroAddress)).to.be.revertedWith("ZERO_ADDRESS");

      await expect(nor.addNodeOperator("abcdef", lido)).to.be.revertedWith("LIDO_REWARD_ADDRESS");
    });

    it("Reverts if has no MANAGE_NODE_OPERATOR_ROLE assigned", async () => {
      await expect(nor.addNodeOperator("abcdef", certainAddress("reward-address-0"))).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );
    });

    it("Reverts if MAX_NODE_OPERATORS_COUNT exceeded", async () => {
      const maxNodeOperators = await nor.MAX_NODE_OPERATORS_COUNT();

      const promises = [];
      for (let i = 0n; i < maxNodeOperators; ++i) {
        promises.push(nor.connect(nodeOperatorsManager).addNodeOperator(i.toString(), randomAddress()));
      }
      await Promise.all(promises);

      await expect(
        nor.connect(nodeOperatorsManager).addNodeOperator("abcdef", certainAddress("reward-address-0")),
      ).to.be.revertedWith("MAX_OPERATORS_COUNT_EXCEEDED");
    });

    it("Adds a new node operator", async () => {
      for (let i = 0n; i < 10n; ++i) {
        const id = i;
        const name = "no " + i.toString();
        const rewardAddress = certainAddress("reward-address-" + i.toString());

        await expect(nor.connect(nodeOperatorsManager).addNodeOperator(name, rewardAddress))
          .to.emit(nor, "NodeOperatorAdded")
          .withArgs(id, name, rewardAddress, 0n);

        expect(await nor.getNodeOperatorsCount()).to.equal(id + 1n);
        const nodeOperator = await nor.getNodeOperator(id, true);

        expect(nodeOperator.active).to.be.true;
        expect(nodeOperator.name).to.equal(name);
        expect(nodeOperator.rewardAddress).to.equal(rewardAddress);
        expect(nodeOperator.totalVettedValidators).to.equal(0n);
        expect(nodeOperator.totalExitedValidators).to.equal(0n);
        expect(nodeOperator.totalAddedValidators).to.equal(0n);
        expect(nodeOperator.totalDepositedValidators).to.equal(0n);
      }
    });
  });

  context("activateNodeOperator", () => {
    beforeEach(async () => {
      await nor.connect(nodeOperatorsManager).addNodeOperator("abcdef", randomAddress());

      expect(await nor.getNodeOperatorIsActive(0n)).to.be.true;
      await nor.connect(nodeOperatorsManager).deactivateNodeOperator(0n);
      expect(await nor.getNodeOperatorIsActive(0n)).to.be.false;
    });

    it("Reverts if no such an operator exists", async () => {
      await expect(nor.activateNodeOperator(1n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if has no MANAGE_NODE_OPERATOR_ROLE assigned", async () => {
      await expect(nor.activateNodeOperator(0n)).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Reverts if already active", async () => {
      await nor.connect(nodeOperatorsManager).addNodeOperator("second", randomAddress());

      await expect(nor.connect(nodeOperatorsManager).activateNodeOperator(1n)).to.be.revertedWith(
        "WRONG_OPERATOR_ACTIVE_STATE",
      );
    });

    it("Activates an inactive node operator", async () => {
      await expect(nor.connect(nodeOperatorsManager).activateNodeOperator(0n))
        .to.emit(nor, "NodeOperatorActiveSet")
        .withArgs(0n, true)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(2n);

      const nodeOperator = await nor.getNodeOperator(0n, true);
      expect(nodeOperator.active).to.be.true;
      expect(await nor.getNodeOperatorIsActive(0n)).to.be.true;
    });
  });

  context("deactivateNodeOperator", () => {
    beforeEach(async () => {
      await nor.connect(nodeOperatorsManager).addNodeOperator("abcdef", randomAddress());
      expect(await nor.getNodeOperatorIsActive(0n)).to.be.true;
    });

    it("Reverts if no such an operator exists", async () => {
      await expect(nor.deactivateNodeOperator(1n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if has no MANAGE_NODE_OPERATOR_ROLE assigned", async () => {
      await expect(nor.deactivateNodeOperator(0n)).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Reverts if already inactive", async () => {
      await nor.connect(nodeOperatorsManager).addNodeOperator("second", randomAddress());
      await nor.connect(nodeOperatorsManager).deactivateNodeOperator(1n);

      await expect(nor.connect(nodeOperatorsManager).deactivateNodeOperator(1n)).to.be.revertedWith(
        "WRONG_OPERATOR_ACTIVE_STATE",
      );
    });

    it("Deactivates an active node operator", async () => {
      await expect(nor.connect(nodeOperatorsManager).deactivateNodeOperator(0n))
        .to.emit(nor, "NodeOperatorActiveSet")
        .withArgs(0n, false)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(1n);

      const nodeOperator = await nor.getNodeOperator(0n, true);
      expect(nodeOperator.active).to.be.false;
      expect(await nor.getNodeOperatorIsActive(0n)).to.be.false;
    });
  });

  context("setNodeOperatorName", () => {
    beforeEach(async () => {
      await nor.connect(nodeOperatorsManager).addNodeOperator("abcdef", randomAddress());
      expect(await nor.getNodeOperatorIsActive(0n)).to.be.true;
    });

    it("Reverts if the invalid name", async () => {
      await expect(nor.setNodeOperatorName(0n, "")).to.be.revertedWith("WRONG_NAME_LENGTH");

      const maxLength = await nor.MAX_NODE_OPERATOR_NAME_LENGTH();

      const longName = "x".repeat(Number(maxLength + 1n));
      await expect(nor.setNodeOperatorName(0n, longName)).to.be.revertedWith("WRONG_NAME_LENGTH");
    });

    it("Reverts if no such an operator exists", async () => {
      await expect(nor.setNodeOperatorName(1n, "node-operator-0")).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if has no MANAGE_NODE_OPERATOR_ROLE assigned", async () => {
      await expect(nor.setNodeOperatorName(0n, "node-operator-0")).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Reverts if already has the same name", async () => {
      await expect(nor.connect(nodeOperatorsManager).setNodeOperatorName(0n, "abcdef")).to.be.revertedWith(
        "VALUE_IS_THE_SAME",
      );
    });

    it("Renames an existing node operator", async () => {
      await expect(nor.connect(nodeOperatorsManager).setNodeOperatorName(0n, "node-operator-0"))
        .to.emit(nor, "NodeOperatorNameSet")
        .withArgs(0n, "node-operator-0");

      const nodeOperator = await nor.getNodeOperator(0n, true);
      expect(nodeOperator.name).to.be.equal("node-operator-0");
    });
  });

  context("setNodeOperatorRewardAddress", () => {
    beforeEach(async () => {
      await nor.connect(nodeOperatorsManager).addNodeOperator("abcdef", certainAddress("node-operator-0"));
      expect(await nor.getNodeOperatorIsActive(0n)).to.be.true;
    });

    it("Reverts if invalid reward address", async () => {
      await expect(nor.setNodeOperatorRewardAddress(0n, ZeroAddress)).to.be.revertedWith("ZERO_ADDRESS");

      await expect(nor.setNodeOperatorRewardAddress(0n, lido)).to.be.revertedWith("LIDO_REWARD_ADDRESS");
    });

    it("Reverts if no such an operator exists", async () => {
      await expect(nor.setNodeOperatorRewardAddress(1n, randomAddress())).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if has no MANAGE_NODE_OPERATOR_ROLE assigned", async () => {
      await expect(nor.setNodeOperatorRewardAddress(0n, randomAddress())).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Reverts if already has the same address", async () => {
      await expect(
        nor.connect(nodeOperatorsManager).setNodeOperatorRewardAddress(0n, certainAddress("node-operator-0")),
      ).to.be.revertedWith("VALUE_IS_THE_SAME");
    });

    it("Sets a reward address for an existing node operator", async () => {
      const addr = certainAddress("new-address");
      await expect(nor.connect(nodeOperatorsManager).setNodeOperatorRewardAddress(0n, addr))
        .to.emit(nor, "NodeOperatorRewardAddressSet")
        .withArgs(0n, addr);

      const nodeOperator = await nor.getNodeOperator(0n, true);
      expect(nodeOperator.rewardAddress).to.be.equal(addr);
    });
  });

  context("setNodeOperatorStakingLimit", () => {
    beforeEach(async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.be.equal(
        secondNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[thirdNodeOperatorId])).to.be.equal(
        thirdNodeOperatorId,
      );
    });

    it("Reverts if no such an operator exists", async () => {
      await expect(nor.setNodeOperatorStakingLimit(5n, 10n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if no SET_NODE_OPERATOR_LIMIT_ROLE assigned", async () => {
      await expect(nor.setNodeOperatorStakingLimit(firstNodeOperatorId, 0n)).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Reverts if the node operator is inactive", async () => {
      await expect(nor.connect(limitsManager).setNodeOperatorStakingLimit(thirdNodeOperatorId, 0n)).to.be.revertedWith(
        "WRONG_OPERATOR_ACTIVE_STATE",
      );
    });

    it("Does nothing if vetted keys count stays the same", async () => {
      const vetted = (await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators;

      await expect(nor.connect(limitsManager).setNodeOperatorStakingLimit(firstNodeOperatorId, vetted)).to.not.emit(
        nor,
        "VettedSigningKeysCountChanged",
      );
    });

    it("Able to set decrease vetted keys count", async () => {
      const oldVetted = 6n;
      const newVetted = 5n;
      expect(newVetted < oldVetted);

      expect((await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators).to.be.equal(oldVetted);
      const oldNonce = await nor.getNonce();

      await expect(nor.connect(limitsManager).setNodeOperatorStakingLimit(firstNodeOperatorId, newVetted))
        .to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, newVetted)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(oldNonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(oldNonce + 1n);

      expect((await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators).to.be.equal(newVetted);
    });

    it("Able to increase vetted keys count", async () => {
      const oldVetted = 6n;
      const newVetted = 8n;
      expect(newVetted > oldVetted);

      expect((await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators).to.be.equal(oldVetted);
      const oldNonce = await nor.getNonce();

      await expect(nor.connect(limitsManager).setNodeOperatorStakingLimit(firstNodeOperatorId, newVetted))
        .to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, newVetted)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(oldNonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(oldNonce + 1n);

      expect((await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators).to.be.equal(newVetted);
    });

    it("Vetted keys count can only be ≥ deposited", async () => {
      const oldVetted = 6n;
      const vettedBelowDeposited = 3n;

      expect(vettedBelowDeposited < oldVetted);
      const firstNo = await nor.getNodeOperator(firstNodeOperatorId, false);
      expect(vettedBelowDeposited < firstNo.totalDepositedValidators);

      expect((await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators).to.be.equal(oldVetted);
      const oldNonce = await nor.getNonce();

      await expect(
        nor.connect(limitsManager).setNodeOperatorStakingLimit(firstNodeOperatorId, firstNo.totalDepositedValidators),
      )
        .to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, firstNo.totalDepositedValidators)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(oldNonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(oldNonce + 1n);

      expect((await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators).to.be.equal(
        firstNo.totalDepositedValidators,
      );
    });

    it("Vetted keys count can only be ≤ total added", async () => {
      const oldVetted = 6n;
      const vettedAboveTotal = 11n;

      expect(vettedAboveTotal > oldVetted);
      const firstNo = await nor.getNodeOperator(firstNodeOperatorId, false);
      expect(vettedAboveTotal > firstNo.totalAddedValidators);

      expect((await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators).to.be.equal(oldVetted);
      const oldNonce = await nor.getNonce();

      await expect(
        nor.connect(limitsManager).setNodeOperatorStakingLimit(firstNodeOperatorId, firstNo.totalAddedValidators),
      )
        .to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, firstNo.totalAddedValidators)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(oldNonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(oldNonce + 1n);

      expect((await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators).to.be.equal(
        firstNo.totalAddedValidators,
      );
    });
  });

  context("getNodeOperator", () => {
    beforeEach(async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.be.equal(
        secondNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[thirdNodeOperatorId])).to.be.equal(
        thirdNodeOperatorId,
      );
    });

    it("Reverts if no such an operator exists", async () => {
      await expect(nor.getNodeOperator(3n, false)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Returns short info without name", async () => {
      const noInfo = await nor.getNodeOperator(secondNodeOperatorId, false);

      expect(noInfo.active).to.be.true;
      expect(noInfo.name).to.be.empty;
      expect(noInfo.rewardAddress).to.be.equal(NODE_OPERATORS[secondNodeOperatorId].rewardAddress);
      expect(noInfo.totalVettedValidators).to.be.equal(NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount);
      expect(noInfo.totalExitedValidators).to.be.equal(NODE_OPERATORS[secondNodeOperatorId].exitedSigningKeysCount);
      expect(noInfo.totalAddedValidators).to.be.equal(NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount);
      expect(noInfo.totalDepositedValidators).to.be.equal(
        NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount,
      );
    });

    it("Returns full info with name", async () => {
      const noInfo = await nor.getNodeOperator(secondNodeOperatorId, true);

      expect(noInfo.active).to.be.true;
      expect(noInfo.name).to.be.equal(NODE_OPERATORS[secondNodeOperatorId].name);
      expect(noInfo.rewardAddress).to.be.equal(NODE_OPERATORS[secondNodeOperatorId].rewardAddress);
      expect(noInfo.totalVettedValidators).to.be.equal(NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount);
      expect(noInfo.totalExitedValidators).to.be.equal(NODE_OPERATORS[secondNodeOperatorId].exitedSigningKeysCount);
      expect(noInfo.totalAddedValidators).to.be.equal(NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount);
      expect(noInfo.totalDepositedValidators).to.be.equal(
        NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount,
      );
    });
  });

  context("getType", () => {
    it("Returns module type", async () => {
      expect(await nor.getType()).to.be.equal(moduleType);
    });
  });

  context("getStakingModuleSummary", () => {
    it("Returns zeros if no operators yet", async () => {
      const summary = await nor.getStakingModuleSummary();

      expect(summary.totalExitedValidators).to.be.equal(0n);
      expect(summary.totalDepositedValidators).to.be.equal(0n);
      expect(summary.depositableValidatorsCount).to.be.equal(0n);
    });

    it("Returns summarized key stats", async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.be.equal(
        secondNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[thirdNodeOperatorId])).to.be.equal(
        thirdNodeOperatorId,
      );

      const summary = await nor.getStakingModuleSummary();

      expect(summary.totalExitedValidators).to.be.equal(1n + 0n + 0n);
      expect(summary.totalDepositedValidators).to.be.equal(5n + 7n + 0n);
      expect(summary.depositableValidatorsCount).to.be.equal(1n + 3n + 0n);
    });
  });

  context("getNodeOperatorSummary", () => {
    it("Reverts if no such an operator exists", async () => {
      await expect(nor.getNodeOperatorSummary(10n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Returns zeros for a new node operator", async () => {
      await nor.connect(nodeOperatorsManager).addNodeOperator("operator-0", randomAddress());

      const noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);

      expect(noSummary.isTargetLimitActive).to.be.false;
      expect(noSummary.targetValidatorsCount).to.be.equal(0n);
      expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
      expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
      expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
      expect(noSummary.totalExitedValidators).to.be.equal(0n);
      expect(noSummary.totalDepositedValidators).to.be.equal(0n);
      expect(noSummary.depositableValidatorsCount).to.be.equal(0n);
    });

    it("Returns zeros for a new node operator", async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.be.equal(
        secondNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[thirdNodeOperatorId])).to.be.equal(
        thirdNodeOperatorId,
      );

      const noSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);

      expect(noSummary.isTargetLimitActive).to.be.false;
      expect(noSummary.targetValidatorsCount).to.be.equal(0n);
      expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
      expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
      expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
      expect(noSummary.totalExitedValidators).to.be.equal(0n);
      expect(noSummary.totalDepositedValidators).to.be.equal(7n);
      expect(noSummary.depositableValidatorsCount).to.be.equal(3n);
    });
  });

  context("getNodeOperatorsCount", () => {
    it("Returns zero if no operators added", async () => {
      expect(await nor.getNodeOperatorsCount()).to.be.equal(0n);
    });

    it("Returns all added node operators", async () => {
      for (let i = 0n; i < 10n; ++i) {
        const id = i;
        const name = "no " + i.toString();
        const rewardAddress = certainAddress("reward-address-" + i.toString());

        await expect(nor.connect(nodeOperatorsManager).addNodeOperator(name, rewardAddress))
          .to.emit(nor, "NodeOperatorAdded")
          .withArgs(id, name, rewardAddress, 0n);

        expect(await nor.getNodeOperatorsCount()).to.equal(id + 1n);
      }

      expect(await nor.getNodeOperatorsCount()).to.equal(10n);
    });
  });

  context("getActiveNodeOperatorsCount", () => {
    let beforePopulating: string;

    beforeEach(async () => {
      beforePopulating = await Snapshot.take();

      const promises = [];
      for (let i = 0n; i < 10n; ++i) {
        const name = "no " + i.toString();
        const rewardAddress = certainAddress("reward-address-" + i.toString());

        promises.push(nor.connect(nodeOperatorsManager).addNodeOperator(name, rewardAddress));
      }
      await Promise.all(promises);
    });

    it("Returns zero if no operators added", async () => {
      await Snapshot.restore(beforePopulating);

      expect(await nor.getActiveNodeOperatorsCount()).to.be.equal(0n);
    });

    it("Returns all operators count if no one has been deactivated yet", async () => {
      expect(await nor.getNodeOperatorsCount()).to.be.equal(10n);
      expect(await nor.getActiveNodeOperatorsCount()).to.be.equal(10n);
    });

    it("Returns zero if no active operators", async () => {
      for (let i = 0n; i < 10n; ++i) {
        await nor.connect(nodeOperatorsManager).deactivateNodeOperator(i);
        expect(await nor.getNodeOperatorIsActive(i)).to.be.false;
      }

      expect(await nor.getNodeOperatorsCount()).to.be.equal(10n);
      expect(await nor.getActiveNodeOperatorsCount()).to.be.equal(0n);
    });

    it("Returns active node operators only if some were deactivated", async () => {
      expect(await nor.getNodeOperatorsCount()).to.be.equal(10n);

      await nor.connect(nodeOperatorsManager).deactivateNodeOperator(5n);
      await nor.connect(nodeOperatorsManager).deactivateNodeOperator(3n);

      expect(await nor.getActiveNodeOperatorsCount()).to.be.equal(10n - 2n);
    });
  });

  context("getNodeOperatorIsActive", () => {
    beforeEach(async () => {
      const promises = [];
      for (let i = 0n; i < 10n; ++i) {
        const name = "no " + i.toString();
        const rewardAddress = certainAddress("reward-address-" + i.toString());

        promises.push(nor.connect(nodeOperatorsManager).addNodeOperator(name, rewardAddress));
      }
      await Promise.all(promises);

      for (let i = 0n; i < 10n; ++i) {
        await nor.harness__unsafeSetNodeOperatorIsActive(i, i % 2n != 0n ? true : false);
      }
    });

    it("Returns false if such an operator doesn't exist", async () => {
      expect(await nor.getNodeOperatorsCount()).to.be.equal(10n);
      expect(await nor.getNodeOperatorIsActive(11n)).to.be.false;
    });

    it("Returns false if the operator is inactive", async () => {
      for (let i = 0n; i < 5n; ++i) {
        expect(await nor.getNodeOperatorIsActive(i * 2n)).to.be.false;
      }
    });

    it("Returns true if the operator is active", async () => {
      for (let i = 0n; i < 5n; ++i) {
        expect(await nor.getNodeOperatorIsActive(i * 2n + 1n)).to.be.true;
      }
    });

    it("Allows reading changed activity state", async () => {
      for (let i = 0n; i < 5n; ++i) {
        await nor.connect(nodeOperatorsManager).activateNodeOperator(i * 2n);
      }

      for (let i = 0n; i < 10n; ++i) {
        expect(await nor.getNodeOperatorIsActive(i)).to.be.true;
      }

      for (let i = 0n; i < 10n; ++i) {
        await nor.connect(nodeOperatorsManager).deactivateNodeOperator(i);
      }

      for (let i = 0n; i < 10n; ++i) {
        expect(await nor.getNodeOperatorIsActive(i)).to.be.false;
      }
    });
  });

  context("getNodeOperatorIds", () => {
    let beforePopulating: string;

    beforeEach(async () => {
      beforePopulating = await Snapshot.take();

      const promises = [];
      for (let i = 0n; i < 10n; ++i) {
        const name = "no " + i.toString();
        const rewardAddress = certainAddress("reward-address-" + i.toString());

        promises.push(nor.connect(nodeOperatorsManager).addNodeOperator(name, rewardAddress));
      }
      await Promise.all(promises);
    });

    it("Returns empty list if no operators added", async () => {
      await Snapshot.restore(beforePopulating);

      const ids = await nor.getNodeOperatorIds(0n, 10n);

      expect(ids.length).to.be.equal(0n);
      expect(await nor.getNodeOperatorsCount()).to.be.equal(0n);
    });

    it("Returns empty list if limit is zero", async () => {
      const ids = await nor.getNodeOperatorIds(0n, 0n);

      expect(ids.length).to.be.equal(0n);
      expect(await nor.getNodeOperatorsCount()).to.be.equal(10n);
    });

    it("Returns empty list if offset is past the final element", async () => {
      const ids = await nor.getNodeOperatorIds(10n, 10n);

      expect(ids.length).to.be.equal(0n);
      expect(await nor.getNodeOperatorsCount()).to.be.equal(10n);
    });

    it("Returns up to limit node operator ids", async () => {
      const ids = await nor.getNodeOperatorIds(0n, 5n);

      expect(ids.length).to.be.equal(5n);
      expect(await nor.getNodeOperatorsCount()).to.be.equal(10n);
    });

    it("Returns all ids if limit hadn't been reached", async () => {
      const ids = await nor.getNodeOperatorIds(0n, 10n);

      expect(ids.length).to.be.equal(10n);
      expect(await nor.getNodeOperatorsCount()).to.be.equal(10n);

      for (let i = 0n; i < ids.length; ++i) {
        expect(ids[Number(i)]).to.be.equal(i);
      }
    });
  });

  context("getNonce", () => {
    it("Returns nonce value", async () => {
      expect(await nor.getNonce()).to.be.equal(0n);
    });

    it("Allows reading the changed nonce value", async () => {
      await nor.harness__setNonce(123n);
      expect(await nor.getNonce()).to.be.equal(123n);
    });

    it("Allows zero nonce", async () => {
      await nor.harness__setNonce(0n);
      expect(await nor.getNonce()).to.be.equal(0n);
    });
  });

  context("getKeysOpIndex", () => {
    it("Returns keys op value", async () => {
      expect(await nor.getKeysOpIndex()).to.be.equal(0n);
    });

    it("Allows reading the changed keys op value", async () => {
      await nor.harness__setNonce(123n);
      expect(await nor.getKeysOpIndex()).to.be.equal(123n);
    });

    it("Allows zero keys op", async () => {
      await nor.harness__setNonce(0n);
      expect(await nor.getKeysOpIndex()).to.be.equal(0n);
    });

    it("Returns the same value as getNonce", async () => {
      for (let i = 0n; i < 100n; ++i) {
        await nor.harness__setNonce(i);

        expect(await nor.getNonce()).to.be.equal(i);
        expect(await nor.getKeysOpIndex()).to.be.equal(i);
      }
    });
  });

  context("getLocator", () => {
    it("Returns LidoLocator address", async () => {
      expect(await nor.getLocator()).to.be.equal(locator);
    });

    it("Allows reading the changed LidoLocator address", async () => {
      await nor.harness__setLocator(certainAddress("mocked-locator"));
      expect(await nor.getLocator()).to.be.equal(certainAddress("mocked-locator"));
    });

    it("Allows reading zero LidoLocator address", async () => {
      await nor.harness__setLocator(ZeroAddress);
      expect(await nor.getLocator()).to.be.equal(ZeroAddress);
    });
  });

  context("getStuckPenaltyDelay", () => {
    it("Returns stuck penalty delay", async () => {
      expect(await nor.getStuckPenaltyDelay()).to.be.equal(penaltyDelay);
    });

    it("Allows reading the changed stuck penalty delay", async () => {
      const maxStuckPenaltyDelay = await nor.MAX_STUCK_PENALTY_DELAY();

      await nor.harness__setStuckPenaltyDelay(maxStuckPenaltyDelay);
      expect(await nor.getStuckPenaltyDelay()).to.be.equal(maxStuckPenaltyDelay);
    });

    it("Allows reading zero stuck penalty delay", async () => {
      await nor.harness__setStuckPenaltyDelay(0n);
      expect(await nor.getStuckPenaltyDelay()).to.be.equal(0n);
    });
  });

  context("setStuckPenaltyDelay", () => {
    it("Reverts if has no MANAGE_NODE_OPERATOR_ROLE assigned", async () => {
      await expect(nor.setStuckPenaltyDelay(86400n)).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Reverts if invalid range value provided", async () => {
      const maxStuckPenaltyDelay = await nor.MAX_STUCK_PENALTY_DELAY();

      await expect(
        nor.connect(nodeOperatorsManager).setStuckPenaltyDelay(maxStuckPenaltyDelay + 1n),
      ).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Sets a new value for the stuck penalty delay", async () => {
      await expect(nor.connect(nodeOperatorsManager).setStuckPenaltyDelay(7200n))
        .to.emit(nor, "StuckPenaltyDelayChanged")
        .withArgs(7200n);

      const stuckPenaltyDelay = await nor.getStuckPenaltyDelay();
      expect(stuckPenaltyDelay).to.be.equal(7200n);
    });

    it("Allows setting a zero delay", async () => {
      await expect(nor.connect(nodeOperatorsManager).setStuckPenaltyDelay(0n))
        .to.emit(nor, "StuckPenaltyDelayChanged")
        .withArgs(0n);

      const stuckPenaltyDelay = await nor.getStuckPenaltyDelay();
      expect(stuckPenaltyDelay).to.be.equal(0n);
    });
  });
});
