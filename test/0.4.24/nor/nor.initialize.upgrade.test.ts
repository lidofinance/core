import { expect } from "chai";
import { encodeBytes32String, MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { ACL, Kernel, Lido, LidoLocator, NodeOperatorsRegistry__Harness } from "typechain-types";

import { addNodeOperator, certainAddress, NodeOperatorConfig } from "lib";

import { addAragonApp, deployLidoDao, deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("NodeOperatorsRegistry.sol:initialize-and-upgrade", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let limitsManager: HardhatEthersSigner;
  let nodeOperatorsManager: HardhatEthersSigner;
  let signingKeysManager: HardhatEthersSigner;
  let stakingRouter: HardhatEthersSigner;

  let nor: NodeOperatorsRegistry__Harness;
  let lido: Lido;
  let dao: Kernel;
  let acl: ACL;
  let locator: LidoLocator;

  let originalState: string;

  const firstNodeOperatorId = 0;
  const secondNodeOperatorId = 1;
  const thirdNodeOperatorId = 2;
  const fourthNodeOperatorId = 3;

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
    {
      name: "extra-no",
      rewardAddress: certainAddress("node-operator-4"),
      totalSigningKeysCount: 3n,
      depositedSigningKeysCount: 2n,
      exitedSigningKeysCount: 1n,
      vettedSigningKeysCount: 2n,
      stuckValidatorsCount: 1n,
      refundedValidatorsCount: 0n,
      stuckPenaltyEndAt: 0n,
    },
  ];

  const moduleType = encodeBytes32String("curated-onchain-v1");
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

    const impl = await ethers.deployContract("NodeOperatorsRegistry__Harness", deployer);
    expect(await impl.getInitializationBlock()).to.equal(MaxUint256);
    const appProxy = await addAragonApp({
      dao,
      name: "node-operators-registry",
      impl,
      rootAccount: deployer,
    });

    nor = await ethers.getContractAt("NodeOperatorsRegistry__Harness", appProxy, deployer);

    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);

    await acl.createPermission(stakingRouter, nor, await nor.STAKING_ROUTER_ROLE(), deployer);
    await acl.createPermission(signingKeysManager, nor, await nor.MANAGE_SIGNING_KEYS(), deployer);
    await acl.createPermission(nodeOperatorsManager, nor, await nor.MANAGE_NODE_OPERATOR_ROLE(), deployer);
    await acl.createPermission(limitsManager, nor, await nor.SET_NODE_OPERATOR_LIMIT_ROLE(), deployer);

    // grant role to nor itself cause it uses solidity's call method to itself
    // inside the harness__requestValidatorsKeysForDeposits() method
    await acl.grantPermission(nor, nor, await nor.STAKING_ROUTER_ROLE());

    locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), user);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initialize", () => {
    beforeEach(async () => {
      locator = await deployLidoLocator({ lido: lido });
    });

    it("Reverts if Locator is zero address", async () => {
      await expect(nor.initialize(ZeroAddress, moduleType, 43200n)).to.be.reverted;
    });

    it("Reverts if stuck penalty delay exceeds MAX_STUCK_PENALTY_DELAY", async () => {
      const MAX_STUCK_PENALTY_DELAY = await nor.MAX_STUCK_PENALTY_DELAY();
      await expect(nor.initialize(locator, "curated-onchain-v1", MAX_STUCK_PENALTY_DELAY + 1n));
    });

    it("Reverts if was initialized with v1", async () => {
      const MAX_STUCK_PENALTY_DELAY = await nor.MAX_STUCK_PENALTY_DELAY();
      await nor.harness__initialize(1n);

      await expect(nor.initialize(locator, moduleType, MAX_STUCK_PENALTY_DELAY)).to.be.revertedWith(
        "INIT_ALREADY_INITIALIZED",
      );
    });

    it("Reverts if already initialized with v2", async () => {
      const MAX_STUCK_PENALTY_DELAY = await nor.MAX_STUCK_PENALTY_DELAY();
      await nor.initialize(locator, encodeBytes32String("curated-onchain-v1"), MAX_STUCK_PENALTY_DELAY);

      await expect(nor.initialize(locator, moduleType, MAX_STUCK_PENALTY_DELAY)).to.be.revertedWith(
        "INIT_ALREADY_INITIALIZED",
      );
    });

    it("Reverts if has been upgraded to v2 before", async () => {
      const MAX_STUCK_PENALTY_DELAY = await nor.MAX_STUCK_PENALTY_DELAY();

      await nor.harness__initialize(0n);
      await nor.finalizeUpgrade_v2(locator, encodeBytes32String("curated-onchain-v1"), MAX_STUCK_PENALTY_DELAY);

      await expect(nor.initialize(locator, moduleType, MAX_STUCK_PENALTY_DELAY)).to.be.revertedWith(
        "INIT_ALREADY_INITIALIZED",
      );
    });

    it("Makes the contract initialized to v2", async () => {
      const burnerAddress = await locator.burner();
      const latestBlock = BigInt(await time.latestBlock());

      await expect(nor.initialize(locator, moduleType, 86400n))
        .to.emit(nor, "ContractVersionSet")
        .withArgs(contractVersion)
        .and.to.emit(nor, "StuckPenaltyDelayChanged")
        .withArgs(86400n)
        .and.to.emit(nor, "LocatorContractSet")
        .withArgs(await locator.getAddress())
        .and.to.emit(nor, "StakingModuleTypeSet")
        .withArgs(moduleType);

      expect(await nor.getLocator()).to.equal(await locator.getAddress());
      expect(await nor.getInitializationBlock()).to.equal(latestBlock + 1n);
      expect(await lido.allowance(await nor.getAddress(), burnerAddress)).to.equal(MaxUint256);
      expect(await nor.getStuckPenaltyDelay()).to.equal(86400n);
      expect(await nor.getContractVersion()).to.equal(contractVersion);
      expect(await nor.getType()).to.equal(moduleType);
    });
  });

  context("finalizeUpgrade_v2", () => {
    let burnerAddress: string;
    let preInitState: string;

    beforeEach(async () => {
      locator = await deployLidoLocator({ lido: lido });
      burnerAddress = await locator.burner();

      preInitState = await Snapshot.take();
      await nor.harness__initialize(0n);
    });

    it("Reverts if Locator is zero address", async () => {
      await expect(nor.finalizeUpgrade_v2(ZeroAddress, moduleType, 43200n)).to.be.reverted;
    });

    it("Reverts if stuck penalty delay exceeds MAX_STUCK_PENALTY_DELAY", async () => {
      const MAX_STUCK_PENALTY_DELAY = await nor.MAX_STUCK_PENALTY_DELAY();
      await expect(nor.finalizeUpgrade_v2(locator, "curated-onchain-v1", MAX_STUCK_PENALTY_DELAY + 1n));
    });

    it("Reverts if hasn't been initialized yet", async () => {
      await Snapshot.restore(preInitState);

      const MAX_STUCK_PENALTY_DELAY = await nor.MAX_STUCK_PENALTY_DELAY();
      await expect(nor.finalizeUpgrade_v2(locator, moduleType, MAX_STUCK_PENALTY_DELAY)).to.be.revertedWith(
        "CONTRACT_NOT_INITIALIZED",
      );
    });

    it("Reverts if already initialized to v2", async () => {
      await Snapshot.restore(preInitState);
      const MAX_STUCK_PENALTY_DELAY = await nor.MAX_STUCK_PENALTY_DELAY();
      await nor.initialize(locator, encodeBytes32String("curated-onchain-v1"), MAX_STUCK_PENALTY_DELAY);

      await expect(nor.finalizeUpgrade_v2(locator, moduleType, MAX_STUCK_PENALTY_DELAY)).to.be.revertedWith(
        "UNEXPECTED_CONTRACT_VERSION",
      );
    });

    it("Reverts if already upgraded to v2", async () => {
      const MAX_STUCK_PENALTY_DELAY = await nor.MAX_STUCK_PENALTY_DELAY();
      await nor.finalizeUpgrade_v2(locator, encodeBytes32String("curated-onchain-v1"), MAX_STUCK_PENALTY_DELAY);

      await expect(nor.finalizeUpgrade_v2(locator, moduleType, MAX_STUCK_PENALTY_DELAY)).to.be.revertedWith(
        "UNEXPECTED_CONTRACT_VERSION",
      );
    });

    it("Makes the contract upgraded to v2", async () => {
      const latestBlock = BigInt(await time.latestBlock());

      await expect(nor.finalizeUpgrade_v2(locator, moduleType, 86400n))
        .to.emit(nor, "ContractVersionSet")
        .withArgs(contractVersion)
        .and.to.emit(nor, "StuckPenaltyDelayChanged")
        .withArgs(86400n)
        .and.to.emit(nor, "LocatorContractSet")
        .withArgs(await locator.getAddress())
        .and.to.emit(nor, "StakingModuleTypeSet")
        .withArgs(moduleType);

      expect(await nor.getLocator()).to.equal(await locator.getAddress());
      expect(await nor.getInitializationBlock()).to.equal(latestBlock);
      expect(await lido.allowance(await nor.getAddress(), burnerAddress)).to.equal(MaxUint256);
      expect(await nor.getStuckPenaltyDelay()).to.equal(86400n);
      expect(await nor.getContractVersion()).to.equal(contractVersion);
      expect(await nor.getType()).to.equal(moduleType);
    });

    it("Migrates the contract storage from v1 to v2", async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.equal(
        secondNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[thirdNodeOperatorId])).to.equal(
        thirdNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[fourthNodeOperatorId])).to.equal(
        fourthNodeOperatorId,
      );

      await nor.harness__unsafeResetModuleSummary();
      const resetSummary = await nor.getStakingModuleSummary();
      expect(resetSummary.totalExitedValidators).to.equal(0n);
      expect(resetSummary.totalDepositedValidators).to.equal(0n);
      expect(resetSummary.depositableValidatorsCount).to.equal(0n);

      await nor.harness__unsafeSetVettedKeys(
        firstNodeOperatorId,
        NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount - 1n,
      );
      await nor.harness__unsafeSetVettedKeys(
        secondNodeOperatorId,
        NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount + 1n,
      );
      await nor.harness__unsafeSetVettedKeys(
        thirdNodeOperatorId,
        NODE_OPERATORS[thirdNodeOperatorId].totalSigningKeysCount,
      );

      await expect(nor.finalizeUpgrade_v2(locator, moduleType, 86400n))
        .to.emit(nor, "ContractVersionSet")
        .withArgs(contractVersion)
        .and.to.emit(nor, "StuckPenaltyDelayChanged")
        .withArgs(86400n)
        .and.to.emit(nor, "LocatorContractSet")
        .withArgs(await locator.getAddress())
        .and.to.emit(nor, "StakingModuleTypeSet")
        .withArgs(moduleType);

      const summary = await nor.getStakingModuleSummary();
      expect(summary.totalExitedValidators).to.equal(1n + 0n + 0n + 1n);
      expect(summary.totalDepositedValidators).to.equal(5n + 7n + 0n + 2n);
      expect(summary.depositableValidatorsCount).to.equal(0n + 8n + 0n + 0n);

      const firstNoInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      expect(firstNoInfo.totalVettedValidators).to.equal(NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount);

      const secondNoInfo = await nor.getNodeOperator(secondNodeOperatorId, true);
      expect(secondNoInfo.totalVettedValidators).to.equal(NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount);

      const thirdNoInfo = await nor.getNodeOperator(thirdNodeOperatorId, true);
      expect(thirdNoInfo.totalVettedValidators).to.equal(NODE_OPERATORS[thirdNodeOperatorId].depositedSigningKeysCount);

      const fourthNoInfo = await nor.getNodeOperator(fourthNodeOperatorId, true);
      expect(fourthNoInfo.totalVettedValidators).to.equal(NODE_OPERATORS[fourthNodeOperatorId].vettedSigningKeysCount);
    });
  });
});
