import { expect } from "chai";
import { encodeBytes32String } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ACL, Kernel, Lido, LidoLocator, NodeOperatorsRegistry__Harness } from "typechain-types";

import { addNodeOperator, certainAddress, NodeOperatorConfig, RewardDistributionState } from "lib";

import { addAragonApp, deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

describe("NodeOperatorsRegistry.sol:auxiliary", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let limitsManager: HardhatEthersSigner;
  let nodeOperatorsManager: HardhatEthersSigner;
  let signingKeysManager: HardhatEthersSigner;
  let stakingRouter: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
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
      name: "extra-no",
      rewardAddress: certainAddress("node-operator-3"),
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
    // inside the harness__requestValidatorsKeysForDeposits() method
    await acl.grantPermission(nor, nor, await nor.STAKING_ROUTER_ROLE());

    locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), user);

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
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("unsafeUpdateValidatorsCount", () => {
    beforeEach(async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.equal(
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
      expect(beforeNOSummary.stuckValidatorsCount).to.equal(0n);
      expect(beforeNOSummary.totalExitedValidators).to.equal(1n);

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
      expect(middleNOSummary.stuckValidatorsCount).to.equal(2n);
      expect(middleNOSummary.totalExitedValidators).to.equal(3n);

      await expect(nor.connect(stakingRouter).unsafeUpdateValidatorsCount(firstNodeOperatorId, 1n, 2n))
        .to.emit(nor, "ExitedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, 1n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.not.emit(nor, "StuckPenaltyStateChanged");

      const lastNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      expect(lastNOSummary.stuckValidatorsCount).to.equal(2n);
      expect(lastNOSummary.totalExitedValidators).to.equal(1n);
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
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.equal(
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
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[thirdNodeOperatorId])).to.equal(
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
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.equal(
        firstNodeOperatorId,
      );
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.equal(
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
});
