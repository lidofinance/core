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
  NodeOperatorsRegistry__Harness,
  NodeOperatorsRegistry__Harness__factory,
} from "typechain-types";

import { addNodeOperator, certainAddress, NodeOperatorConfig, prepIdsCountsPayload } from "lib";

import { addAragonApp, deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

describe("NodeOperatorsRegistry:auxiliary", () => {
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
      depositedSigningKeysCount: 3n,
      exitedSigningKeysCount: 0n,
      vettedSigningKeysCount: 3n,
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
    // inside the harness__requestValidatorsKeysForDeposits() method
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

  context("unsafeUpdateValidatorsCount", () => {
    beforeEach(async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.be.equal(
        secondNodeOperatorId,
      );
    });

    it("Reverts if no such an operator exists", async () => {
      await expect(nor.unsafeUpdateValidatorsCount(3n, 0n, 0n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if has not STAKING_ROUTER_ROLE assigned", async () => {
      await expect(nor.connect(stranger).unsafeUpdateValidatorsCount(firstNodeOperatorId, 0n, 0n)).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );
    });

    it("Can change stuck and exited keys arbitrary (even decreasing exited)", async () => {
      const nonce = await nor.getNonce();

      const beforeNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      expect(beforeNOSummary.stuckValidatorsCount).to.be.equal(0n);
      expect(beforeNOSummary.totalExitedValidators).to.be.equal(1n);

      await expect(nor.connect(stakingRouter).unsafeUpdateValidatorsCount(firstNodeOperatorId, 3n, 2n))
        .to.emit(nor, "StuckPenaltyStateChanged")
        .withArgs(firstNodeOperatorId, 2n, 0n, 0n) // doesn't affect stuck penalty deadline
        .to.emit(nor, "ExitedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, 3n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n);

      const middleNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      expect(middleNOSummary.stuckValidatorsCount).to.be.equal(2n);
      expect(middleNOSummary.totalExitedValidators).to.be.equal(3n);

      await expect(nor.connect(stakingRouter).unsafeUpdateValidatorsCount(firstNodeOperatorId, 1n, 2n))
        .to.emit(nor, "ExitedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, 1n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.not.emit(nor, "StuckPenaltyStateChanged");

      const lastNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      expect(lastNOSummary.stuckValidatorsCount).to.be.equal(2n);
      expect(lastNOSummary.totalExitedValidators).to.be.equal(1n);
    });
  });

  context("updateTargetValidatorsLimits", () => {
    let targetLimit = 0n;

    beforeEach(async () => {
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

      await expect(nor.updateTargetValidatorsLimits(firstNodeOperatorId, true, targetLimit)).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );
    });

    it('reverts with "OUT_OF_RANGE" error when called with targetLimit > UINT64_MAX', async () => {
      const targetLimitWrong = BigInt("0x10000000000000000");

      await expect(
        nor.connect(stakingRouter).updateTargetValidatorsLimits(firstNodeOperatorId, true, targetLimitWrong),
      ).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("updates node operator target limit if called by sender with STAKING_ROUTER_ROLE", async () => {
      expect(await acl["hasPermission(address,address,bytes32)"](stakingRouter, nor, await nor.STAKING_ROUTER_ROLE()))
        .to.be.true;

      targetLimit = 10n;

      await expect(nor.connect(stakingRouter).updateTargetValidatorsLimits(firstNodeOperatorId, true, targetLimit))
        .to.emit(nor, "TargetValidatorsCountChanged")
        .withArgs(firstNodeOperatorId, targetLimit);

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

      await expect(nor.connect(stakingRouter).updateTargetValidatorsLimits(firstNodeOperatorId, true, targetLimit))
        .to.emit(nor, "TargetValidatorsCountChanged")
        .withArgs(firstNodeOperatorId, targetLimit);

      let noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      expect(noSummary.isTargetLimitActive).to.be.true;

      await expect(nor.connect(stakingRouter).updateTargetValidatorsLimits(secondNodeOperatorId, false, targetLimit))
        .to.emit(nor, "TargetValidatorsCountChanged")
        .withArgs(secondNodeOperatorId, targetLimit);

      noSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      expect(noSummary.isTargetLimitActive).to.be.false;

      // reset limit
      await expect(nor.connect(stakingRouter).updateTargetValidatorsLimits(firstNodeOperatorId, false, targetLimit))
        .to.emit(nor, "TargetValidatorsCountChanged")
        .withArgs(firstNodeOperatorId, 10n); // expect limit set to 0

      noSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      expect(noSummary.isTargetLimitActive).to.equal(false);

      noSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      expect(noSummary.isTargetLimitActive).to.equal(false);
    });
  });

  context("onWithdrawalCredentialsChanged", () => {
    it("Reverts if has no STAKING_ROUTER_ROLE assigned", async () => {
      await expect(nor.onWithdrawalCredentialsChanged()).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Does nothing if have no operators yet", async () => {
      await expect(nor.connect(stakingRouter).onWithdrawalCredentialsChanged())
        .to.not.emit(nor, "KeysOpIndexSet")
        .to.not.emit(nor, "NonceChanged");
    });

    it("Invalidates all deposit data for every operator", async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.be.equal(
        secondNodeOperatorId,
      );

      const nonce = await nor.getNonce();

      await expect(nor.connect(stakingRouter).onWithdrawalCredentialsChanged())
        .to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount)
        .and.to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(secondNodeOperatorId, NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount)
        .to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount)
        .and.to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(secondNodeOperatorId, NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount)
        .to.emit(nor, "NodeOperatorTotalKeysTrimmed")
        .withArgs(
          firstNodeOperatorId,
          NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount -
            NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount,
        )
        .and.to.emit(nor, "NodeOperatorTotalKeysTrimmed")
        .withArgs(
          secondNodeOperatorId,
          NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount -
            NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount,
        )
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n);
    });
  });

  context("invalidateReadyToDepositKeysRange", () => {
    it("Reverts if has no MANAGE_NODE_OPERATOR_ROLE assigned", async () => {
      await expect(nor.invalidateReadyToDepositKeysRange(0n, 0n)).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Reverts if there are no operators", async () => {
      await expect(nor.connect(nodeOperatorsManager).invalidateReadyToDepositKeysRange(0n, 0n)).to.be.revertedWith(
        "OUT_OF_RANGE",
      );
    });

    it("Invalidates the deposit data even if no trimming needed", async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[fourthNodeOperatorId])).to.be.equal(
        firstNodeOperatorId,
      );

      await expect(
        nor.connect(nodeOperatorsManager).invalidateReadyToDepositKeysRange(firstNodeOperatorId, firstNodeOperatorId),
      )
        .to.not.emit(nor, "TotalSigningKeysCountChanged")
        .to.not.emit(nor, "VettedSigningKeysCountChanged")
        .to.not.emit(nor, "NodeOperatorTotalKeysTrimmed")
        .to.not.emit(nor, "KeysOpIndexSet")
        .to.not.emit(nor, "NonceChanged");
    });

    it("Invalidates all deposit data for every operator", async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.be.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.be.equal(
        secondNodeOperatorId,
      );

      const nonce = await nor.getNonce();

      await expect(
        nor.connect(nodeOperatorsManager).invalidateReadyToDepositKeysRange(firstNodeOperatorId, secondNodeOperatorId),
      )
        .to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount)
        .and.to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(secondNodeOperatorId, NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount)
        .to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount)
        .and.to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(secondNodeOperatorId, NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount)
        .to.emit(nor, "NodeOperatorTotalKeysTrimmed")
        .withArgs(
          firstNodeOperatorId,
          NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount -
            NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount,
        )
        .and.to.emit(nor, "NodeOperatorTotalKeysTrimmed")
        .withArgs(
          secondNodeOperatorId,
          NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount -
            NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount,
        )
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n);
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
