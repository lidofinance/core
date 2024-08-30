import { expect } from "chai";
import { BigNumberish, BytesLike, encodeBytes32String } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ACL, Kernel, Lido, LidoLocator, NodeOperatorsRegistry__Harness } from "typechain-types";

import {
  addNodeOperator,
  certainAddress,
  EMPTY_PUBLIC_KEY,
  EMPTY_SIGNATURE,
  ether,
  FakeValidatorKeys,
  impersonate,
  NodeOperatorConfig,
  randomAddress,
  unpackKeySig,
} from "lib";

import { addAragonApp, deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

describe("NodeOperatorsRegistry.sol:signing-keys", () => {
  const UINT64_MAX = 2n ** 64n - 1n;

  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let firstNOManager: HardhatEthersSigner;
  let secondNOManager: HardhatEthersSigner;

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
      totalSigningKeysCount: 8n,
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
      totalSigningKeysCount: 12n,
      depositedSigningKeysCount: 7n,
      exitedSigningKeysCount: 0n,
      vettedSigningKeysCount: 10n,
      stuckValidatorsCount: 0n,
      refundedValidatorsCount: 0n,
      stuckPenaltyEndAt: 0n,
    },
    {
      name: " super large",
      rewardAddress: certainAddress("node-operator-3"),
      totalSigningKeysCount: UINT64_MAX - 20n,
      depositedSigningKeysCount: 0n,
      exitedSigningKeysCount: 0n,
      vettedSigningKeysCount: 5n,
      stuckValidatorsCount: 0n,
      refundedValidatorsCount: 0n,
      stuckPenaltyEndAt: 0n,
    },
    {
      name: "extra",
      rewardAddress: certainAddress("node-operator-4"),
      totalSigningKeysCount: 5n,
      depositedSigningKeysCount: 5n,
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

  const firstNOKeys = new FakeValidatorKeys(5, { kFill: "a", sFill: "b" });
  const secondNOKeys = new FakeValidatorKeys(9, { kFill: "c", sFill: "d" });
  const thirdNOKeys = new FakeValidatorKeys(30, { kFill: "c", sFill: "d" });

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

    impl = await ethers.deployContract("NodeOperatorsRegistry__Harness", deployer);
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

    locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), deployer);

    // Initialize the nor's proxy.
    await expect(nor.initialize(locator, moduleType, penaltyDelay))
      .to.emit(nor, "ContractVersionSet")
      .withArgs(contractVersion)
      .and.to.emit(nor, "LocatorContractSet")
      .withArgs(locator)
      .and.to.emit(nor, "StakingModuleTypeSet")
      .withArgs(moduleType);

    nor = nor.connect(user);

    firstNOManager = await impersonate(NODE_OPERATORS[firstNodeOperatorId].rewardAddress, ether("100.0"));
    secondNOManager = await impersonate(NODE_OPERATORS[secondNodeOperatorId].rewardAddress, ether("100.0"));

    expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[firstNodeOperatorId])).to.equal(
      firstNodeOperatorId,
    );
    expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[secondNodeOperatorId])).to.equal(
      secondNodeOperatorId,
    );
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("obtainDepositData", () => {
    it("Reverts if has no STAKING_ROUTER_ROLE assigned", async () => {
      await expect(nor.obtainDepositData(0n, "0x")).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("returns empty data if zero available keys", async () => {
      await nor.connect(nodeOperatorsManager).deactivateNodeOperator(firstNodeOperatorId);
      await nor.connect(nodeOperatorsManager).deactivateNodeOperator(secondNodeOperatorId);
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[fourthNodeOperatorId])).to.equal(
        thirdNodeOperatorId,
      );

      const [allocatedKeys, noIds, activeKeys] = await nor.harness__getSigningKeysAllocationData(1n);

      expect(allocatedKeys).to.equal(0n);
      expect(noIds).to.be.empty;
      expect(activeKeys).to.be.empty;

      await expect(nor.connect(stakingRouter).harness__obtainDepositData(1n)).to.be.revertedWith(
        "INVALID_ALLOCATED_KEYS_COUNT",
      );
    });

    it("Shrinks the length of signing keys", async () => {
      await nor.connect(nodeOperatorsManager).deactivateNodeOperator(firstNodeOperatorId);
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[fourthNodeOperatorId])).to.equal(
        thirdNodeOperatorId,
      );

      const [allocatedKeys, noIds, activeKeys] = await nor.harness__getSigningKeysAllocationData(1n);

      expect(allocatedKeys).to.equal(1n);
      expect(noIds.length).to.equal(1n);
      expect(activeKeys.length).to.equal(1n);

      expect(noIds[0]).to.equal(secondNodeOperatorId);
      expect(activeKeys[0]).to.equal(7n + 1n);

      const nonce = await nor.getNonce();
      await expect(nor.connect(stakingRouter).harness__obtainDepositData(1n))
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n);
    });

    it("Skips loading the operator's keys if hasn't participated in allocation [test coverage sentinel]", async () => {
      const depositedBefore = (await nor.getStakingModuleSummary()).totalDepositedValidators;

      await expect(nor.harness__loadAllocatedSigningKeys(1n, [0n, 1n], [5n, 7n]))
        .to.emit(nor, "DepositedSigningKeysCountChanged")
        .withArgs(0n, 6n);

      const depositedAfter = (await nor.getStakingModuleSummary()).totalDepositedValidators;

      expect(depositedAfter).to.equal(depositedBefore + 1n);
    });

    it("Returns empty data if zero deposits requested", async () => {
      await nor.connect(stakingRouter).harness__obtainDepositData(0n);

      expect(await nor.obtainedPublicKeys()).to.equal("0x");
      expect(await nor.obtainedSignatures()).to.equal("0x");
    });

    it("Reverts if allocated keys count != requested", async () => {
      const depositable = (await nor.getStakingModuleSummary()).depositableValidatorsCount;

      await expect(nor.connect(stakingRouter).harness__obtainDepositData(depositable + 1n)).to.be.revertedWith(
        "INVALID_ALLOCATED_KEYS_COUNT",
      );
    });

    it("Returns allocated keys and updates nonce", async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[fourthNodeOperatorId])).to.equal(
        thirdNodeOperatorId,
      );

      const nonce = await nor.getNonce();

      const summaryBefore = await nor.getStakingModuleSummary();
      expect(summaryBefore.depositableValidatorsCount).to.equal(
        NODE_OPERATORS[firstNodeOperatorId].vettedSigningKeysCount -
          NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount +
          NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount -
          NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount,
      );

      await expect(nor.connect(stakingRouter).harness__obtainDepositData(summaryBefore.depositableValidatorsCount))
        .to.emit(nor, "ValidatorsKeysLoaded")
        .to.emit(nor, "DepositedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].vettedSigningKeysCount)
        .and.to.emit(nor, "DepositedSigningKeysCountChanged")
        .withArgs(secondNodeOperatorId, NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n);

      const summaryAfter = await nor.getStakingModuleSummary();
      expect(summaryAfter.depositableValidatorsCount).to.equal(0);
    });
  });

  function addSigningKeysCases<TResult>(
    addKeysFn: (
      nor_instance: NodeOperatorsRegistry__Harness,
      _nodeOperatorId: BigNumberish,
      _keysCount: BigNumberish,
      _publicKeys: BytesLike,
      _signatures: BytesLike,
    ) => TResult,
  ) {
    it("Reverts if no such an operator exists", async () => {
      await expect(addKeysFn(nor, 5n, 0n, EMPTY_PUBLIC_KEY, EMPTY_SIGNATURE)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if has no management rights", async () => {
      await expect(addKeysFn(nor.connect(stranger), 0n, 0n, EMPTY_PUBLIC_KEY, EMPTY_SIGNATURE)).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );

      await expect(
        addKeysFn(nor.connect(nodeOperatorsManager), 0n, 0n, EMPTY_PUBLIC_KEY, EMPTY_SIGNATURE),
      ).to.be.revertedWith("APP_AUTH_FAILED");

      await expect(addKeysFn(nor.connect(limitsManager), 0n, 0n, EMPTY_PUBLIC_KEY, EMPTY_SIGNATURE)).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );

      await expect(
        addKeysFn(nor.connect(firstNOManager), secondNodeOperatorId, 0n, EMPTY_PUBLIC_KEY, EMPTY_SIGNATURE),
      ).to.be.revertedWith("APP_AUTH_FAILED");

      await expect(
        addKeysFn(nor.connect(secondNOManager), firstNodeOperatorId, 0n, EMPTY_PUBLIC_KEY, EMPTY_SIGNATURE),
      ).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Reverts if zero keys passed", async () => {
      await expect(
        addKeysFn(nor.connect(signingKeysManager), 0n, 0n, EMPTY_PUBLIC_KEY, EMPTY_SIGNATURE),
      ).to.be.revertedWith("OUT_OF_RANGE");

      await expect(
        addKeysFn(nor.connect(firstNOManager), firstNodeOperatorId, 0n, EMPTY_PUBLIC_KEY, EMPTY_SIGNATURE),
      ).to.be.revertedWith("OUT_OF_RANGE");

      await expect(
        addKeysFn(nor.connect(secondNOManager), secondNodeOperatorId, 0n, EMPTY_PUBLIC_KEY, EMPTY_SIGNATURE),
      ).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if keys length mismatch", async () => {
      await expect(
        addKeysFn(nor.connect(signingKeysManager), 0n, 2n, EMPTY_PUBLIC_KEY, EMPTY_SIGNATURE),
      ).to.be.revertedWith("LENGTH_MISMATCH");

      const keysCount = 3;
      const [publicKeys, signatures] = firstNOKeys.slice(0, keysCount);

      await expect(
        addKeysFn(nor.connect(signingKeysManager), 0n, keysCount + 1, publicKeys, signatures),
      ).to.be.revertedWith("LENGTH_MISMATCH");

      await expect(
        addKeysFn(nor.connect(signingKeysManager), 0n, keysCount - 1, publicKeys, signatures),
      ).to.be.revertedWith("LENGTH_MISMATCH");
    });

    it("Reverts if too many keys in total across node operators", async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[thirdNodeOperatorId])).to.equal(
        thirdNodeOperatorId,
      );

      const keysCount = 1;
      const [publicKeys, signatures] = thirdNOKeys.slice(0, keysCount);

      await expect(
        addKeysFn(nor.connect(signingKeysManager), thirdNodeOperatorId, keysCount, publicKeys, signatures),
      ).to.be.revertedWith("PACKED_OVERFLOW");
    });

    it("Reverts if too many keys passed for a single node operator", async () => {
      expect(await addNodeOperator(nor, nodeOperatorsManager, NODE_OPERATORS[thirdNodeOperatorId])).to.equal(
        thirdNodeOperatorId,
      );

      const keysCount = UINT64_MAX - NODE_OPERATORS[thirdNodeOperatorId].totalSigningKeysCount + 1n;
      const [publicKeys, signatures] = thirdNOKeys.slice(0, Number(keysCount));

      await expect(
        addKeysFn(nor.connect(signingKeysManager), thirdNodeOperatorId, keysCount, publicKeys, signatures),
      ).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if empty key passed", async () => {
      await expect(
        addKeysFn(nor.connect(signingKeysManager), 0n, 1n, EMPTY_PUBLIC_KEY, EMPTY_SIGNATURE),
      ).to.be.revertedWith("EMPTY_KEY");
    });

    it("Appends new unvetted yet keys to a node operator", async () => {
      const preFirstNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      const preSecondNOSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      const preFirstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const preSecondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);

      let keysCount = 5n;
      let [publicKeys, signatures] = firstNOKeys.slice(0, Number(keysCount));

      const nonce = await nor.getNonce();

      await expect(addKeysFn(nor.connect(firstNOManager), firstNodeOperatorId, keysCount, publicKeys, signatures))
        .to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount + keysCount)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n);

      keysCount = 3n;
      [publicKeys, signatures] = secondNOKeys.slice(0, Number(keysCount));

      await expect(addKeysFn(nor.connect(signingKeysManager), secondNodeOperatorId, keysCount, publicKeys, signatures))
        .to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(secondNodeOperatorId, NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount + keysCount)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n);

      const postFirstNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      const postSecondNOSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      const postFirstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const postSecondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);

      expect(preFirstNOInfo.length).to.equal(postFirstNOInfo.length);
      expect(preFirstNOSummary.length).to.equal(postFirstNOSummary.length);

      const totalAddedValidatorsIndex = 5;

      for (let i = 0; i < preFirstNOInfo.length; ++i) {
        if (i == totalAddedValidatorsIndex) continue;

        expect(preFirstNOInfo[i]).to.equal(postFirstNOInfo[i]);
        expect(preSecondNOInfo[i]).to.equal(postSecondNOInfo[i]);
      }

      expect(preFirstNOInfo[totalAddedValidatorsIndex]).to.equal(postFirstNOInfo[totalAddedValidatorsIndex] - 5n);
      expect(preSecondNOInfo[totalAddedValidatorsIndex]).to.equal(postSecondNOInfo[totalAddedValidatorsIndex] - 3n);

      expect(preFirstNOSummary.join()).to.equal(postFirstNOSummary.join());
      expect(preSecondNOSummary.join()).to.equal(postSecondNOSummary.join());
    });
  }

  context("addSigningKeys", () => {
    const func = async (
      nor_instance: NodeOperatorsRegistry__Harness,
      _nodeOperatorId: BigNumberish,
      _keysCount: BigNumberish,
      _publicKeys: BytesLike,
      _signatures: BytesLike,
    ) => {
      return nor_instance.addSigningKeys(_nodeOperatorId, _keysCount, _publicKeys, _signatures);
    };

    addSigningKeysCases(func);
  });

  context("addSigningKeysOperatorBH", () => {
    const funcBH = async (
      nor_instance: NodeOperatorsRegistry__Harness,
      _nodeOperatorId: BigNumberish,
      _keysCount: BigNumberish,
      _publicKeys: BytesLike,
      _signatures: BytesLike,
    ) => {
      return nor_instance.addSigningKeysOperatorBH(_nodeOperatorId, _keysCount, _publicKeys, _signatures);
    };

    addSigningKeysCases(funcBH);
  });

  function removeSigningKeysCases<TResult>(
    removeKeysFn: (
      nor_instance: NodeOperatorsRegistry__Harness,
      _nodeOperatorId: BigNumberish,
      _fromIndex: BigNumberish,
      _keysCount: BigNumberish,
    ) => TResult,
  ) {
    it("Reverts if no such an operator exists", async () => {
      await expect(removeKeysFn(nor, 5n, 0n, 0n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if has no management rights", async () => {
      await expect(removeKeysFn(nor.connect(stranger), 0n, 0n, 0n)).to.be.revertedWith("APP_AUTH_FAILED");

      await expect(removeKeysFn(nor.connect(nodeOperatorsManager), 0n, 0n, 0n)).to.be.revertedWith("APP_AUTH_FAILED");

      await expect(removeKeysFn(nor.connect(limitsManager), 0n, 0n, 0n)).to.be.revertedWith("APP_AUTH_FAILED");

      await expect(removeKeysFn(nor.connect(firstNOManager), secondNodeOperatorId, 0n, 0n)).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );

      await expect(removeKeysFn(nor.connect(secondNOManager), firstNodeOperatorId, 0n, 0n)).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );
    });

    it("Does nothing if zero keys passed", async () => {
      const preFirstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const preSecondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);
      const preNonce = await nor.getNonce();

      await expect(removeKeysFn(nor.connect(signingKeysManager), 0n, 0n, 0n))
        .to.not.emit(nor, "TotalSigningKeysCountChanged")
        .to.not.emit(nor, "KeysOpIndexSet")
        .to.not.emit(nor, "NonceChanged");

      await expect(removeKeysFn(nor.connect(firstNOManager), firstNodeOperatorId, 0n, 0n))
        .to.not.emit(nor, "TotalSigningKeysCountChanged")
        .to.not.emit(nor, "KeysOpIndexSet")
        .to.not.emit(nor, "NonceChanged");

      await expect(removeKeysFn(nor.connect(secondNOManager), secondNodeOperatorId, 0n, 0n))
        .to.not.emit(nor, "TotalSigningKeysCountChanged")
        .to.not.emit(nor, "KeysOpIndexSet")
        .to.not.emit(nor, "NonceChanged");

      const postFirstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const postSecondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);
      const postNonce = await nor.getNonce();

      expect(preFirstNOInfo.join()).to.equal(postFirstNOInfo.join());
      expect(preSecondNOInfo.join()).to.equal(postSecondNOInfo.join());
      expect(preNonce).to.equal(postNonce);
    });

    it("Reverts if invalid index passed", async () => {
      await expect(removeKeysFn(nor.connect(signingKeysManager), 0n, 20n, 1n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if invalid keys count passed", async () => {
      await expect(removeKeysFn(nor.connect(signingKeysManager), 0n, 0n, 10n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Decreases total keys count", async () => {
      const preFirstNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      const preSecondNOSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      const preFirstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const preSecondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);

      let keysCount = 2n;
      const nonce = await nor.getNonce();

      await expect(removeKeysFn(nor.connect(firstNOManager), firstNodeOperatorId, 6n, keysCount))
        .to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - keysCount)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.not.emit(nor, "VettedSigningKeysCountChanged");

      keysCount = 1n;

      await expect(removeKeysFn(nor.connect(signingKeysManager), secondNodeOperatorId, 10n, keysCount))
        .to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(secondNodeOperatorId, NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount - keysCount)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.not.emit(nor, "VettedSigningKeysCountChanged");

      const postFirstNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      const postSecondNOSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      const postFirstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const postSecondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);

      expect(preFirstNOInfo.length).to.equal(postFirstNOInfo.length);
      expect(preFirstNOSummary.length).to.equal(postFirstNOSummary.length);

      for (let i = 0; i < preFirstNOInfo.length; ++i) {
        if (i == 5) continue; // i==5 for totalAddedValidators

        expect(preFirstNOInfo[i]).to.equal(postFirstNOInfo[i]);
        expect(preSecondNOInfo[i]).to.equal(postSecondNOInfo[i]);
      }
      // i==5 for totalAddedValidators
      expect(preFirstNOInfo[5]).to.equal(postFirstNOInfo[5] + 2n);
      expect(preSecondNOInfo[5]).to.equal(postSecondNOInfo[5] + 1n);

      for (let i = 0; i < preFirstNOSummary.length; ++i) {
        expect(preFirstNOSummary[i]).to.equal(postFirstNOSummary[i]);
        expect(preSecondNOSummary[i]).to.equal(postSecondNOSummary[i]);
      }
    });

    it("May change unvetted keys count", async () => {
      const preFirstNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      const preSecondNOSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      const preFirstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const preSecondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);

      let keysCount = 3n;
      const nonce = await nor.getNonce();

      await expect(removeKeysFn(nor.connect(firstNOManager), firstNodeOperatorId, 5n, keysCount))
        .to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - keysCount)
        .to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, 5n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n);

      keysCount = 5n;

      await expect(removeKeysFn(nor.connect(signingKeysManager), secondNodeOperatorId, 7n, keysCount))
        .to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(secondNodeOperatorId, NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount - keysCount)
        .to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(secondNodeOperatorId, 7n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n);

      const postFirstNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      const postSecondNOSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      const postFirstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const postSecondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);

      expect(preFirstNOInfo.length).to.equal(postFirstNOInfo.length);
      expect(preFirstNOSummary.length).to.equal(postFirstNOSummary.length);

      const totalVettedValidatorsIndex = 3;
      const totalAddedValidatorsIndex = 5;

      for (let i = 0; i < preFirstNOInfo.length; ++i) {
        if (i == totalVettedValidatorsIndex) continue;
        if (i == totalAddedValidatorsIndex) continue;

        expect(preFirstNOInfo[i]).to.equal(postFirstNOInfo[i]);
        expect(preSecondNOInfo[i]).to.equal(postSecondNOInfo[i]);
      }

      expect(preFirstNOInfo[totalVettedValidatorsIndex]).to.equal(postFirstNOInfo[totalVettedValidatorsIndex] + 1n);
      expect(preSecondNOInfo[totalVettedValidatorsIndex]).to.equal(postSecondNOInfo[totalVettedValidatorsIndex] + 3n);

      expect(preFirstNOInfo[totalAddedValidatorsIndex]).to.equal(postFirstNOInfo[totalAddedValidatorsIndex] + 3n);
      expect(preSecondNOInfo[totalAddedValidatorsIndex]).to.equal(postSecondNOInfo[totalAddedValidatorsIndex] + 5n);

      const depositableValidatorsCountIndex = 7;

      for (let i = 0; i < preFirstNOSummary.length; ++i) {
        if (i == depositableValidatorsCountIndex) continue;

        expect(preFirstNOSummary[i]).to.equal(postFirstNOSummary[i]);
        expect(preSecondNOSummary[i]).to.equal(postSecondNOSummary[i]);
      }

      expect(preFirstNOSummary[depositableValidatorsCountIndex]).to.equal(
        postFirstNOSummary[depositableValidatorsCountIndex] + 1n,
      );
      expect(preSecondNOSummary[depositableValidatorsCountIndex]).to.equal(
        postSecondNOSummary[depositableValidatorsCountIndex] + 3n,
      );
    });
  }

  function removeSigningKeyCases<TResult>(
    removeKeyFn: (
      nor_instance: NodeOperatorsRegistry__Harness,
      _nodeOperatorId: BigNumberish,
      _fromIndex: BigNumberish,
    ) => TResult,
  ) {
    it("Reverts if no such an operator exists", async () => {
      await expect(removeKeyFn(nor, 5n, 0n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if has no management rights", async () => {
      await expect(removeKeyFn(nor.connect(stranger), 0n, 0n)).to.be.revertedWith("APP_AUTH_FAILED");

      await expect(removeKeyFn(nor.connect(nodeOperatorsManager), 0n, 0n)).to.be.revertedWith("APP_AUTH_FAILED");

      await expect(removeKeyFn(nor.connect(limitsManager), 0n, 0n)).to.be.revertedWith("APP_AUTH_FAILED");

      await expect(removeKeyFn(nor.connect(firstNOManager), secondNodeOperatorId, 0n)).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );

      await expect(removeKeyFn(nor.connect(secondNOManager), firstNodeOperatorId, 0n)).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );
    });

    it("Reverts if invalid index passed", async () => {
      await expect(removeKeyFn(nor.connect(signingKeysManager), 0n, 20n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Decreases total keys count", async () => {
      const preFirstNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      const preSecondNOSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      const preFirstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const preSecondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);

      const nonce = await nor.getNonce();

      await expect(removeKeyFn(nor.connect(firstNOManager), firstNodeOperatorId, 6n))
        .to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - 1n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n)
        .to.not.emit(nor, "VettedSigningKeysCountChanged");

      await expect(removeKeyFn(nor.connect(signingKeysManager), secondNodeOperatorId, 10n))
        .to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(secondNodeOperatorId, NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount - 1n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n)
        .to.not.emit(nor, "VettedSigningKeysCountChanged");

      const postFirstNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      const postSecondNOSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      const postFirstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const postSecondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);

      expect(preFirstNOInfo.length).to.equal(postFirstNOInfo.length);
      expect(preFirstNOSummary.length).to.equal(postFirstNOSummary.length);

      for (let i = 0; i < preFirstNOInfo.length; ++i) {
        if (i == 5) continue; // i==5 for totalAddedValidators

        expect(preFirstNOInfo[i]).to.equal(postFirstNOInfo[i]);
        expect(preSecondNOInfo[i]).to.equal(postSecondNOInfo[i]);
      }
      // i==5 for totalAddedValidators
      expect(preFirstNOInfo[5]).to.equal(postFirstNOInfo[5] + 1n);
      expect(preSecondNOInfo[5]).to.equal(postSecondNOInfo[5] + 1n);

      for (let i = 0; i < preFirstNOSummary.length; ++i) {
        expect(preFirstNOSummary[i]).to.equal(postFirstNOSummary[i]);
        expect(preSecondNOSummary[i]).to.equal(postSecondNOSummary[i]);
      }
    });

    it("May change unvetted keys count", async () => {
      const preFirstNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      const preSecondNOSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      const preFirstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const preSecondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);

      const nonce = await nor.getNonce();

      await expect(removeKeyFn(nor.connect(firstNOManager), firstNodeOperatorId, 5n))
        .to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - 1n)
        .to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(firstNodeOperatorId, 5n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 1n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 1n);

      await expect(removeKeyFn(nor.connect(signingKeysManager), secondNodeOperatorId, 7n))
        .to.emit(nor, "TotalSigningKeysCountChanged")
        .withArgs(secondNodeOperatorId, NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount - 1n)
        .to.emit(nor, "VettedSigningKeysCountChanged")
        .withArgs(secondNodeOperatorId, 7n)
        .to.emit(nor, "KeysOpIndexSet")
        .withArgs(nonce + 2n)
        .to.emit(nor, "NonceChanged")
        .withArgs(nonce + 2n);

      const postFirstNOSummary = await nor.getNodeOperatorSummary(firstNodeOperatorId);
      const postSecondNOSummary = await nor.getNodeOperatorSummary(secondNodeOperatorId);
      const postFirstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const postSecondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);

      expect(preFirstNOInfo.length).to.equal(postFirstNOInfo.length);
      expect(preFirstNOSummary.length).to.equal(postFirstNOSummary.length);

      const totalVettedValidatorsIndex = 3;
      const totalAddedValidatorsIndex = 5;

      for (let i = 0; i < preFirstNOInfo.length; ++i) {
        if (i == totalVettedValidatorsIndex) continue;
        if (i == totalAddedValidatorsIndex) continue;

        expect(preFirstNOInfo[i]).to.equal(postFirstNOInfo[i]);
        expect(preSecondNOInfo[i]).to.equal(postSecondNOInfo[i]);
      }

      expect(preFirstNOInfo[totalVettedValidatorsIndex]).to.equal(postFirstNOInfo[totalVettedValidatorsIndex] + 1n);
      expect(preSecondNOInfo[totalVettedValidatorsIndex]).to.equal(postSecondNOInfo[totalVettedValidatorsIndex] + 3n);

      expect(preFirstNOInfo[totalAddedValidatorsIndex]).to.equal(postFirstNOInfo[totalAddedValidatorsIndex] + 1n);
      expect(preSecondNOInfo[totalAddedValidatorsIndex]).to.equal(postSecondNOInfo[totalAddedValidatorsIndex] + 1n);

      const depositableValidatorsCountIndex = 7;

      for (let i = 0; i < preFirstNOSummary.length; ++i) {
        if (i == depositableValidatorsCountIndex) continue;

        expect(preFirstNOSummary[i]).to.equal(postFirstNOSummary[i]);
        expect(preSecondNOSummary[i]).to.equal(postSecondNOSummary[i]);
      }

      expect(preFirstNOSummary[depositableValidatorsCountIndex]).to.equal(
        postFirstNOSummary[depositableValidatorsCountIndex] + 1n,
      );
      expect(preSecondNOSummary[depositableValidatorsCountIndex]).to.equal(
        postSecondNOSummary[depositableValidatorsCountIndex] + 3n,
      );
    });
  }

  context("removeSigningKey", () => {
    const funcOneKey = async (
      nor_instance: NodeOperatorsRegistry__Harness,
      _nodeOperatorId: BigNumberish,
      _fromIndex: BigNumberish,
    ) => {
      return nor_instance.removeSigningKey(_nodeOperatorId, _fromIndex);
    };

    removeSigningKeyCases(funcOneKey);
  });

  context("removeSigningKeys", () => {
    const func = async (
      nor_instance: NodeOperatorsRegistry__Harness,
      _nodeOperatorId: BigNumberish,
      _fromIndex: BigNumberish,
      _keysCount: BigNumberish,
    ) => {
      return nor_instance.removeSigningKeys(_nodeOperatorId, _fromIndex, _keysCount);
    };

    removeSigningKeysCases(func);
  });

  context("removeSigningKeyOperatorBH", () => {
    const funcOneKeyBH = async (
      nor_instance: NodeOperatorsRegistry__Harness,
      _nodeOperatorId: BigNumberish,
      _fromIndex: BigNumberish,
    ) => {
      return nor_instance.removeSigningKeyOperatorBH(_nodeOperatorId, _fromIndex);
    };

    removeSigningKeyCases(funcOneKeyBH);
  });

  context("removeSigningKeysOperatorBH", () => {
    const funcBH = async (
      nor_instance: NodeOperatorsRegistry__Harness,
      _nodeOperatorId: BigNumberish,
      _fromIndex: BigNumberish,
      _keysCount: BigNumberish,
    ) => {
      return nor_instance.removeSigningKeysOperatorBH(_nodeOperatorId, _fromIndex, _keysCount);
    };

    removeSigningKeysCases(funcBH);
  });

  context("getTotalSigningKeyCount", () => {
    it("Reverts if no such an operator exists", async () => {
      await expect(nor.getTotalSigningKeyCount(3n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Returns the correct number of total keys NO has", async () => {
      const firstNOCount = await nor.getTotalSigningKeyCount(firstNodeOperatorId);
      const secondNOCount = await nor.getTotalSigningKeyCount(secondNodeOperatorId);

      const firstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const secondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);

      expect(firstNOCount).to.equal(firstNOInfo.totalAddedValidators);
      expect(secondNOCount).to.equal(secondNOInfo.totalAddedValidators);

      const keysCountToAdd = 2n;
      let [publicKeys, signatures] = firstNOKeys.slice(0, Number(keysCountToAdd));
      await nor.connect(signingKeysManager).addSigningKeys(firstNodeOperatorId, keysCountToAdd, publicKeys, signatures);
      [publicKeys, signatures] = secondNOKeys.slice(0, Number(keysCountToAdd));
      await nor
        .connect(signingKeysManager)
        .addSigningKeys(secondNodeOperatorId, keysCountToAdd, publicKeys, signatures);

      expect(await nor.getTotalSigningKeyCount(firstNodeOperatorId)).to.equal(firstNOCount + keysCountToAdd);
      expect(await nor.getTotalSigningKeyCount(secondNodeOperatorId)).to.equal(secondNOCount + keysCountToAdd);

      const keysCountToRemove = 3n;
      await nor
        .connect(signingKeysManager)
        .removeSigningKeys(firstNodeOperatorId, firstNOCount - 1n, keysCountToRemove);
      await nor
        .connect(signingKeysManager)
        .removeSigningKeys(secondNodeOperatorId, secondNOCount - 1n, keysCountToRemove);
      expect(await nor.getTotalSigningKeyCount(firstNodeOperatorId)).to.equal(
        firstNOCount + keysCountToAdd - keysCountToRemove,
      );
      expect(await nor.getTotalSigningKeyCount(secondNodeOperatorId)).to.equal(
        secondNOCount + keysCountToAdd - keysCountToRemove,
      );
    });
  });

  context("getUnusedSigningKeyCount", () => {
    it("Reverts if no such an operator exists", async () => {
      await expect(nor.getUnusedSigningKeyCount(3n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Returns the correct number of total keys NO has", async () => {
      const firstNOCount = await nor.getUnusedSigningKeyCount(firstNodeOperatorId);
      const secondNOCount = await nor.getUnusedSigningKeyCount(secondNodeOperatorId);

      const firstNOInfo = await nor.getNodeOperator(firstNodeOperatorId, true);
      const secondNOInfo = await nor.getNodeOperator(secondNodeOperatorId, true);

      expect(firstNOCount).to.equal(firstNOInfo.totalAddedValidators - firstNOInfo.totalDepositedValidators);
      expect(secondNOCount).to.equal(secondNOInfo.totalAddedValidators - secondNOInfo.totalDepositedValidators);

      const keysCountToAdd = 2n;
      let [publicKeys, signatures] = firstNOKeys.slice(0, Number(keysCountToAdd));
      await nor.connect(signingKeysManager).addSigningKeys(firstNodeOperatorId, keysCountToAdd, publicKeys, signatures);
      [publicKeys, signatures] = secondNOKeys.slice(0, Number(keysCountToAdd));
      await nor
        .connect(signingKeysManager)
        .addSigningKeys(secondNodeOperatorId, keysCountToAdd, publicKeys, signatures);

      expect(await nor.getUnusedSigningKeyCount(firstNodeOperatorId)).to.equal(firstNOCount + keysCountToAdd);
      expect(await nor.getUnusedSigningKeyCount(secondNodeOperatorId)).to.equal(secondNOCount + keysCountToAdd);

      const keysCountToRemove = 3n;
      await nor
        .connect(signingKeysManager)
        .removeSigningKeys(firstNodeOperatorId, firstNOInfo.totalAddedValidators - 1n, keysCountToRemove);
      await nor
        .connect(signingKeysManager)
        .removeSigningKeys(secondNodeOperatorId, secondNOInfo.totalAddedValidators - 1n, keysCountToRemove);
      expect(await nor.getUnusedSigningKeyCount(firstNodeOperatorId)).to.equal(
        firstNOCount + keysCountToAdd - keysCountToRemove,
      );
      expect(await nor.getUnusedSigningKeyCount(secondNodeOperatorId)).to.equal(
        secondNOCount + keysCountToAdd - keysCountToRemove,
      );
    });
  });

  context("getSigningKey", () => {
    const thirdNOKeysCount = 30;
    const thirdNOKeysDeposited = 12;
    const [thirdNOPublicKeys, thirdNOSignatures] = thirdNOKeys.slice(0, thirdNOKeysCount);

    beforeEach(async () => {
      await nor.connect(nodeOperatorsManager).addNodeOperator("node-operator-3", randomAddress());
      expect(await nor.getNodeOperatorsCount()).to.equal(3n);

      await nor
        .connect(signingKeysManager)
        .addSigningKeys(thirdNodeOperatorId, thirdNOKeysCount, thirdNOPublicKeys, thirdNOSignatures);
      await nor.connect(limitsManager).setNodeOperatorStakingLimit(thirdNodeOperatorId, thirdNOKeysCount);
      await nor.harness__setDepositedSigningKeysCount(thirdNodeOperatorId, thirdNOKeysDeposited);
    });

    it("Reverts if no such an operator exists", async () => {
      await expect(nor.getSigningKey(3n, 0n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if no keys added yet for the node operator", async () => {
      await nor.connect(nodeOperatorsManager).addNodeOperator("node-operator-4", randomAddress());
      expect(await nor.getNodeOperatorsCount()).to.equal(4n);

      await expect(nor.getSigningKey(3n, 0n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if invalid index requested", async () => {
      await expect(
        nor.getSigningKey(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount),
      ).to.be.revertedWith("OUT_OF_RANGE");
      await expect(
        nor.getSigningKey(secondNodeOperatorId, NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount),
      ).to.be.revertedWith("OUT_OF_RANGE");

      await expect(nor.getSigningKey(thirdNodeOperatorId, thirdNOKeysCount)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Can retrieve a deposited key (in use)", async () => {
      for (let i = 0n; i < NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount; ++i) {
        const [key, signature, used] = await nor.getSigningKey(firstNodeOperatorId, i);
        expect(key).to.equal(EMPTY_PUBLIC_KEY);
        expect(signature).to.equal(EMPTY_SIGNATURE);
        expect(used).to.be.true;
      }

      for (let i = 0n; i < NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount; ++i) {
        const [key, signature, used] = await nor.getSigningKey(secondNodeOperatorId, i);
        expect(key).to.equal(EMPTY_PUBLIC_KEY);
        expect(signature).to.equal(EMPTY_SIGNATURE);
        expect(used).to.be.true;
      }

      for (let i = 0n; i < thirdNOKeysDeposited; ++i) {
        const [key, signature, used] = await nor.getSigningKey(thirdNodeOperatorId, i);
        const [expectedPublicKey, expectedSignature] = thirdNOKeys.get(Number(i));
        expect(key).to.equal(expectedPublicKey);
        expect(signature).to.equal(expectedSignature);
        expect(used).to.be.true;
      }
    });

    it("Can retrieve an unused key", async () => {
      for (
        let i = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount;
        i < NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount;
        ++i
      ) {
        const [key, signature, used] = await nor.getSigningKey(firstNodeOperatorId, i);
        expect(key).to.equal(EMPTY_PUBLIC_KEY);
        expect(signature).to.equal(EMPTY_SIGNATURE);
        expect(used).to.be.false;
      }

      for (
        let i = NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount;
        i < NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount;
        ++i
      ) {
        const [key, signature, used] = await nor.getSigningKey(secondNodeOperatorId, i);
        expect(key).to.equal(EMPTY_PUBLIC_KEY);
        expect(signature).to.equal(EMPTY_SIGNATURE);
        expect(used).to.be.false;
      }

      for (let i = thirdNOKeysDeposited; i < thirdNOKeysCount; ++i) {
        const [keys, signatures, used] = await nor.getSigningKey(thirdNodeOperatorId, i);
        expect(used).to.be.false;
        const [expectedPublicKey, expectedSignature] = thirdNOKeys.get(Number(i));
        expect(keys).to.equal(expectedPublicKey);
        expect(signatures).to.equal(expectedSignature);
      }
    });
  });

  context("getSigningKeys", () => {
    const thirdNOKeysCount = 25;
    const thirdNOKeysDeposited = 19;
    const [thirdNOPublicKeys, thirdNOSignatures] = thirdNOKeys.slice(0, thirdNOKeysCount);

    beforeEach(async () => {
      await nor.connect(nodeOperatorsManager).addNodeOperator("node-operator-3", randomAddress());
      expect(await nor.getNodeOperatorsCount()).to.equal(3n);

      await nor
        .connect(signingKeysManager)
        .addSigningKeys(thirdNodeOperatorId, thirdNOKeysCount, thirdNOPublicKeys, thirdNOSignatures);
      await nor.connect(limitsManager).setNodeOperatorStakingLimit(thirdNodeOperatorId, thirdNOKeysCount);
      await nor.harness__setDepositedSigningKeysCount(thirdNodeOperatorId, thirdNOKeysDeposited);
    });

    it("Reverts if no such an operator exists", async () => {
      await expect(nor.getSigningKeys(3n, 0n, 0n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Returns empty data is zero limit passed", async () => {
      await nor.connect(nodeOperatorsManager).addNodeOperator("node-operator-4", randomAddress());
      expect(await nor.getNodeOperatorsCount()).to.equal(4n);

      const [keys, signatures, used] = await nor.getSigningKeys(3n, 0n, 0n);

      expect(keys).to.equal("0x");
      expect(signatures).to.equal("0x");
      expect(used).to.be.empty;
    });

    it("Reverts if no keys added yet for the node operator", async () => {
      await nor.connect(nodeOperatorsManager).addNodeOperator("node-operator-4", randomAddress());
      expect(await nor.getNodeOperatorsCount()).to.equal(4n);

      await expect(nor.getSigningKeys(3n, 0n, 1n)).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if invalid offset requested", async () => {
      await expect(
        nor.getSigningKeys(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount, 1n),
      ).to.be.revertedWith("OUT_OF_RANGE");
      await expect(
        nor.getSigningKeys(secondNodeOperatorId, NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount, 1n),
      ).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Reverts if invalid limit requested", async () => {
      await expect(
        nor.getSigningKeys(firstNodeOperatorId, 0n, NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount + 1n),
      ).to.be.revertedWith("OUT_OF_RANGE");
      await expect(
        nor.getSigningKeys(secondNodeOperatorId, 0n, NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount + 1n),
      ).to.be.revertedWith("OUT_OF_RANGE");
    });

    it("Can retrieve all keys", async () => {
      {
        const [keys, signatures, used] = await nor.getSigningKeys(
          firstNodeOperatorId,
          0n,
          NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount,
        );

        for (let i = 0; i < NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount; ++i) {
          expect(used[i]).to.equal(i < NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount);
          const [key, sig] = unpackKeySig(keys, signatures, i);
          expect(key).to.equal(EMPTY_PUBLIC_KEY);
          expect(sig).to.equal(EMPTY_SIGNATURE);
        }
      }

      {
        const [keys, signatures, used] = await nor.getSigningKeys(
          secondNodeOperatorId,
          0n,
          NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount,
        );

        for (let i = 0; i < NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount; ++i) {
          expect(used[i]).to.equal(i < NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount);
          const [key, sig] = unpackKeySig(keys, signatures, i);
          expect(key).to.equal(EMPTY_PUBLIC_KEY);
          expect(sig).to.equal(EMPTY_SIGNATURE);
        }
      }

      {
        const [keys, signatures, used] = await nor.getSigningKeys(thirdNodeOperatorId, 0n, thirdNOKeysCount);

        for (let i = 0; i < thirdNOKeysCount; ++i) {
          expect(used[i]).to.equal(i < thirdNOKeysDeposited);
          const [key, sig] = unpackKeySig(keys, signatures, i);
          const [expectedKey, expectedSig] = thirdNOKeys.get(i);
          expect(key).to.equal(expectedKey);
          expect(sig).to.equal(expectedSig);
        }
      }
    });

    it("Can retrieve a subrange of keys", async () => {
      const [keys, signatures, used] = await nor.getSigningKeys(thirdNodeOperatorId, 5n, thirdNOKeysCount - 8);

      for (let i = 5; i < thirdNOKeysCount - 8; ++i) {
        expect(used[i - 5]).to.equal(i < thirdNOKeysDeposited);
        const [key, sig] = unpackKeySig(keys, signatures, i - 5);
        const [expectedKey, expectedSig] = thirdNOKeys.get(i);
        expect(key).to.equal(expectedKey);
        expect(sig).to.equal(expectedSig);
      }
    });
  });
});
