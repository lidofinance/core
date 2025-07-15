import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { certainAddress, ether, impersonate } from "lib";
import { LoadedContract } from "lib/contract";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { randomPubkeys, randomSignatures } from "lib/protocol/helpers/staking-module";

import { Snapshot } from "test/suite";

const MAINNET_SDVT_ADDRESS = "0xaE7B191A31f627b4eB1d4DaC64eaB9976995b433".toLowerCase();

describe("Integration: Staking module", () => {
  let ctx: ProtocolContext;
  let stranger: HardhatEthersSigner;

  let snapshot: string;
  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();

    snapshot = await Snapshot.take();

    [stranger] = await ethers.getSigners();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot));

  async function getSdvtNoManagerSigner() {
    if (ctx.contracts.sdvt.address.toLowerCase() === MAINNET_SDVT_ADDRESS) {
      return await ctx.getSigner("easyTrack");
    }
    return await ctx.getSigner("agent");
  }

  async function testUpdateTargetValidatorsLimits(module: LoadedContract, addNodeOperatorSigner: HardhatEthersSigner) {
    const agentSigner = await ctx.getSigner("agent");
    const rewardAddress = certainAddress("rewardAddress");
    const operatorName = "new_node_operator";

    // Add node operator
    const operatorId = await module.getFunction("getNodeOperatorsCount")();
    await module.connect(addNodeOperatorSigner).getFunction("addNodeOperator")(operatorName, rewardAddress);

    // Verify initial state
    let summary = await module.getFunction("getNodeOperatorSummary")(operatorId);
    expect(summary.targetLimitMode).to.equal(0);
    expect(summary.targetValidatorsCount).to.equal(0);

    // Should revert when called by unauthorized account
    await expect(
      module.connect(stranger).getFunction("updateTargetValidatorsLimits(uint256,uint256,uint256)")(operatorId, 1, 10),
    ).to.be.revertedWith("APP_AUTH_FAILED");

    // Grant STAKING_ROUTER_ROLE to stranger
    await ctx.contracts.acl
      .connect(agentSigner)
      .grantPermission(
        await stranger.getAddress(),
        module.getAddress(),
        ethers.keccak256(ethers.toUtf8Bytes("STAKING_ROUTER_ROLE")),
      );

    // Should revert with invalid operator id
    await expect(
      module.connect(stranger).getFunction("updateTargetValidatorsLimits(uint256,uint256,uint256)")(
        operatorId + 1n,
        1,
        10,
      ),
    ).to.be.revertedWith("OUT_OF_RANGE");

    // Set target mode 1
    await module.connect(stranger).getFunction("updateTargetValidatorsLimits(uint256,uint256,uint256)")(
      operatorId,
      1,
      10,
    );
    summary = await module.getFunction("getNodeOperatorSummary")(operatorId);
    expect(summary.targetLimitMode).to.equal(1);
    expect(summary.targetValidatorsCount).to.equal(10);

    // Set target mode 2
    await module.connect(stranger).getFunction("updateTargetValidatorsLimits(uint256,uint256,uint256)")(
      operatorId,
      2,
      20,
    );
    summary = await module.getFunction("getNodeOperatorSummary")(operatorId);
    expect(summary.targetLimitMode).to.equal(2);
    expect(summary.targetValidatorsCount).to.equal(20);

    // Set target mode 3 (force mode)
    await module.connect(stranger).getFunction("updateTargetValidatorsLimits(uint256,uint256,uint256)")(
      operatorId,
      3,
      30,
    );
    summary = await module.getFunction("getNodeOperatorSummary")(operatorId);
    expect(summary.targetLimitMode).to.equal(3);
    expect(summary.targetValidatorsCount).to.equal(30);

    // Set target mode 0 (disabled)
    await module.connect(stranger).getFunction("updateTargetValidatorsLimits(uint256,uint256,uint256)")(
      operatorId,
      0,
      40,
    );
    summary = await module.getFunction("getNodeOperatorSummary")(operatorId);
    expect(summary.targetLimitMode).to.equal(0);
    expect(summary.targetValidatorsCount).to.equal(0); // Should always be 0 in disabled mode
  }

  async function testDecreaseVettedSigningKeysCount(
    module: LoadedContract,
    addNodeOperatorSigner: HardhatEthersSigner,
  ) {
    const agentSigner = await ctx.getSigner("agent");
    const rewardAddress = certainAddress("rewardAddress");
    const operatorName = "new_node_operator";

    function prepareIdsCountsPayload(ids: bigint[], counts: bigint[]) {
      return {
        operatorIds: ethers.solidityPacked(Array(ids.length).fill("uint64"), ids),
        keyCounts: ethers.solidityPacked(Array(counts.length).fill("uint128"), counts),
      };
    }

    // Add node operator
    const operatorId = await module.getFunction("getNodeOperatorsCount")();
    await module.connect(addNodeOperatorSigner).getFunction("addNodeOperator")(operatorName, rewardAddress);

    // Check operator reward address
    const operatorInfo = await module.getFunction("getNodeOperator")(operatorId, true);
    expect(operatorInfo.rewardAddress).to.equal(rewardAddress);

    // Add signing keys
    const keysCount = 10n;
    await module.connect(await impersonate(rewardAddress, ether("1"))).getFunction("addSigningKeys")(
      operatorId,
      keysCount,
      randomPubkeys(Number(keysCount)),
      randomSignatures(Number(keysCount)),
    );

    // Set initial staking limit
    await ctx.contracts.acl
      .connect(agentSigner)
      .grantPermission(
        stranger.address,
        module.getAddress(),
        ethers.keccak256(ethers.toUtf8Bytes("SET_NODE_OPERATOR_LIMIT_ROLE")),
      );

    await module.connect(stranger).getFunction("setNodeOperatorStakingLimit")(operatorId, 8);

    // Check initial state before unvetting
    const operatorBefore = await module.getFunction("getNodeOperator")(operatorId, true);
    expect(operatorBefore.totalAddedValidators).to.equal(keysCount);
    expect(operatorBefore.totalVettedValidators).to.equal(8n);

    // Prepare payload for decreasing vetted keys
    const { operatorIds, keyCounts } = prepareIdsCountsPayload([operatorId], [6n]);

    // Should revert when called by unauthorized account
    await expect(
      module.connect(stranger).getFunction("decreaseVettedSigningKeysCount")(operatorIds, keyCounts),
    ).to.be.revertedWith("APP_AUTH_FAILED");

    // Grant STAKING_ROUTER_ROLE to stranger
    await ctx.contracts.acl
      .connect(agentSigner)
      .grantPermission(
        stranger.address,
        module.getAddress(),
        ethers.keccak256(ethers.toUtf8Bytes("STAKING_ROUTER_ROLE")),
      );

    // Should revert with invalid operator id
    const { operatorIds: invalidOperatorId } = prepareIdsCountsPayload([operatorId + 1n], [6n]);
    await expect(
      module.connect(stranger).getFunction("decreaseVettedSigningKeysCount")(invalidOperatorId, keyCounts),
    ).to.be.revertedWith("OUT_OF_RANGE");

    // Should revert when trying to increase vetted keys count
    const { keyCounts: increasedKeyCounts } = prepareIdsCountsPayload([operatorId], [9n]);
    await expect(
      module.connect(stranger).getFunction("decreaseVettedSigningKeysCount")(operatorIds, increasedKeyCounts),
    ).to.be.revertedWith("VETTED_KEYS_COUNT_INCREASED");

    // Should revert when trying to set count higher than total
    const { keyCounts: tooHighKeyCounts } = prepareIdsCountsPayload([operatorId], [11n]);
    await expect(
      module.connect(stranger).getFunction("decreaseVettedSigningKeysCount")(operatorIds, tooHighKeyCounts),
    ).to.be.revertedWith("VETTED_KEYS_COUNT_INCREASED");

    // Decrease vetted keys count
    await module.connect(stranger).getFunction("decreaseVettedSigningKeysCount")(operatorIds, keyCounts);

    // Check node operator state after partial unvetting
    let nodeOperatorAfterPartialUnvetting = await module.getFunction("getNodeOperator")(operatorId, true);
    expect(nodeOperatorAfterPartialUnvetting.totalAddedValidators).to.equal(keysCount);
    expect(nodeOperatorAfterPartialUnvetting.totalVettedValidators).to.equal(6n);

    // Second attempt with same count should not change anything
    await module.connect(stranger).getFunction("decreaseVettedSigningKeysCount")(operatorIds, keyCounts);

    nodeOperatorAfterPartialUnvetting = await module.getFunction("getNodeOperator")(operatorId, true);
    expect(nodeOperatorAfterPartialUnvetting.totalAddedValidators).to.equal(keysCount);
    expect(nodeOperatorAfterPartialUnvetting.totalVettedValidators).to.equal(6n);

    // Decrease to zero
    const { keyCounts: zeroKeyCounts } = prepareIdsCountsPayload([operatorId], [0n]);
    await module.connect(stranger).getFunction("decreaseVettedSigningKeysCount")(operatorIds, zeroKeyCounts);

    // Check node operator state after unvetting
    const nodeOperatorAfterUnvetting = await module.getFunction("getNodeOperator")(operatorId, true);
    expect(nodeOperatorAfterUnvetting.totalAddedValidators).to.equal(keysCount);
    expect(nodeOperatorAfterUnvetting.totalVettedValidators).to.equal(0n);
  }

  it("should test NOR update target validators limits", async () => {
    await testUpdateTargetValidatorsLimits(
      ctx.contracts.nor as unknown as LoadedContract,
      await ctx.getSigner("agent"),
    );
  });

  it("should test NOR decrease vetted signing keys count", async () => {
    await testDecreaseVettedSigningKeysCount(
      ctx.contracts.nor as unknown as LoadedContract,
      await ctx.getSigner("agent"),
    );
  });

  it("should test SDVT update target validators limits", async () => {
    await testUpdateTargetValidatorsLimits(
      ctx.contracts.sdvt as unknown as LoadedContract,
      await getSdvtNoManagerSigner(),
    );
  });

  it("should test SDVT decrease vetted signing keys count", async () => {
    await testDecreaseVettedSigningKeysCount(
      ctx.contracts.sdvt as unknown as LoadedContract,
      await getSdvtNoManagerSigner(),
    );
  });
});
