import { expect } from "chai";
import { encodeBytes32String } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { ACL, Kernel, Lido, LidoLocator, NodeOperatorsRegistry__Harness } from "typechain-types";

import {
  addNodeOperator,
  advanceChainTime,
  certainAddress,
  ether,
  NodeOperatorConfig,
  prepIdsCountsPayload,
  RewardDistributionState,
} from "lib";

import { addAragonApp, deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

describe("NodeOperatorsRegistry.sol:rewards-penalties", () => {
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
    [deployer, user, stakingRouter, nodeOperatorsManager, signingKeysManager, limitsManager, stranger] =
      await ethers.getSigners();

    const burner = await ethers.deployContract("Burner__MockForLidoHandleOracleReport");

    ({ lido, dao, acl } = await deployLidoDao({
      rootAccount: deployer,
      initialized: true,
      locatorConfig: {
        stakingRouter,
        burner,
      },
    }));

    const allocLib = await ethers.deployContract("MinFirstAllocationStrategy", deployer);
    const norHarnessFactory = await ethers.getContractFactory("NodeOperatorsRegistry__Harness", {
      libraries: {
        ["contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]: await allocLib.getAddress(),
      },
    });

    impl = await norHarnessFactory.connect(deployer).deploy();

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
    // inside the testing_requestValidatorsKeysForDeposits() method
    await acl.grantPermission(nor, nor, await nor.STAKING_ROUTER_ROLE());

    locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), user);

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

  context("onRewardsMinted", () => {
    beforeEach(async () => {
      await nor.connect(nodeOperatorsManager).addNodeOperator("abcdef", certainAddress("node-operator-0"));
      expect(await nor.getNodeOperatorIsActive(0n)).to.be.true;
    });

    it("Reverts if has no STAKING_ROUTER_ROLE assigned", async () => {
      await expect(nor.onRewardsMinted(10n)).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Does nothing yet if called by StakingRouter", async () => {
      await nor.connect(stakingRouter).onRewardsMinted(10n);
    });
  });

  context("updateStuckValidatorsCount", () => {
    beforeEach(async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.equal(
        secondNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[thirdNodeOperatorId])).to.equal(
        thirdNodeOperatorId,
      );

      await nor.connect(nodeOperatorsManager).setStuckPenaltyDelay(86400n);
    });

    it("Reverts if has no STAKING_ROUTER_ROLE assigned", async () => {
      const idsPayload = prepIdsCountsPayload([], []);
      await expect(nor.updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts)).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );
    });

    it("Reverts with INVALID_REPORT_DATA if report data is malformed", async () => {
      const idsPayload = prepIdsCountsPayload([1n], [1n]);

      const malformedKeys = idsPayload.keysCounts + "00";
      await expect(
        nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, malformedKeys),
      ).to.be.revertedWith("INVALID_REPORT_DATA");
    });

    it("Allows calling with zero length data", async () => {
      const nonce = await nor.getNonce();
      const idsPayload = prepIdsCountsPayload([], []);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.not.emit(nor, "StuckPenaltyStateChanged");
    });

    it("Allows updating a single NO", async () => {
      const nonce = await nor.getNonce();
      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [2n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 2n, 0n, 0n);
    });

    it("Allows updating a group of NOs", async () => {
      const nonce = await nor.getNonce();
      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId), BigInt(secondNodeOperatorId)], [2n, 3n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 2n, 0n, 0n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(secondNodeOperatorId, 3n, 0n, 0n);
    });

    it("Does nothing if stuck keys haven't changed", async () => {
      const nonce = await nor.getNonce();
      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [2n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 2n, 0n, 0n);

      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.not.emit(nor, "StuckPenaltyStateChanged");
    });

    it("Allows setting stuck count to zero after all", async () => {
      const nonce = await nor.getNonce();
      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [2n]);

      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 2n, 0n, 0n);

      const idsPayloadZero = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [0n]);

      const timestamp = BigInt(await time.latest());
      await expect(
        nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayloadZero.operatorIds, idsPayloadZero.keysCounts),
      )
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 0n, 0n, timestamp + 86400n + 1n);
    });

    it("Penalizes node operators with stuck penalty active", async () => {
      await lido.connect(user).resume();
      await user.sendTransaction({ to: await lido.getAddress(), value: ether("1.0") });
      await lido.connect(user).transfer(await nor.getAddress(), await lido.balanceOf(user));

      const nonce = await nor.getNonce();
      const idsPayload = prepIdsCountsPayload([1n], [2n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(1n, 2n, 0n, 0n);

      await nor.harness__setRewardDistributionState(RewardDistributionState.ReadyForDistribution);
      await expect(nor.connect(stakingRouter).distributeReward()).to.emit(nor, "NodeOperatorPenalized");
    });
  });

  context("updateExitedValidatorsCount", () => {
    beforeEach(async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.equal(
        secondNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[thirdNodeOperatorId])).to.equal(
        thirdNodeOperatorId,
      );

      await nor.connect(nodeOperatorsManager).setStuckPenaltyDelay(86400n);
    });

    it("Reverts if has no STAKING_ROUTER_ROLE assigned", async () => {
      const idsPayload = prepIdsCountsPayload([], []);
      await expect(nor.updateExitedValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts)).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );
    });

    it("Allows calling with zero length data", async () => {
      const nonce = await nor.getNonce();
      const idsPayload = prepIdsCountsPayload([], []);
      await expect(
        nor.connect(stakingRouter).updateExitedValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts),
      )
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.not.emit(nor, "ExitedSigningKeysCountChanged");
    });

    it("Allows updating exited keys for a single NO", async () => {
      const nonce = await nor.getNonce();
      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [2n]);
      await expect(
        nor.connect(stakingRouter).updateExitedValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts),
      )
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "ExitedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, 2n);
    });

    it("Allows updating exited keys for a group of NOs", async () => {
      const nonce = await nor.getNonce();
      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId), BigInt(secondNodeOperatorId)], [2n, 3n]);
      await expect(
        nor.connect(stakingRouter).updateExitedValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts),
      )
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "ExitedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, 2n)
        .to.emit(nor, "ExitedSigningKeysCountChanged")
        .withArgs(secondNodeOperatorId, 3n);
    });

    it("Does nothing if exited keys haven't changed", async () => {
      const nonce = await nor.getNonce();
      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [2n]);
      await expect(
        nor.connect(stakingRouter).updateExitedValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts),
      )
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "ExitedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, 2n);

      await expect(
        nor.connect(stakingRouter).updateExitedValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts),
      )
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.not.emit(nor, "ExitedSigningKeysCountChanged");
    });

    it("Reverts on attempt to decrease exited keys count", async () => {
      const nonce = await nor.getNonce();
      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [2n]);

      await expect(
        nor.connect(stakingRouter).updateExitedValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts),
      )
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "ExitedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, 2n);

      const idsPayloadZero = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [0n]);

      await expect(
        nor.connect(stakingRouter).updateExitedValidatorsCount(idsPayloadZero.operatorIds, idsPayloadZero.keysCounts),
      ).to.revertedWith("EXITED_VALIDATORS_COUNT_DECREASED");
    });
  });

  context("updateRefundedValidatorsCount", () => {
    beforeEach(async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.equal(
        secondNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[thirdNodeOperatorId])).to.equal(
        thirdNodeOperatorId,
      );

      await nor.connect(nodeOperatorsManager).setStuckPenaltyDelay(86400n);
    });

    it("Revers if no such an operator exists", async () => {
      await expect(nor.updateRefundedValidatorsCount(4n, 0n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if has no STAKING_ROUTER_ROLE assigned", async () => {
      await expect(nor.updateRefundedValidatorsCount(firstNodeOperatorId, 0n)).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Allows updating a single NO", async () => {
      const nonce = await nor.getNonce();
      await expect(nor.connect(stakingRouter).updateRefundedValidatorsCount(firstNodeOperatorId, 1n))
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 0n, 1n, 0n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n);
    });

    it("Does nothing if refunded keys haven't changed", async () => {
      const nonce = await nor.getNonce();
      await expect(nor.connect(stakingRouter).updateRefundedValidatorsCount(firstNodeOperatorId, 1n))
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 0n, 1n, 0n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n);

      await expect(nor.connect(stakingRouter).updateRefundedValidatorsCount(firstNodeOperatorId, 1n))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.not.emit(nor, "StuckPenaltyStateChanged");
    });

    it("Allows setting refunded count to zero after all", async () => {
      const nonce = await nor.getNonce();
      await expect(nor.connect(stakingRouter).updateRefundedValidatorsCount(firstNodeOperatorId, 1n))
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 0n, 1n, 0n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n);

      await expect(nor.connect(stakingRouter).updateRefundedValidatorsCount(firstNodeOperatorId, 0n))
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 0n, 0n, 0n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n);
    });
  });

  context("onExitedAndStuckValidatorsCountsUpdated", () => {
    beforeEach(async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.equal(
        secondNodeOperatorId,
      );
      expect(await acl["hasPermission(address,address,bytes32)"](stakingRouter, nor, await nor.STAKING_ROUTER_ROLE()))
        .to.be.true;
    });

    it("Reverts if has no STAKING_ROUTER_ROLE assigned", async () => {
      expect(await acl["hasPermission(address,address,bytes32)"](stranger, nor, await nor.STAKING_ROUTER_ROLE())).to.be
        .false;

      await expect(nor.connect(stranger).onExitedAndStuckValidatorsCountsUpdated()).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );
    });

    it("Update reward distribution state", async () => {
      await expect(nor.connect(stakingRouter).onExitedAndStuckValidatorsCountsUpdated())
        .to.emit(nor, "RewardDistributionStateChanged")
        .withArgs(RewardDistributionState.ReadyForDistribution);
    });
  });

  context("isOperatorPenalized", () => {
    beforeEach(async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.equal(
        secondNodeOperatorId,
      );
    });

    it("Returns false if no such an operator exists", async () => {
      await expect(await nor.isOperatorPenalized(10n)).to.be.false;
    });

    it("Returns false for non-penalized operator", async () => {
      expect(await nor.isOperatorPenalized(firstNodeOperatorId)).to.be.false;
      expect(await nor.isOperatorPenalized(secondNodeOperatorId)).to.be.false;
    });

    it("Returns true if stuck > refunded", async () => {
      await nor.connect(stakingRouter).updateRefundedValidatorsCount(firstNodeOperatorId, 1n);

      const nonce = await nor.getNonce();
      let idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [2n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 2n, 1n, 0n);

      idsPayload = prepIdsCountsPayload([BigInt(secondNodeOperatorId)], [2n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(secondNodeOperatorId, 2n, 0n, 0n);

      expect(await nor.isOperatorPenalized(firstNodeOperatorId)).to.be.true;
      expect(await nor.isOperatorPenalized(secondNodeOperatorId)).to.be.true;
    });

    it("Returns true if penalty hasn't ended yet", async () => {
      const nonce = await nor.getNonce();
      let idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [2n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 2n, 0n, 0n);

      idsPayload = prepIdsCountsPayload([BigInt(secondNodeOperatorId)], [3n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(secondNodeOperatorId, 3n, 0n, 0n);

      await nor.connect(stakingRouter).updateRefundedValidatorsCount(firstNodeOperatorId, 2n);
      await nor.connect(stakingRouter).updateRefundedValidatorsCount(secondNodeOperatorId, 3n);

      expect(await nor.isOperatorPenalized(firstNodeOperatorId)).to.be.true;
      expect(await nor.isOperatorPenalized(secondNodeOperatorId)).to.be.true;
    });
  });

  context("isOperatorPenaltyCleared", () => {
    beforeEach(async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.equal(
        secondNodeOperatorId,
      );
    });

    it("Returns true if no such an operator exists", async () => {
      await expect(await nor.isOperatorPenaltyCleared(10n)).to.be.true;
    });

    it("Returns true for non-penalized operator", async () => {
      expect(await nor.isOperatorPenaltyCleared(firstNodeOperatorId)).to.be.true;
      expect(await nor.isOperatorPenaltyCleared(secondNodeOperatorId)).to.be.true;
    });

    it("Returns false if stuck > refunded", async () => {
      await nor.connect(stakingRouter).updateRefundedValidatorsCount(firstNodeOperatorId, 1n);

      const nonce = await nor.getNonce();
      let idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [2n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 2n, 1n, 0n);

      idsPayload = prepIdsCountsPayload([BigInt(secondNodeOperatorId)], [2n]);

      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(secondNodeOperatorId, 2n, 0n, 0n);

      expect(await nor.isOperatorPenaltyCleared(firstNodeOperatorId)).to.be.false;
      expect(await nor.isOperatorPenaltyCleared(secondNodeOperatorId)).to.be.false;
    });

    it("Returns true if penalty hasn't ended yet", async () => {
      const nonce = await nor.getNonce();
      let idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [2n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 2n, 0n, 0n);

      idsPayload = prepIdsCountsPayload([BigInt(secondNodeOperatorId)], [3n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(secondNodeOperatorId, 3n, 0n, 0n);

      await nor.connect(stakingRouter).updateRefundedValidatorsCount(firstNodeOperatorId, 2n);
      await nor.connect(stakingRouter).updateRefundedValidatorsCount(secondNodeOperatorId, 3n);

      expect(await nor.isOperatorPenaltyCleared(firstNodeOperatorId)).to.be.false;
      expect(await nor.isOperatorPenaltyCleared(secondNodeOperatorId)).to.be.false;

      await advanceChainTime((await nor.getStuckPenaltyDelay()) + 1n);

      await nor.clearNodeOperatorPenalty(firstNodeOperatorId);

      expect(await nor.isOperatorPenaltyCleared(firstNodeOperatorId)).to.be.true;
      expect(await nor.isOperatorPenaltyCleared(secondNodeOperatorId)).to.be.false;

      await nor.clearNodeOperatorPenalty(secondNodeOperatorId);

      expect(await nor.isOperatorPenaltyCleared(firstNodeOperatorId)).to.be.true;
      expect(await nor.isOperatorPenaltyCleared(secondNodeOperatorId)).to.be.true;
    });
  });

  context("clearNodeOperatorPenalty", () => {
    beforeEach(async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.equal(
        secondNodeOperatorId,
      );
    });

    it("Reverts if no such an operator exists", async () => {
      await expect(nor.clearNodeOperatorPenalty(10n)).to.be.revertedWith("CANT_CLEAR_PENALTY");
    });

    it("Reverts if hasn't been penalized yet", async () => {
      await expect(nor.clearNodeOperatorPenalty(firstNodeOperatorId)).to.be.revertedWith("CANT_CLEAR_PENALTY");
      await expect(nor.clearNodeOperatorPenalty(secondNodeOperatorId)).to.be.revertedWith("CANT_CLEAR_PENALTY");
    });

    it("Reverts if the penalty delay hasn't passed yet", async () => {
      const nonce = await nor.getNonce();
      let idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [1n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 1n, 0n, 0n);

      idsPayload = prepIdsCountsPayload([BigInt(secondNodeOperatorId)], [2n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(secondNodeOperatorId, 2n, 0n, 0n);

      await nor.connect(stakingRouter).updateRefundedValidatorsCount(firstNodeOperatorId, 1n);
      await nor.connect(stakingRouter).updateRefundedValidatorsCount(secondNodeOperatorId, 2n);

      await expect(nor.clearNodeOperatorPenalty(firstNodeOperatorId)).to.be.revertedWith("CANT_CLEAR_PENALTY");
      await expect(nor.clearNodeOperatorPenalty(secondNodeOperatorId)).to.be.revertedWith("CANT_CLEAR_PENALTY");
    });

    it("Clear the penalized state", async () => {
      const nonce = await nor.getNonce();
      let idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [3n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 3n, 0n, 0n);

      idsPayload = prepIdsCountsPayload([BigInt(secondNodeOperatorId)], [4n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(secondNodeOperatorId, 4n, 0n, 0n);

      await nor.connect(stakingRouter).updateRefundedValidatorsCount(firstNodeOperatorId, 5n);
      await nor.connect(stakingRouter).updateRefundedValidatorsCount(secondNodeOperatorId, 5n);

      await advanceChainTime((await nor.getStuckPenaltyDelay()) + 1n);

      expect(await nor.isOperatorPenalized(firstNodeOperatorId)).to.be.false;
      expect(await nor.isOperatorPenalized(secondNodeOperatorId)).to.be.false;
      expect(await nor.isOperatorPenaltyCleared(firstNodeOperatorId)).to.be.false;
      expect(await nor.isOperatorPenaltyCleared(secondNodeOperatorId)).to.be.false;

      await expect(await nor.clearNodeOperatorPenalty(firstNodeOperatorId))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 5n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 5n)
        .to.emit(nor, "NodeOperatorPenaltyCleared")
        .withArgs(firstNodeOperatorId);

      await expect(await nor.clearNodeOperatorPenalty(secondNodeOperatorId))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 6n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 6n)
        .to.emit(nor, "NodeOperatorPenaltyCleared")
        .withArgs(secondNodeOperatorId);

      expect(await nor.isOperatorPenalized(firstNodeOperatorId)).to.be.false;
      expect(await nor.isOperatorPenalized(secondNodeOperatorId)).to.be.false;
      expect(await nor.isOperatorPenaltyCleared(firstNodeOperatorId)).to.be.true;
      expect(await nor.isOperatorPenaltyCleared(secondNodeOperatorId)).to.be.true;
    });
  });

  context("getRewardsDistribution", () => {
    it("Returns empty lists if no operators", async () => {
      const [recipients, shares, penalized] = await nor.getRewardsDistribution(10n);

      expect(recipients).to.be.empty;
      expect(shares).to.be.empty;
      expect(penalized).to.be.empty;
    });

    it("Returns zero rewards if zero shares distributed", async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
        firstNodeOperatorId,
      );

      const [recipients, shares, penalized] = await nor.getRewardsDistribution(0n);

      expect(recipients.length).to.be.equal(1n);
      expect(shares.length).to.be.equal(1n);
      expect(penalized.length).to.be.equal(1n);

      expect(recipients[0]).to.be.equal(NODE_OPERATORS[firstNodeOperatorId].rewardAddress);
      expect(shares[0]).to.be.equal(0n);
      expect(penalized[0]).to.be.equal(false);
    });

    it("Distributes all rewards to a single active operator if no others", async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
        firstNodeOperatorId,
      );

      const [recipients, shares, penalized] = await nor.getRewardsDistribution(10n);

      expect(recipients.length).to.be.equal(1n);
      expect(shares.length).to.be.equal(1n);
      expect(penalized.length).to.be.equal(1n);

      expect(recipients[0]).to.be.equal(NODE_OPERATORS[firstNodeOperatorId].rewardAddress);
      expect(shares[0]).to.be.equal(10n);
      expect(penalized[0]).to.be.equal(false);
    });

    it("Returns correct reward distribution for multiple NOs", async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.be.equal(
        secondNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[thirdNodeOperatorId])).to.be.equal(
        thirdNodeOperatorId,
      );

      const nonce = await nor.getNonce();
      const idsPayload = prepIdsCountsPayload([BigInt(firstNodeOperatorId)], [2n]);
      await expect(nor.connect(stakingRouter).updateStuckValidatorsCount(idsPayload.operatorIds, idsPayload.keysCounts))
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 2n, 0n, 0n);

      const [recipients, shares, penalized] = await nor.getRewardsDistribution(100n);

      expect(recipients.length).to.be.equal(2n);
      expect(shares.length).to.be.equal(2n);
      expect(penalized.length).to.be.equal(2n);

      const firstNOActiveKeys =
        NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount -
        NODE_OPERATORS[firstNodeOperatorId].exitedSigningKeysCount;
      const secondNOActiveKeys =
        NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount -
        NODE_OPERATORS[secondNodeOperatorId].exitedSigningKeysCount;
      const totalActiveKeys = firstNOActiveKeys + secondNOActiveKeys;

      expect(recipients[0]).to.be.equal(NODE_OPERATORS[firstNodeOperatorId].rewardAddress);
      expect(shares[0]).to.be.equal((100n * firstNOActiveKeys) / totalActiveKeys);
      expect(penalized[0]).to.be.equal(true);

      expect(recipients[1]).to.be.equal(NODE_OPERATORS[secondNodeOperatorId].rewardAddress);
      expect(shares[1]).to.be.equal((100n * secondNOActiveKeys) / totalActiveKeys);
      expect(penalized[1]).to.be.equal(false);
    });
  });
});
