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

import { addNodeOperator, certainAddress, NodeOperatorConfig, prepIdsCountsPayload } from "lib";

import { addAragonApp, deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

describe("NodeOperatorsRegistry.sol:stakingLimit", () => {
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
      name: "bar",
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

  context("decreaseVettedSigningKeysCount", () => {
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
      const idsPayload = prepIdsCountsPayload([5n], [10n]);

      await expect(
        nor.connect(stakingRouter).decreaseVettedSigningKeysCount(idsPayload.operatorIds, idsPayload.keysCounts),
      ).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if no STAKING_ROUTER_ROLE assigned", async () => {
      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [0n]);

      await expect(
        nor.decreaseVettedSigningKeysCount(idsPayload.operatorIds, idsPayload.keysCounts),
      ).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Does nothing if vetted keys count stays the same", async () => {
      const vetted = (await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators;

      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [vetted]);
      await expect(
        nor.connect(stakingRouter).decreaseVettedSigningKeysCount(idsPayload.operatorIds, idsPayload.keysCounts),
      ).to.not.emit(nor, "VettedSigningKeysCountChanged");
    });

    it("Able to set decrease vetted keys count", async () => {
      const oldVetted = 6n;
      const newVetted = 5n;
      expect(newVetted < oldVetted);

      expect((await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators).to.be.equal(oldVetted);
      const oldNonce = await nor.getNonce();

      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [newVetted]);
      await expect(
        nor.connect(stakingRouter).decreaseVettedSigningKeysCount(idsPayload.operatorIds, idsPayload.keysCounts),
      )
        .to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, newVetted)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(oldNonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(oldNonce + 1n);

      expect((await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators).to.be.equal(newVetted);
    });

    it("Not able to increase vetted keys count", async () => {
      const oldVetted = 6n;
      const newVetted = 8n;
      expect(newVetted > oldVetted);

      expect((await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators).to.be.equal(oldVetted);

      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [newVetted]);
      await expect(
        nor.connect(stakingRouter).decreaseVettedSigningKeysCount(idsPayload.operatorIds, idsPayload.keysCounts),
      ).to.be.revertedWith("VETTED_KEYS_COUNT_INCREASED");
    });

    it("Vetted keys count can only be ≥ deposited", async () => {
      const oldVetted = 6n;
      const vettedBelowDeposited = 3n;

      expect(vettedBelowDeposited < oldVetted);
      const firstNo = await nor.getNodeOperator(firstNodeOperatorId, false);
      expect(vettedBelowDeposited < firstNo.totalDepositedValidators);

      expect((await nor.getNodeOperator(firstNodeOperatorId, false)).totalVettedValidators).to.be.equal(oldVetted);
      const oldNonce = await nor.getNonce();

      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [firstNo.totalDepositedValidators]);
      await expect(
        nor.connect(stakingRouter).decreaseVettedSigningKeysCount(idsPayload.operatorIds, idsPayload.keysCounts),
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

    it("depositableValidatorsCount in getStakingModuleSummary is decreasing", async () => {
      let summary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      const oldNonce = await nor.getNonce();
      const oldDepositableValidatorsCount = summary.depositableValidatorsCount;
      const firstNo = await nor.getNodeOperator(firstNodeOperatorId, false);
      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [firstNo.totalDepositedValidators]);

      await expect(
        nor.connect(stakingRouter).decreaseVettedSigningKeysCount(idsPayload.operatorIds, idsPayload.keysCounts),
      )
        .to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, firstNo.totalDepositedValidators)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(oldNonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(oldNonce + 1n);

      summary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      const newDepositableValidatorsCount = summary.depositableValidatorsCount;

      expect(newDepositableValidatorsCount).to.be.lessThan(oldDepositableValidatorsCount);
    });
  });
});
