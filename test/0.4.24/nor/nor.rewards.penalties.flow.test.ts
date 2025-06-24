import { expect } from "chai";
import { encodeBytes32String } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ACL, Kernel, Lido, LidoLocator, NodeOperatorsRegistry__Harness } from "typechain-types";

import {
  addNodeOperator,
  certainAddress,
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
  const exitDeadlineThreshold = 86400n;
  const contractVersion = 2n;

  before(async () => {
    [deployer, user, stakingRouter, nodeOperatorsManager, signingKeysManager, limitsManager, stranger] =
      await ethers.getSigners();

    const burner = await ethers.deployContract("Burner__MockForAccounting");

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
    await expect(nor.initialize(locator, moduleType, exitDeadlineThreshold))
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

      expect(recipients[1]).to.be.equal(NODE_OPERATORS[secondNodeOperatorId].rewardAddress);
      expect(shares[1]).to.be.equal((100n * secondNOActiveKeys) / totalActiveKeys);
    });
  });
});
