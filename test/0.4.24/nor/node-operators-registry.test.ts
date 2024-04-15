import assert from "node:assert";

import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ACL,
  Kernel,
  Lido,
  LidoLocator,
  LidoLocator__factory,
  MinFirstAllocationStrategy__factory,
  NodeOperatorsRegistryMock,
  NodeOperatorsRegistryMock__factory,
} from "typechain-types";
import { NodeOperatorsRegistryLibraryAddresses } from "typechain-types/factories/contracts/0.4.24/nos/NodeOperatorsRegistry.sol/NodeOperatorsRegistry__factory";

import { addAragonApp, deployLidoDao, hasPermission } from "lib";

const CURATED_TYPE = "0x637572617465642d6f6e636861696e2d76310000000000000000000000000000"; // "curated-onchain-v1"
const PENALTY_DELAY = 2 * 24 * 60 * 60; // 2 days
const ADDRESS_1 = "0x0000000000000000000000000000000000000001";
const ADDRESS_2 = "0x0000000000000000000000000000000000000002";
const ADDRESS_3 = "0x0000000000000000000000000000000000000003";
const ADDRESS_4 = "0x0000000000000000000000000000000000000005";

const NODE_OPERATORS: NodeOperatorConfig[] = [
  {
    name: "foo",
    rewardAddress: ADDRESS_1,
    totalSigningKeysCount: 10,
    depositedSigningKeysCount: 5,
    exitedSigningKeysCount: 1,
    vettedSigningKeysCount: 6,
    stuckValidatorsCount: 0,
    refundedValidatorsCount: 0,
    stuckPenaltyEndAt: 0,
  },
  {
    name: " bar",
    rewardAddress: ADDRESS_2,
    totalSigningKeysCount: 15,
    depositedSigningKeysCount: 7,
    exitedSigningKeysCount: 0,
    vettedSigningKeysCount: 10,
    stuckValidatorsCount: 0,
    refundedValidatorsCount: 0,
    stuckPenaltyEndAt: 0,
  },
  {
    name: "deactivated",
    isActive: false,
    rewardAddress: ADDRESS_3,
    totalSigningKeysCount: 10,
    depositedSigningKeysCount: 0,
    exitedSigningKeysCount: 0,
    vettedSigningKeysCount: 5,
    stuckValidatorsCount: 0,
    refundedValidatorsCount: 0,
    stuckPenaltyEndAt: 0,
  },
];

describe("NodeOperatorsRegistry", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let limitsManager: HardhatEthersSigner;
  let nodeOperatorsManager: HardhatEthersSigner;
  let signingKeysManager: HardhatEthersSigner;
  let stakingRouter: HardhatEthersSigner;
  let lido: Lido;
  let dao: Kernel;
  let acl: ACL;
  let locator: LidoLocator;

  let impl: NodeOperatorsRegistryMock;
  let nor: NodeOperatorsRegistryMock;

  beforeEach(async () => {
    [deployer, user, stranger, stakingRouter, nodeOperatorsManager, signingKeysManager, limitsManager] =
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

    impl = await new NodeOperatorsRegistryMock__factory(allocLibAddr, deployer).deploy();
    const appProxy = await addAragonApp({
      dao,
      name: "node-operators-registry",
      impl,
      rootAccount: deployer,
    });

    nor = NodeOperatorsRegistryMock__factory.connect(appProxy, deployer);

    await acl.createPermission(stakingRouter, nor, await nor.STAKING_ROUTER_ROLE(), deployer);
    await acl.createPermission(signingKeysManager, nor, await nor.MANAGE_SIGNING_KEYS(), deployer);
    await acl.createPermission(nodeOperatorsManager, nor, await nor.MANAGE_NODE_OPERATOR_ROLE(), deployer);
    await acl.createPermission(limitsManager, nor, await nor.SET_NODE_OPERATOR_LIMIT_ROLE(), deployer);

    // grant role to nor itself cause it uses solidity's call method to itself
    // inside the testing_requestValidatorsKeysForDeposits() method
    await acl.grantPermission(nor, nor, await nor.STAKING_ROUTER_ROLE());

    locator = LidoLocator__factory.connect(await lido.getLidoLocator(), user);

    // Initialize the nor's proxy.
    await expect(nor.initialize(locator, CURATED_TYPE, PENALTY_DELAY))
      .to.emit(nor, "ContractVersionSet")
      .withArgs(2)
      .and.to.emit(nor, "LocatorContractSet")
      .withArgs(locator)
      .and.to.emit(nor, "StakingModuleTypeSet")
      .withArgs(CURATED_TYPE);

    nor = nor.connect(user);
  });

  context("initialize", () => {
    it("sets module type correctly", async () => {
      expect(await nor.getType()).to.be.equal(CURATED_TYPE);
    });

    it("sets locator correctly", async () => {
      expect(await nor.getLocator()).to.be.equal(locator);
    });

    it("sets contract version correctly", async () => {
      expect(await nor.getContractVersion()).to.be.equal(2);
    });

    it("sets hasInitialized() to true", async () => {
      expect(await nor.hasInitialized()).to.be.true;
    });

    it("can't be initialized second time", async () => {
      await expect(nor.initialize(locator, CURATED_TYPE, PENALTY_DELAY)).to.be.revertedWith("INIT_ALREADY_INITIALIZED");
    });

    it('reverts with error "ZERO_ADDRESS" when locator is zero address', async () => {
      const appProxy = await addAragonApp({
        dao,
        name: "new-node-operators-registry",
        impl,
        rootAccount: deployer,
      });
      const registry = NodeOperatorsRegistryMock__factory.connect(appProxy, deployer);
      await expect(registry.initialize(ZeroAddress, CURATED_TYPE, PENALTY_DELAY)).to.be.revertedWith("ZERO_ADDRESS");
    });

    it('call on implementation reverts with error "INIT_ALREADY_INITIALIZED"', async () => {
      // Implementation initializer reverts because initialization block was set to max(uint256)
      // in the Autopetrified base contract
      await expect(impl.initialize(locator, CURATED_TYPE, PENALTY_DELAY)).to.be.revertedWith(
        "INIT_ALREADY_INITIALIZED",
      );
    });
  });

  context("finalizeUpgrade_v2()", () => {
    beforeEach(async () => {
      // reset version there to test upgrade finalization
      await nor.testing_setBaseVersion(0);
    });

    it("fails with CONTRACT_NOT_INITIALIZED error when called on implementation", async () => {
      await expect(impl.finalizeUpgrade_v2(locator, CURATED_TYPE, PENALTY_DELAY)).to.be.revertedWith(
        "CONTRACT_NOT_INITIALIZED",
      );
    });

    it("fails with CONTRACT_NOT_INITIALIZED error when nor instance not initialized yet", async () => {
      const appProxy = await addAragonApp({
        dao,
        name: "new-node-operators-registry",
        impl,
        rootAccount: deployer,
      });
      const registry = NodeOperatorsRegistryMock__factory.connect(appProxy, deployer);
      await expect(registry.finalizeUpgrade_v2(locator, CURATED_TYPE, PENALTY_DELAY)).to.be.revertedWith(
        "CONTRACT_NOT_INITIALIZED",
      );
    });

    it("sets correct contract version", async () => {
      await nor.finalizeUpgrade_v2(locator, CURATED_TYPE, PENALTY_DELAY);
      expect(await nor.getContractVersion()).to.be.equal(2);
    });

    it("reverts with error UNEXPECTED_CONTRACT_VERSION when called on already initialized contract", async () => {
      await nor.finalizeUpgrade_v2(locator, CURATED_TYPE, PENALTY_DELAY);
      expect(await nor.getContractVersion()).to.be.equal(2);
      await expect(nor.finalizeUpgrade_v2(locator, CURATED_TYPE, PENALTY_DELAY)).to.be.revertedWith(
        "UNEXPECTED_CONTRACT_VERSION",
      );
    });
  });

  context("setNodeOperatorName()", async () => {
    const firstNodeOperatorId = 0;
    const secondNodeOperatorId = 1;

    beforeEach(async () => {
      expect(await addNodeOperator(nor, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(firstNodeOperatorId);
      expect(await addNodeOperator(nor, NODE_OPERATORS[secondNodeOperatorId])).to.be.equal(secondNodeOperatorId);
    });

    it('reverts with "OUT_OF_RANGE" error when called on non existent node operator', async () => {
      const notExitedNodeOperatorId = await nor.getNodeOperatorsCount();
      await expect(
        nor.connect(nodeOperatorsManager).setNodeOperatorName(notExitedNodeOperatorId, "new name"),
      ).to.be.revertedWith("OUT_OF_RANGE");
    });

    it('reverts with "WRONG_NAME_LENGTH" error when called with empty name', async () => {
      await expect(nor.connect(nodeOperatorsManager).setNodeOperatorName(firstNodeOperatorId, "")).to.be.revertedWith(
        "WRONG_NAME_LENGTH",
      );
    });

    it('reverts with "WRONG_NAME_LENGTH" error when name exceeds MAX_NODE_OPERATOR_NAME_LENGTH', async () => {
      const maxNameLength = await nor.MAX_NODE_OPERATOR_NAME_LENGTH();
      const tooLongName = "#".repeat(Number(maxNameLength) + 1);
      assert(tooLongName.length > maxNameLength);
      await expect(
        nor.connect(nodeOperatorsManager).setNodeOperatorName(firstNodeOperatorId, tooLongName),
      ).to.be.revertedWith("WRONG_NAME_LENGTH");
    });

    it('reverts with "APP_AUTH_FAILED" error when called by address without MANAGE_NODE_OPERATOR_ROLE', async () => {
      expect(await hasPermission(dao, nor, "MANAGE_NODE_OPERATOR_ROLE", stranger)).to.be.false;
      await expect(nor.connect(stranger).setNodeOperatorName(firstNodeOperatorId, "new name")).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );
    });

    it('reverts with "VALUE_IS_THE_SAME" error when called with the same name', async () => {
      const { name: currentName } = await nor.getNodeOperator(firstNodeOperatorId, true);
      await expect(
        nor.connect(nodeOperatorsManager).setNodeOperatorName(firstNodeOperatorId, currentName),
      ).to.be.revertedWith("VALUE_IS_THE_SAME");
    });

    it("updates the node operator name", async () => {
      const newName = "new name";
      await nor.connect(nodeOperatorsManager).setNodeOperatorName(firstNodeOperatorId, newName);
      const { name: nameAfter } = await nor.getNodeOperator(firstNodeOperatorId, true);
      expect(nameAfter).to.be.equal(newName);
    });

    it("emits NodeOperatorNameSet event with correct params", async () => {
      const newName = "new name";
      await expect(nor.connect(nodeOperatorsManager).setNodeOperatorName(firstNodeOperatorId, newName))
        .to.emit(nor, "NodeOperatorNameSet")
        .withArgs(firstNodeOperatorId, newName);
    });

    it("doesn't affect the names of other node operators", async () => {
      const newName = "new name";
      const { name: anotherNodeOperatorNameBefore } = await nor.getNodeOperator(secondNodeOperatorId, true);
      await nor.connect(nodeOperatorsManager).setNodeOperatorName(firstNodeOperatorId, newName);
      const { name: anotherNodeOperatorNameAfter } = await nor.getNodeOperator(secondNodeOperatorId, true);
      expect(anotherNodeOperatorNameBefore).to.be.equal(anotherNodeOperatorNameAfter);
    });
  });

  context("setNodeOperatorRewardAddress()", async () => {
    const firstNodeOperatorId = 0;
    const secondNodeOperatorId = 1;
    const notExistedNodeOperatorId = 2;

    beforeEach(async () => {
      expect(await addNodeOperator(nor, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(firstNodeOperatorId);
      expect(await addNodeOperator(nor, NODE_OPERATORS[secondNodeOperatorId])).to.be.equal(secondNodeOperatorId);
    });

    it('reverts with "OUT_OF_RANGE" error when called on non existent node operator', async () => {
      await expect(
        nor.connect(nodeOperatorsManager).setNodeOperatorRewardAddress(notExistedNodeOperatorId, ADDRESS_4),
      ).to.be.revertedWith("OUT_OF_RANGE");
    });

    it('reverts with "ZERO_ADDRESS" error when new address is zero', async () => {
      await expect(
        nor.connect(nodeOperatorsManager).setNodeOperatorRewardAddress(firstNodeOperatorId, ZeroAddress),
      ).to.be.revertedWith("ZERO_ADDRESS");
    });

    it('reverts with error "LIDO_REWARD_ADDRESS" when new reward address is lido', async () => {
      await expect(
        nor.connect(nodeOperatorsManager).setNodeOperatorRewardAddress(firstNodeOperatorId, lido),
      ).to.be.revertedWith("LIDO_REWARD_ADDRESS");
    });

    it(`reverts with "APP_AUTH_FAILED" error when caller doesn't have MANAGE_NODE_OPERATOR_ROLE`, async () => {
      expect(await hasPermission(dao, nor, "MANAGE_NODE_OPERATOR_ROLE", stranger)).to.be.false;
      await expect(
        nor.connect(stranger).setNodeOperatorRewardAddress(firstNodeOperatorId, ADDRESS_4),
      ).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it(`reverts with "VALUE_IS_THE_SAME" error when new reward address is the same`, async () => {
      const nodeOperator = await nor.getNodeOperator(firstNodeOperatorId, false);
      await expect(
        nor.connect(nodeOperatorsManager).setNodeOperatorRewardAddress(firstNodeOperatorId, nodeOperator.rewardAddress),
      ).to.be.revertedWith("VALUE_IS_THE_SAME");
    });

    it("updates the reward address of the node operator", async () => {
      const { rewardAddress: rewardAddressBefore } = await nor.getNodeOperator(firstNodeOperatorId, false);
      expect(rewardAddressBefore).to.be.not.equal(ADDRESS_4);
      await nor.connect(nodeOperatorsManager).setNodeOperatorRewardAddress(firstNodeOperatorId, ADDRESS_4);
      const { rewardAddress: rewardAddressAfter } = await nor.getNodeOperator(firstNodeOperatorId, false);
      expect(rewardAddressAfter).to.be.equal(ADDRESS_4);
    });

    it('emits "NodeOperatorRewardAddressSet" event with correct params', async () => {
      await expect(nor.connect(nodeOperatorsManager).setNodeOperatorRewardAddress(firstNodeOperatorId, ADDRESS_4))
        .to.emit(nor, "NodeOperatorRewardAddressSet")
        .withArgs(firstNodeOperatorId, ADDRESS_4);
    });

    it("doesn't affect other node operators reward addresses", async () => {
      const { rewardAddress: rewardAddressBefore } = await nor.getNodeOperator(secondNodeOperatorId, false);
      await nor.connect(nodeOperatorsManager).setNodeOperatorRewardAddress(firstNodeOperatorId, ADDRESS_4);
      const { rewardAddress: rewardAddressAfter } = await nor.getNodeOperator(secondNodeOperatorId, false);
      expect(rewardAddressAfter).to.be.equal(rewardAddressBefore);
    });
  });

  context("updateTargetValidatorsLimits", () => {
    const firstNodeOperatorId = 0;
    const secondNodeOperatorId = 1;
    let targetLimitMode = 0;
    let targetLimit = 0;

    beforeEach(async () => {
      expect(await addNodeOperator(nor, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(firstNodeOperatorId);
      expect(await addNodeOperator(nor, NODE_OPERATORS[secondNodeOperatorId])).to.be.equal(secondNodeOperatorId);
    });

    it('reverts with "APP_AUTH_FAILED" error when called by sender without STAKING_ROUTER_ROLE', async () => {
      expect(await hasPermission(dao, nor, "STAKING_ROUTER_ROLE", stranger)).to.be.false;
      await expect(
        nor.updateTargetValidatorsLimits(firstNodeOperatorId, targetLimitMode, targetLimit),
      ).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it('reverts with "OUT_OF_RANGE" error when called with targetLimit > UINT64_MAX', async () => {
      const targetLimitWrong = BigInt("0x10000000000000000");

      await expect(
        nor.connect(stakingRouter).updateTargetValidatorsLimits(firstNodeOperatorId, targetLimitMode, targetLimitWrong),
      ).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("updates node operator target limit if called by sender with STAKING_ROUTER_ROLE", async () => {
      expect(await hasPermission(dao, nor, "STAKING_ROUTER_ROLE", stakingRouter)).to.be.true;

      targetLimitMode = 1;
      targetLimit = 10;

      await expect(
        nor.connect(stakingRouter).updateTargetValidatorsLimits(firstNodeOperatorId, targetLimitMode, targetLimit),
      )
        .to.emit(nor, "TargetValidatorsCountChanged")
        .withArgs(firstNodeOperatorId, targetLimit, targetLimitMode);

      const keysStatTotal = await nor.getStakingModuleSummary();
      const expectedExitedValidatorsCount =
        NODE_OPERATORS[firstNodeOperatorId].exitedSigningKeysCount +
        NODE_OPERATORS[secondNodeOperatorId].exitedSigningKeysCount;
      expect(keysStatTotal.totalExitedValidators).to.equal(expectedExitedValidatorsCount);

      const expectedDepositedValidatorsCount =
        NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount +
        NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount;
      expect(keysStatTotal.totalDepositedValidators).to.equal(expectedDepositedValidatorsCount);

      const firstNodeOperatorDepositableValidators =
        NODE_OPERATORS[firstNodeOperatorId].vettedSigningKeysCount -
        NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount;

      const secondNodeOperatorDepositableValidators =
        NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount -
        NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount;

      const expectedDepositableValidatorsCount =
        Math.min(targetLimit, firstNodeOperatorDepositableValidators) + secondNodeOperatorDepositableValidators;
      expect(keysStatTotal.depositableValidatorsCount).to.equal(expectedDepositableValidatorsCount);
    });

    it("updates node operator target limit mode correctly", async () => {
      expect(await hasPermission(dao, nor, "STAKING_ROUTER_ROLE", stakingRouter)).to.be.true;

      const targetLimitMode1 = 1;
      const targetLimitMode2 = 1;
      targetLimit = 10;

      await expect(
        nor.connect(stakingRouter).updateTargetValidatorsLimits(firstNodeOperatorId, targetLimitMode1, targetLimit),
      )
        .to.emit(nor, "TargetValidatorsCountChanged")
        .withArgs(firstNodeOperatorId, targetLimit, targetLimitMode1);

      let noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      expect(noSummary.targetLimitMode).to.equal(targetLimitMode1);

      await expect(
        nor.connect(stakingRouter).updateTargetValidatorsLimits(secondNodeOperatorId, targetLimitMode2, targetLimit),
      )
        .to.emit(nor, "TargetValidatorsCountChanged")
        .withArgs(secondNodeOperatorId, targetLimit, targetLimitMode2);
      noSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      expect(noSummary.targetLimitMode).to.equal(targetLimitMode2);

      // reset limit
      await expect(nor.connect(stakingRouter).updateTargetValidatorsLimits(firstNodeOperatorId, 0, targetLimit))
        .to.emit(nor, "TargetValidatorsCountChanged")
        .withArgs(firstNodeOperatorId, 0, 0); // expect limit set to 0

      noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      expect(noSummary.targetLimitMode).to.equal(0);

      // mode for 2nt NO is not changed
      noSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      expect(noSummary.targetLimitMode).to.equal(targetLimitMode2);
    });
  });
});

interface NodeOperatorConfig {
  name: string;
  rewardAddress: string;
  totalSigningKeysCount: number;
  depositedSigningKeysCount: number;
  exitedSigningKeysCount: number;
  vettedSigningKeysCount: number;
  stuckValidatorsCount: number;
  refundedValidatorsCount: number;
  stuckPenaltyEndAt: number;
  isActive?: boolean;
}

/***
 * Adds new Node Operator to the registry and configures it
 * @param {object} norMock Node operators registry mocked instance
 * @param {object} config Configuration of the added node operator
 * @param {string} config.name Name of the new node operator
 * @param {string} config.rewardAddress Reward address of the new node operator
 * @param {number} config.totalSigningKeysCount Count of the validators in the new node operator
 * @param {number} config.depositedSigningKeysCount Count of used signing keys in the new node operator
 * @param {number} config.exitedSigningKeysCount Count of stopped signing keys in the new node operator
 * @param {number} config.vettedSigningKeysCount Staking limit of the new node operator
 * @param {number} config.stuckValidatorsCount Stuck keys count of the new node operator
 * @param {number} config.refundedValidatorsKeysCount Repaid keys count of the new node operator
 * @param {number} config.isActive The active state of new node operator
 * @returns {bigint} newOperatorId Id of newly added Node Operator
 */
async function addNodeOperator(norMock: NodeOperatorsRegistryMock, config: NodeOperatorConfig): Promise<bigint> {
  const isActive = config.isActive === undefined ? true : config.isActive;

  if (config.vettedSigningKeysCount < config.depositedSigningKeysCount) {
    throw new Error("Invalid keys config: vettedSigningKeysCount < depositedSigningKeysCount");
  }

  if (config.vettedSigningKeysCount > config.totalSigningKeysCount) {
    throw new Error("Invalid keys config: vettedSigningKeysCount > totalSigningKeysCount");
  }

  if (config.exitedSigningKeysCount > config.depositedSigningKeysCount) {
    throw new Error("Invalid keys config: depositedSigningKeysCount < exitedSigningKeysCount");
  }

  if (config.stuckValidatorsCount > config.depositedSigningKeysCount - config.exitedSigningKeysCount) {
    throw new Error("Invalid keys config: stuckValidatorsCount > depositedSigningKeysCount - exitedSigningKeysCount");
  }

  if (config.totalSigningKeysCount < config.exitedSigningKeysCount + config.depositedSigningKeysCount) {
    throw new Error("Invalid keys config: totalSigningKeys < stoppedValidators + usedSigningKeys");
  }

  const newOperatorId = await norMock.getNodeOperatorsCount();
  await norMock.testing_addNodeOperator(
    config.name,
    config.rewardAddress,
    config.totalSigningKeysCount,
    config.vettedSigningKeysCount,
    config.depositedSigningKeysCount,
    config.exitedSigningKeysCount,
  );
  await norMock.testing_setNodeOperatorLimits(
    newOperatorId,
    config.stuckValidatorsCount,
    config.refundedValidatorsCount,
    config.stuckPenaltyEndAt,
  );

  if (!isActive) {
    await norMock.testing_unsafeDeactivateNodeOperator(newOperatorId);
  }

  const nodeOperatorsSummary = await norMock.getNodeOperatorSummary(newOperatorId);
  const nodeOperator = await norMock.getNodeOperator(newOperatorId, true);

  if (isActive) {
    expect(nodeOperator.totalVettedValidators).to.equal(config.vettedSigningKeysCount);
    expect(nodeOperator.totalAddedValidators).to.equal(config.totalSigningKeysCount);
    expect(nodeOperatorsSummary.totalExitedValidators).to.equal(config.exitedSigningKeysCount);
    expect(nodeOperatorsSummary.totalDepositedValidators).to.equal(config.depositedSigningKeysCount);
    expect(nodeOperatorsSummary.depositableValidatorsCount).to.equal(
      config.vettedSigningKeysCount - config.depositedSigningKeysCount,
    );
  } else {
    expect(nodeOperatorsSummary.totalExitedValidators).to.equal(config.exitedSigningKeysCount);
    expect(nodeOperatorsSummary.totalDepositedValidators).to.equal(config.depositedSigningKeysCount);
    expect(nodeOperatorsSummary.depositableValidatorsCount).to.equal(0);
  }
  return newOperatorId;
}
