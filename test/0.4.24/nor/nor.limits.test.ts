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

const updateTargetLimits = "updateTargetValidatorsLimits(uint256,uint256,uint256)" as const;
const updateTargetLimitsDeprecated = "updateTargetValidatorsLimits(uint256,bool,uint256)" as const;

enum UpdateTargetLimitsMethods {
  UpdateTargetValidatorsLimits = "updateTargetValidatorsLimits(uint256,uint256,uint256)",
  UpdateTargetValidatorsLimitsDeprecated = "updateTargetValidatorsLimits(uint256,bool,uint256)",
}

describe("NodeOperatorsRegistry:validatorsLimits", () => {
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

  let impl: NodeOperatorsRegistry__Harness;
  let nor: NodeOperatorsRegistry__Harness;

  let originalState: string;

  const firstNodeOperatorId = 0;
  const secondNodeOperatorId = 1;

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
  ];

  const moduleType = encodeBytes32String("curated-onchain-v1");
  const penaltyDelay = 86400n;
  const contractVersionV2 = 2n;
  const contractVersionV3 = 3n;

  before(async () => {
    [deployer, user, stakingRouter, nodeOperatorsManager, signingKeysManager, limitsManager, stranger] =
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
    // inside the harness__requestValidatorsKeysForDeposits() method
    await acl.grantPermission(nor, nor, await nor.STAKING_ROUTER_ROLE());

    locator = LidoLocator__factory.connect(await lido.getLidoLocator(), user);

    // Initialize the nor's proxy.
    await expect(nor.initialize(locator, moduleType, penaltyDelay))
      .to.emit(nor, "ContractVersionSet")
      .withArgs(contractVersionV2)
      .to.emit(nor, "ContractVersionSet")
      .withArgs(contractVersionV3)
      .and.to.emit(nor, "LocatorContractSet")
      .withArgs(locator)
      .and.to.emit(nor, "StakingModuleTypeSet")
      .withArgs(moduleType)
      .to.emit(nor, "RewardDistributionStateChanged")
      .withArgs(RewardDistributionState.Distributed);

    nor = nor.connect(user);
    originalState = await Snapshot.take();
  });

  afterEach(async () => (originalState = await Snapshot.refresh(originalState)));

  const updateLimitCall = (
    updateTargetLimitsMethod: UpdateTargetLimitsMethods,
    nodeOperatorId: number,
    isTargetLimitActiveOrMode: bigint,
    targetLimit: bigint,
  ) => {
    const id = BigInt(nodeOperatorId);
    if (updateTargetLimitsMethod === UpdateTargetLimitsMethods.UpdateTargetValidatorsLimitsDeprecated)
      return nor.connect(stakingRouter)[updateTargetLimitsMethod](id, Boolean(isTargetLimitActiveOrMode), targetLimit);
    return nor.connect(stakingRouter)[updateTargetLimitsMethod](id, isTargetLimitActiveOrMode, targetLimit);
  };

  context(`updateTargetValidatorsLimits auth`, () => {
    const targetLimit = 0n;
    before(async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.be.equal(
        secondNodeOperatorId,
      );
    });

    it('reverts with "APP_AUTH_FAILED" error when called by sender without STAKING_ROUTER_ROLE', async () => {
      expect(await acl["hasPermission(address,address,bytes32)"](stranger, nor, await nor.STAKING_ROUTER_ROLE())).to.be
        .false;

      await expect(nor[updateTargetLimitsDeprecated](firstNodeOperatorId, true, targetLimit)).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );

      await expect(nor[updateTargetLimits](firstNodeOperatorId, 0n, targetLimit)).to.be.revertedWith("APP_AUTH_FAILED");
    });
  });

  const runTests = (updateTargetLimitsMethod: UpdateTargetLimitsMethods) => {
    context(`updateTargetValidatorsLimits:${updateTargetLimitsMethod}`, () => {
      let targetLimit = 0n;

      beforeEach(async () => {
        expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
          firstNodeOperatorId,
        );
        expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.be.equal(
          secondNodeOperatorId,
        );
      });

      it('reverts with "OUT_OF_RANGE" error when called with targetLimit > UINT64_MAX', async () => {
        const targetLimitWrong = 2n ** 64n;

        await expect(
          updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, 1n, targetLimitWrong),
        ).to.be.revertedWith("OUT_OF_RANGE");
      });

      it("updates node operator target limit if called by sender with STAKING_ROUTER_ROLE", async () => {
        expect(await acl["hasPermission(address,address,bytes32)"](stakingRouter, nor, await nor.STAKING_ROUTER_ROLE()))
          .to.be.true;

        targetLimit = 10n;

        await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, 1n, targetLimit))
          .to.emit(nor, "TargetValidatorsCountChanged")
          .withArgs(firstNodeOperatorId, targetLimit, 1n);

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
          targetLimit < firstNodeOperatorDepositableValidators
            ? targetLimit
            : firstNodeOperatorDepositableValidators + secondNodeOperatorDepositableValidators;

        expect(keysStatTotal.depositableValidatorsCount).to.equal(expectedDepositableValidatorsCount);
      });

      it("updates node operator target limit mode correctly", async () => {
        expect(await acl["hasPermission(address,address,bytes32)"](stakingRouter, nor, await nor.STAKING_ROUTER_ROLE()))
          .to.be.true;

        targetLimit = 10n;

        await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, 1n, targetLimit))
          .to.emit(nor, "TargetValidatorsCountChanged")
          .withArgs(firstNodeOperatorId, targetLimit, 1n);

        let noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
        expect(noSummary.targetLimitMode).to.be.equal(1n);

        await expect(updateLimitCall(updateTargetLimitsMethod, secondNodeOperatorId, 1n, targetLimit))
          .to.emit(nor, "TargetValidatorsCountChanged")
          .withArgs(secondNodeOperatorId, targetLimit, 1n);

        noSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
        expect(noSummary.targetLimitMode).to.be.equal(1n);

        // reset limit
        await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, 0n, targetLimit))
          .to.emit(nor, "TargetValidatorsCountChanged")
          .withArgs(firstNodeOperatorId, 0n, 0n);

        noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
        expect(noSummary.targetLimitMode).to.equal(0n);
        expect(noSummary.targetValidatorsCount).to.equal(0n);

        await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, 0n, targetLimit))
          .to.emit(nor, "TargetValidatorsCountChanged")
          .withArgs(firstNodeOperatorId, 0n, 0n);

        noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
        expect(noSummary.targetLimitMode).to.equal(0n);
        expect(noSummary.targetValidatorsCount).to.equal(0n);
      });

      it("nonce changing", async () => {
        targetLimit = 10n;

        await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, 1n, targetLimit))
          .to.emit(nor, "TargetValidatorsCountChanged")
          .withArgs(firstNodeOperatorId, targetLimit, 1n);

        await expect(await nor.connect(stakingRouter).getNonce()).to.be.equal(1n);

        await expect(updateLimitCall(updateTargetLimitsMethod, secondNodeOperatorId, 0n, targetLimit))
          .to.emit(nor, "TargetValidatorsCountChanged")
          .withArgs(secondNodeOperatorId, 0n, 0n);

        await expect(await nor.connect(stakingRouter).getNonce()).to.be.equal(2n);
      });

      it("nonce changing even if limit is the same", async () => {
        targetLimit = 10n;

        await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, 1n, targetLimit))
          .to.emit(nor, "TargetValidatorsCountChanged")
          .withArgs(firstNodeOperatorId, targetLimit, 1n);

        await expect(await nor.connect(stakingRouter).getNonce()).to.be.equal(1n);

        await expect(updateLimitCall(updateTargetLimitsMethod, secondNodeOperatorId, 0n, targetLimit))
          .to.emit(nor, "TargetValidatorsCountChanged")
          .withArgs(secondNodeOperatorId, 0n, 0n);

        await expect(await nor.connect(stakingRouter).getNonce()).to.be.equal(2n);

        await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, 0n, targetLimit))
          .to.emit(nor, "TargetValidatorsCountChanged")
          .withArgs(firstNodeOperatorId, 0n, 0n);

        await expect(await nor.connect(stakingRouter).getNonce()).to.be.equal(3n);
      });

      context("the change in the target limit affects in node operator summary", () => {
        it("targetLimitMode = 1; targetLimit = 10", async () => {
          const targetLimitMode = 1n;
          targetLimit = 10n;

          await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, targetLimitMode, targetLimit))
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, targetLimit, targetLimitMode);

          let noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.be.equal(1n);
          expect(noSummary.targetValidatorsCount).to.equal(10n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(1n);

          await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, targetLimitMode, 0n))
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, 0n, 1n);

          noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.equal(1n);
          expect(noSummary.targetValidatorsCount).to.equal(0n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(0n);

          await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, targetLimitMode, targetLimit))
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, targetLimit, 1n);

          noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.equal(1n);
          expect(noSummary.targetValidatorsCount).to.equal(10n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(1n);
        });

        it("targetLimitMode = 2; targetLimit = 10", async () => {
          const targetLimitMode = 2n;
          targetLimit = 10n;

          await expect(
            updateLimitCall(
              UpdateTargetLimitsMethods.UpdateTargetValidatorsLimits,
              firstNodeOperatorId,
              targetLimitMode,
              targetLimit,
            ),
          )
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, targetLimit, targetLimitMode);

          let noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.be.equal(2n);
          expect(noSummary.targetValidatorsCount).to.equal(10n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(1n);

          await expect(
            updateLimitCall(
              UpdateTargetLimitsMethods.UpdateTargetValidatorsLimits,
              firstNodeOperatorId,
              targetLimitMode,
              0n,
            ),
          )
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, 0n, 2n);

          noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.equal(2n);
          expect(noSummary.targetValidatorsCount).to.equal(0n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(0n);

          await expect(
            updateLimitCall(
              UpdateTargetLimitsMethods.UpdateTargetValidatorsLimits,
              firstNodeOperatorId,
              targetLimitMode,
              targetLimit,
            ),
          )
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, targetLimit, 2n);

          noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.equal(2n);
          expect(noSummary.targetValidatorsCount).to.equal(10n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(1n);
        });

        it("targetLimitMode = 0; targetLimit = 10", async () => {
          const targetLimitMode = 0n;
          targetLimit = 10n;

          await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, targetLimitMode, targetLimit))
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, 0n, targetLimitMode);

          let noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.be.equal(0n);
          expect(noSummary.targetValidatorsCount).to.equal(0n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(1n);

          await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, targetLimitMode, 0n))
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, 0n, 0n);

          noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.equal(0n);
          expect(noSummary.targetValidatorsCount).to.equal(0n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(1n);

          await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, targetLimitMode, targetLimit))
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, 0n, 0n);

          noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.equal(0n);
          expect(noSummary.targetValidatorsCount).to.equal(0n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(1n);
        });

        it("targetLimitMode = 1; targetLimit = 5", async () => {
          const targetLimitMode = 1n;
          targetLimit = 5n;

          await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, targetLimitMode, targetLimit))
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, targetLimit, targetLimitMode);

          let noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.be.equal(1n);
          expect(noSummary.targetValidatorsCount).to.equal(5n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(1n);

          await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, targetLimitMode, 0n))
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, 0n, 1n);

          noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.equal(1n);
          expect(noSummary.targetValidatorsCount).to.equal(0n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(0n);

          await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, targetLimitMode, targetLimit))
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, targetLimit, 1n);

          noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.equal(1n);
          expect(noSummary.targetValidatorsCount).to.equal(5n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(1n);
        });

        it("targetLimitMode = 0; targetLimit = 5", async () => {
          const targetLimitMode = 0n;
          targetLimit = 5n;

          await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, targetLimitMode, targetLimit))
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, 0n, targetLimitMode);

          let noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.be.equal(0n);
          expect(noSummary.targetValidatorsCount).to.equal(0n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(1n);

          await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, targetLimitMode, 0n))
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, 0n, 0n);

          noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.equal(0n);
          expect(noSummary.targetValidatorsCount).to.equal(0n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(1n);

          await expect(updateLimitCall(updateTargetLimitsMethod, firstNodeOperatorId, targetLimitMode, targetLimit))
            .to.emit(nor, "TargetValidatorsCountChanged")
            .withArgs(firstNodeOperatorId, 0n, 0n);

          noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
          expect(noSummary.targetLimitMode).to.equal(0n);
          expect(noSummary.targetValidatorsCount).to.equal(0n);
          expect(noSummary.stuckValidatorsCount).to.be.equal(0n);
          expect(noSummary.refundedValidatorsCount).to.be.equal(0n);
          expect(noSummary.stuckPenaltyEndTimestamp).to.be.equal(0n);
          expect(noSummary.totalExitedValidators).to.be.equal(1n);
          expect(noSummary.totalDepositedValidators).to.be.equal(5n);
          expect(noSummary.depositableValidatorsCount).to.be.equal(1n);
        });
      });
    });
  };

  runTests(UpdateTargetLimitsMethods.UpdateTargetValidatorsLimits);
  runTests(UpdateTargetLimitsMethods.UpdateTargetValidatorsLimitsDeprecated);
});
