import { expect } from "chai";
import { ethers } from "hardhat";

import { certainAddress, ether, findEventsWithInterfaces, impersonate } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { randomPubkeys, randomSignatures } from "lib/protocol/helpers/staking-module";

import { bailOnFailure, Snapshot } from "test/suite";

type NodeOperatorState = {
  active: boolean;
  name: string;
  rewardAddress: string;
  totalVettedValidators: bigint;
  totalExitedValidators: bigint;
  totalAddedValidators: bigint;
  totalDepositedValidators: bigint;
};

type NodeOperatorSummary = {
  targetLimitMode: bigint;
  targetValidatorsCount: bigint;
  stuckValidatorsCount: bigint;
  refundedValidatorsCount: bigint;
  stuckPenaltyEndTimestamp: bigint;
  totalExitedValidators: bigint;
  totalDepositedValidators: bigint;
  depositableValidatorsCount: bigint;
};

function verifyNodeOperatorStateChanges(
  nodeOperatorAfter: NodeOperatorState,
  nodeOperatorBefore: NodeOperatorState,
  expectedChanges: Partial<NodeOperatorState & { addedValidators: bigint }> = {},
) {
  expect(nodeOperatorAfter.totalExitedValidators).to.equal(nodeOperatorBefore.totalExitedValidators);
  expect(nodeOperatorAfter.totalAddedValidators).to.equal(
    nodeOperatorBefore.totalAddedValidators + (expectedChanges.addedValidators || 0n),
  );
  expect(nodeOperatorAfter.totalDepositedValidators).to.equal(nodeOperatorBefore.totalDepositedValidators);
  expect(nodeOperatorAfter.name).to.equal(nodeOperatorBefore.name);
  expect(nodeOperatorAfter.rewardAddress).to.equal(nodeOperatorBefore.rewardAddress);
  expect(nodeOperatorAfter.active).to.equal(expectedChanges.active ?? nodeOperatorBefore.active);
  if (expectedChanges.totalVettedValidators !== undefined) {
    expect(nodeOperatorAfter.totalVettedValidators).to.equal(expectedChanges.totalVettedValidators);
  } else {
    expect(nodeOperatorAfter.totalVettedValidators).to.equal(nodeOperatorBefore.totalVettedValidators);
  }
}

function verifyNodeOperatorSummaryStateChanges(
  summaryAfter: NodeOperatorSummary,
  summaryBefore: NodeOperatorSummary,
  expectedChanges: Partial<NodeOperatorSummary> = {},
) {
  expect(summaryAfter.targetLimitMode).to.equal(summaryBefore.targetLimitMode);
  expect(summaryAfter.targetValidatorsCount).to.equal(summaryBefore.targetValidatorsCount);
  expect(summaryAfter.stuckValidatorsCount).to.equal(summaryBefore.stuckValidatorsCount);
  expect(summaryAfter.refundedValidatorsCount).to.equal(summaryBefore.refundedValidatorsCount);
  expect(summaryAfter.stuckPenaltyEndTimestamp).to.equal(summaryBefore.stuckPenaltyEndTimestamp);
  expect(summaryAfter.totalExitedValidators).to.equal(summaryBefore.totalExitedValidators);
  expect(summaryAfter.totalDepositedValidators).to.equal(summaryBefore.totalDepositedValidators);
  if (expectedChanges.depositableValidatorsCount !== undefined) {
    expect(summaryAfter.depositableValidatorsCount).to.equal(expectedChanges.depositableValidatorsCount);
  } else {
    expect(summaryAfter.depositableValidatorsCount).to.equal(summaryBefore.depositableValidatorsCount);
  }
}

describe("Scenario: Node operators happy path", () => {
  let ctx: ProtocolContext;

  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    snapshot = await Snapshot.take();

    // Grant required roles
    const agentSigner = await ctx.getSigner("agent");

    await ctx.contracts.acl
      .connect(agentSigner)
      .grantPermission(
        await agentSigner.getAddress(),
        ctx.contracts.nor.getAddress(),
        ethers.keccak256(ethers.toUtf8Bytes("MANAGE_NODE_OPERATOR_ROLE")),
      );

    await ctx.contracts.acl
      .connect(agentSigner)
      .grantPermission(
        await agentSigner.getAddress(),
        ctx.contracts.nor.getAddress(),
        ethers.keccak256(ethers.toUtf8Bytes("SET_NODE_OPERATOR_LIMIT_ROLE")),
      );
  });

  beforeEach(bailOnFailure);

  after(async () => await Snapshot.restore(snapshot));

  it("Should allow adding a node operator", async () => {
    const { nor } = ctx.contracts;
    const agentSigner = await ctx.getSigner("agent");
    const rewardAddress = certainAddress("rewardAddress");
    const operatorName = "new_node_operator";

    // Get initial counts
    const nodeOperatorsCountBefore = await nor.getNodeOperatorsCount();
    const activeNodeOperatorsCountBefore = await nor.getActiveNodeOperatorsCount();

    // Add node operator
    const addTx = await nor.connect(agentSigner).addNodeOperator(operatorName, rewardAddress);

    // Get counts after adding operator
    const nodeOperatorsCountAfter = await nor.getNodeOperatorsCount();
    const activeNodeOperatorsCountAfter = await nor.getActiveNodeOperatorsCount();

    // Verify counts increased by 1
    expect(nodeOperatorsCountAfter).to.equal(nodeOperatorsCountBefore + 1n);
    expect(activeNodeOperatorsCountAfter).to.equal(activeNodeOperatorsCountBefore + 1n);

    // Get new operator ID
    const newOperatorId = nodeOperatorsCountBefore;

    // Verify operator details
    const operator = await nor.getNodeOperator(newOperatorId, true);
    expect(operator.active).to.be.true;
    expect(operator.name).to.equal(operatorName);
    expect(operator.rewardAddress).to.equal(rewardAddress);
    expect(operator.totalDepositedValidators).to.equal(0);
    expect(operator.totalExitedValidators).to.equal(0);
    expect(operator.totalAddedValidators).to.equal(0);
    expect(operator.totalVettedValidators).to.equal(0);

    // Verify operator summary
    const summary = await nor.getNodeOperatorSummary(newOperatorId);
    expect(summary.targetLimitMode).to.equal(0);
    expect(summary.targetValidatorsCount).to.equal(0);
    expect(summary.stuckValidatorsCount).to.equal(0);
    expect(summary.refundedValidatorsCount).to.equal(0);
    expect(summary.stuckPenaltyEndTimestamp).to.equal(0);
    expect(summary.totalExitedValidators).to.equal(0);
    expect(summary.totalDepositedValidators).to.equal(0);
    expect(summary.depositableValidatorsCount).to.equal(0);

    // Verify emitted event
    const addReceipt = await addTx.wait();
    const events = await findEventsWithInterfaces(addReceipt!, "NodeOperatorAdded", [nor.interface]);
    expect(events.length).to.equal(1);
    expect(events[0].args.nodeOperatorId).to.equal(newOperatorId);
    expect(events[0].args.name).to.equal(operatorName);
    expect(events[0].args.rewardAddress).to.equal(rewardAddress);
    expect(events[0].args.stakingLimit).to.equal(0);
  });

  it("Should allow adding signing keys to a node operator", async () => {
    const { nor } = ctx.contracts;
    const agentSigner = await ctx.getSigner("agent");
    const rewardAddress = certainAddress("rewardAddress");
    const operatorName = "new_node_operator";

    // Add node operator
    await nor.connect(agentSigner).addNodeOperator(operatorName, rewardAddress);
    const newOperatorId = (await nor.getNodeOperatorsCount()) - 1n;

    // Add signing keys to operator
    const keysCount = 13n;
    const pubkeys = randomPubkeys(Number(keysCount));
    const signatures = randomSignatures(Number(keysCount));

    // Get state before adding keys
    const nonceBefore = await nor.getKeysOpIndex();
    const totalSigningKeysCountBefore = await nor.getTotalSigningKeyCount(newOperatorId);
    const unusedSigningKeysCountBefore = await nor.getUnusedSigningKeyCount(newOperatorId);
    const nodeOperatorBefore = await nor.getNodeOperator(newOperatorId, true);
    const nodeOperatorSummaryBefore = await nor.getNodeOperatorSummary(newOperatorId);

    // Add signing keys
    const rewardAddressSigner = await impersonate(rewardAddress, ether("1"));
    const addKeysTx = await nor
      .connect(rewardAddressSigner)
      .addSigningKeysOperatorBH(newOperatorId, keysCount, pubkeys, signatures);

    // Get state after adding keys
    const nonceAfter = await nor.getKeysOpIndex();
    const totalSigningKeysCountAfter = await nor.getTotalSigningKeyCount(newOperatorId);
    const unusedSigningKeysCountAfter = await nor.getUnusedSigningKeyCount(newOperatorId);
    const nodeOperatorAfter = await nor.getNodeOperator(newOperatorId, true);
    const nodeOperatorSummaryAfter = await nor.getNodeOperatorSummary(newOperatorId);

    // Verify state changes
    expect(nonceAfter).to.not.equal(nonceBefore);
    expect(totalSigningKeysCountAfter).to.equal(totalSigningKeysCountBefore + keysCount);
    expect(unusedSigningKeysCountAfter).to.equal(unusedSigningKeysCountBefore + keysCount);

    verifyNodeOperatorStateChanges(nodeOperatorAfter, nodeOperatorBefore, { addedValidators: keysCount });
    verifyNodeOperatorSummaryStateChanges(nodeOperatorSummaryAfter, nodeOperatorSummaryBefore);

    // Verify each signing key was added correctly
    for (let i = 0; i < Number(keysCount); i++) {
      const globalKeyIndex = Number(totalSigningKeysCountBefore) + i;
      const signingKey = await nor.getSigningKey(newOperatorId, globalKeyIndex);

      expect(signingKey.key).to.equal("0x" + Buffer.from(pubkeys.slice(i * 48, (i + 1) * 48)).toString("hex"));
      expect(signingKey.depositSignature).to.equal(
        "0x" + Buffer.from(signatures.slice(i * 96, (i + 1) * 96)).toString("hex"),
      );
      expect(signingKey.used).to.be.false;
    }

    // Verify events
    await expect(addKeysTx)
      .to.emit(nor, "TotalSigningKeysCountChanged")
      .withArgs(newOperatorId, totalSigningKeysCountAfter);
    await expect(addKeysTx).to.emit(nor, "KeysOpIndexSet").withArgs(nonceAfter);
    await expect(addKeysTx).to.emit(nor, "NonceChanged").withArgs(nonceAfter);
  });

  it("Should allow setting staking limit for a node operator", async () => {
    const { nor } = ctx.contracts;
    const agentSigner = await ctx.getSigner("agent");
    const rewardAddress = certainAddress("rewardAddress");
    const operatorName = "new_node_operator";

    // Add node operator
    await nor.connect(agentSigner).addNodeOperator(operatorName, rewardAddress);
    const newOperatorId = (await nor.getNodeOperatorsCount()) - 1n;

    // Add signing keys
    const keysCount = 13n;
    const pubkeys = randomPubkeys(Number(keysCount));
    const signatures = randomSignatures(Number(keysCount));
    const rewardAddressSigner = await impersonate(rewardAddress, ether("1"));
    await nor.connect(rewardAddressSigner).addSigningKeysOperatorBH(newOperatorId, keysCount, pubkeys, signatures);

    // Get state before setting staking limit
    const nonceBefore = await nor.getKeysOpIndex();
    const nodeOperatorBefore = await nor.getNodeOperator(newOperatorId, true);
    const nodeOperatorSummaryBefore = await nor.getNodeOperatorSummary(newOperatorId);

    // Verify staking limit
    const newStakingLimit = await nor.getTotalSigningKeyCount(newOperatorId);
    expect(newStakingLimit).to.not.equal(nodeOperatorBefore.totalVettedValidators, "invalid new staking limit");

    // Set staking limit
    const stakingLimitTx = await nor.connect(agentSigner).setNodeOperatorStakingLimit(newOperatorId, newStakingLimit);

    // Get state after setting staking limit
    const nonceAfter = await nor.getKeysOpIndex();
    const nodeOperatorAfter = await nor.getNodeOperator(newOperatorId, true);
    const nodeOperatorSummaryAfter = await nor.getNodeOperatorSummary(newOperatorId);

    expect(nonceAfter).to.be.gt(nonceBefore, "nonce should be incremented after setting staking limit");
    verifyNodeOperatorStateChanges(nodeOperatorAfter, nodeOperatorBefore, { totalVettedValidators: newStakingLimit });
    verifyNodeOperatorSummaryStateChanges(nodeOperatorSummaryAfter, nodeOperatorSummaryBefore, {
      depositableValidatorsCount: newStakingLimit,
    });

    // Verify events
    await expect(stakingLimitTx).to.emit(nor, "VettedSigningKeysCountChanged").withArgs(newOperatorId, newStakingLimit);
    await expect(stakingLimitTx).to.emit(nor, "KeysOpIndexSet").withArgs(nonceAfter);
    await expect(stakingLimitTx).to.emit(nor, "NonceChanged").withArgs(nonceAfter);
  });

  it("Should allow deactivating a node operator", async () => {
    const { nor } = ctx.contracts;
    const agentSigner = await ctx.getSigner("agent");
    const rewardAddress = certainAddress("rewardAddress");
    const operatorName = "new_node_operator";

    // Add node operator
    await nor.connect(agentSigner).addNodeOperator(operatorName, rewardAddress);
    const newOperatorId = (await nor.getNodeOperatorsCount()) - 1n;

    // Add signing keys and set staking limit
    const keysCount = 13n;
    const pubkeys = randomPubkeys(Number(keysCount));
    const signatures = randomSignatures(Number(keysCount));
    const rewardAddressSigner = await impersonate(rewardAddress, ether("1"));
    await nor.connect(rewardAddressSigner).addSigningKeysOperatorBH(newOperatorId, keysCount, pubkeys, signatures);

    await nor.connect(agentSigner).setNodeOperatorStakingLimit(newOperatorId, keysCount);

    // Get state before deactivating operator
    const nodeOperatorsCountBefore = await nor.getNodeOperatorsCount();
    const activeNodeOperatorsCountBefore = await nor.getActiveNodeOperatorsCount();
    const nodeOperatorBefore = await nor.getNodeOperator(newOperatorId, true);
    const nodeOperatorSummaryBefore = await nor.getNodeOperatorSummary(newOperatorId);

    // Deactivate node operator
    const deactivateTx = await nor.connect(agentSigner).deactivateNodeOperator(newOperatorId);

    // Get state after deactivating operator
    const nodeOperatorsCountAfter = await nor.getNodeOperatorsCount();
    const activeNodeOperatorsCountAfter = await nor.getActiveNodeOperatorsCount();
    const nodeOperatorAfter = await nor.getNodeOperator(newOperatorId, true);
    const nodeOperatorSummaryAfter = await nor.getNodeOperatorSummary(newOperatorId);

    // Verify operator counts
    expect(nodeOperatorsCountAfter).to.equal(nodeOperatorsCountBefore);
    expect(activeNodeOperatorsCountAfter).to.equal(activeNodeOperatorsCountBefore - 1n);

    verifyNodeOperatorStateChanges(nodeOperatorAfter, nodeOperatorBefore, {
      active: false,
      totalVettedValidators: nodeOperatorBefore.totalDepositedValidators,
    });
    verifyNodeOperatorSummaryStateChanges(nodeOperatorSummaryAfter, nodeOperatorSummaryBefore, {
      depositableValidatorsCount: 0n,
    });

    // Verify events
    await expect(deactivateTx).to.emit(nor, "NodeOperatorActiveSet").withArgs(newOperatorId, false);

    const deactivateReceipt = await deactivateTx.wait();
    const deactivateEvents = await findEventsWithInterfaces(deactivateReceipt!, "NodeOperatorActiveSet", [
      nor.interface,
    ]);
    expect(deactivateEvents.length).to.equal(1);
    expect(deactivateEvents[0].args.nodeOperatorId).to.equal(newOperatorId);
    expect(deactivateEvents[0].args.active).to.be.false;
  });

  it("Should allow reactivating a node operator", async () => {
    const { nor } = ctx.contracts;
    const agentSigner = await ctx.getSigner("agent");
    const rewardAddress = certainAddress("rewardAddress");
    const operatorName = "new_node_operator";

    // Add node operator
    await nor.connect(agentSigner).addNodeOperator(operatorName, rewardAddress);
    const newOperatorId = (await nor.getNodeOperatorsCount()) - 1n;

    // Deactivate node operator
    await nor.connect(agentSigner).deactivateNodeOperator(newOperatorId);

    // Get state before activating operator
    const nodeOperatorBefore = await nor.getNodeOperator(newOperatorId, true);
    expect(nodeOperatorBefore.active).to.be.false;

    const nodeOperatorsCountBefore = await nor.getNodeOperatorsCount();
    const nodeOperatorSummaryBefore = await nor.getNodeOperatorSummary(newOperatorId);
    const activeNodeOperatorsCountBefore = await nor.getActiveNodeOperatorsCount();

    // Activate node operator
    const activateTx = await nor.connect(agentSigner).activateNodeOperator(newOperatorId);

    // Get state after activating operator
    const nodeOperatorsCountAfter = await nor.getNodeOperatorsCount();
    const nodeOperatorSummaryAfter = await nor.getNodeOperatorSummary(newOperatorId);
    const activeNodeOperatorsCountAfter = await nor.getActiveNodeOperatorsCount();

    // Verify operator counts
    expect(nodeOperatorsCountAfter).to.equal(nodeOperatorsCountBefore);
    expect(activeNodeOperatorsCountAfter).to.equal(activeNodeOperatorsCountBefore + 1n);

    // Verify node operator state changes
    const nodeOperatorAfter = await nor.getNodeOperator(newOperatorId, true);
    verifyNodeOperatorStateChanges(nodeOperatorAfter, nodeOperatorBefore, { active: true });
    verifyNodeOperatorSummaryStateChanges(nodeOperatorSummaryAfter, nodeOperatorSummaryBefore);

    // Verify events
    await expect(activateTx).to.emit(nor, "NodeOperatorActiveSet").withArgs(newOperatorId, true);

    const activateReceipt = await activateTx.wait();
    const activateEvents = await findEventsWithInterfaces(activateReceipt!, "NodeOperatorActiveSet", [nor.interface]);
    expect(activateEvents.length).to.equal(1);
    expect(activateEvents[0].args.nodeOperatorId).to.equal(newOperatorId);
    expect(activateEvents[0].args.active).to.be.true;
  });

  it("Should allow updating staking limit after reactivation", async () => {
    const { nor } = ctx.contracts;
    const agentSigner = await ctx.getSigner("agent");
    const rewardAddress = certainAddress("rewardAddress");
    const operatorName = "new_node_operator";

    // Add node operator
    await nor.connect(agentSigner).addNodeOperator(operatorName, rewardAddress);
    const newOperatorId = (await nor.getNodeOperatorsCount()) - 1n;

    // Add signing keys
    const keysCount = 13n;
    const pubkeys = randomPubkeys(Number(keysCount));
    const signatures = randomSignatures(Number(keysCount));
    const rewardAddressSigner = await impersonate(rewardAddress, ether("1"));
    await nor.connect(rewardAddressSigner).addSigningKeysOperatorBH(newOperatorId, keysCount, pubkeys, signatures);

    // Deactivate and reactivate node operator
    await nor.connect(agentSigner).deactivateNodeOperator(newOperatorId);
    await nor.connect(agentSigner).activateNodeOperator(newOperatorId);

    // Get state before setting staking limit
    const nonceBefore = await nor.getKeysOpIndex();
    const nodeOperatorBefore = await nor.getNodeOperator(newOperatorId, true);
    const nodeOperatorSummaryBefore = await nor.getNodeOperatorSummary(newOperatorId);

    // Set new staking limit equal to total signing keys
    const newStakingLimit = await nor.getTotalSigningKeyCount(newOperatorId);
    expect(newStakingLimit).to.not.equal(nodeOperatorBefore.totalVettedValidators, "Invalid new staking limit");

    // Set staking limit
    const setLimitTx = await nor.connect(agentSigner).setNodeOperatorStakingLimit(newOperatorId, newStakingLimit);

    // Get state after setting limit
    const nonceAfter = await nor.getKeysOpIndex();
    const nodeOperatorAfter = await nor.getNodeOperator(newOperatorId, true);
    const nodeOperatorSummaryAfter = await nor.getNodeOperatorSummary(newOperatorId);

    expect(nonceAfter).to.be.gt(nonceBefore, "nonce should be incremented after setting staking limit");
    verifyNodeOperatorStateChanges(nodeOperatorAfter, nodeOperatorBefore, { totalVettedValidators: newStakingLimit });
    verifyNodeOperatorSummaryStateChanges(nodeOperatorSummaryAfter, nodeOperatorSummaryBefore, {
      depositableValidatorsCount: newStakingLimit,
    });

    // Verify events
    const setLimitReceipt = await setLimitTx.wait();
    const setLimitEvents = await findEventsWithInterfaces(setLimitReceipt!, "VettedSigningKeysCountChanged", [
      nor.interface,
    ]);
    expect(setLimitEvents.length).to.equal(1);
    expect(setLimitEvents[0].args.nodeOperatorId).to.equal(newOperatorId);
    expect(setLimitEvents[0].args.approvedValidatorsCount).to.equal(newStakingLimit);
  });
});
