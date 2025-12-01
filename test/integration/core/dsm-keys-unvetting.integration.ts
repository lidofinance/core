import { expect } from "chai";
import { ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { DepositSecurityModule } from "typechain-types";

import { BigIntMath, certainAddress, DSMUnvetMessage, ether, findEventsWithInterfaces, impersonate } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { setSingleGuardian } from "lib/protocol/helpers/dsm";
import {
  norSdvtAddNodeOperator,
  norSdvtAddOperatorKeys,
  norSdvtSetOperatorStakingLimit,
} from "lib/protocol/helpers/nor-sdvt";

import { Snapshot } from "test/suite";

// Just an arbitrary account for using in tests
const GUARDIAN_PRIVATE_KEY = "0x516b8a7d9290502f5661da81f0cf43893e3d19cb9aea3c426cfb36e8186e9c09";

describe("Integration: DSM keys unvetting", () => {
  let ctx: ProtocolContext;
  let stranger: HardhatEthersSigner;
  let dsm: DepositSecurityModule;

  let snapshot: string;
  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();
    dsm = ctx.contracts.depositSecurityModule;

    snapshot = await Snapshot.take();

    [stranger] = await ethers.getSigners();

    DSMUnvetMessage.setMessagePrefix(await dsm.UNVET_MESSAGE_PREFIX());
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot));

  it("Should allow owner to set max operators per unvetting", async () => {
    const owner = await dsm.getOwner();
    const ownerSigner = await impersonate(owner, ether("1"));

    // Check initial value
    const initialMaxOperators = await dsm.getMaxOperatorsPerUnvetting();

    // Should revert when stranger tries to set value
    await expect(dsm.connect(stranger).setMaxOperatorsPerUnvetting(1)).to.be.revertedWithCustomError(dsm, "NotAnOwner");

    // Owner should be able to set new value
    await dsm.connect(ownerSigner).setMaxOperatorsPerUnvetting(1);
    expect(await dsm.getMaxOperatorsPerUnvetting()).to.equal(1);

    // Reset to initial value
    await dsm.connect(ownerSigner).setMaxOperatorsPerUnvetting(initialMaxOperators);
  });

  it("Should revert when stranger tries to unvet keys without valid guardian signature", async () => {
    const stakingModuleId = 1;
    const operatorId = 0n;
    const blockNumber = await time.latestBlock();
    const blockHash = (await ethers.provider.getBlock(blockNumber))!.hash!;
    const nonce = await ctx.contracts.stakingRouter.getStakingModuleNonce(stakingModuleId);

    // Pack operator IDs into bytes (8 bytes per ID)
    const nodeOperatorIds = ethers.solidityPacked(["uint64"], [operatorId]);

    // Pack vetted signing keys counts into bytes (16 bytes per count)
    const vettedSigningKeysCounts = ethers.solidityPacked(["uint128"], [1]);

    // Create signature with non-guardian private key
    const nonGuardianPrivateKey = "0x" + "1".repeat(64);
    const unvetMessage = new DSMUnvetMessage(
      blockNumber,
      blockHash,
      stakingModuleId,
      Number(nonce),
      nodeOperatorIds,
      vettedSigningKeysCounts,
    );
    const sig = await unvetMessage.sign(nonGuardianPrivateKey);

    await expect(
      dsm
        .connect(stranger)
        .unvetSigningKeys(
          blockNumber,
          blockHash,
          stakingModuleId,
          nonce,
          nodeOperatorIds,
          vettedSigningKeysCounts,
          sig,
        ),
    ).to.be.revertedWithCustomError(dsm, "InvalidSignature");
  });

  it("Should allow stranger to unvet keys with valid guardian signature", async () => {
    const { nor } = ctx.contracts;

    // Create new guardian with known (arbitrary) private key
    const guardian = new ethers.Wallet(GUARDIAN_PRIVATE_KEY).address;

    // Set single guardian
    await setSingleGuardian(ctx, guardian);

    // Prepare unvet parameters
    const stakingModuleId = 1;
    const operatorId = 0n;
    const blockNumber = await time.latestBlock();
    const blockHash = (await ethers.provider.getBlock(blockNumber))!.hash!;
    const nonce = await ctx.contracts.stakingRouter.getStakingModuleNonce(stakingModuleId);

    // Get node operator state before unvetting
    const nodeOperatorBefore = await nor.getNodeOperator(operatorId, true);
    const totalVettedValidatorsBefore = nodeOperatorBefore.totalVettedValidators;
    const vettedSigningKeysCount = totalVettedValidatorsBefore - 2n;

    // Pack operator IDs into bytes (8 bytes per ID)
    const nodeOperatorIds = ethers.solidityPacked(["uint64"], [operatorId]);

    // Pack vetted signing keys counts into bytes (16 bytes per count)
    const vettedSigningKeysCounts = ethers.solidityPacked(["uint128"], [vettedSigningKeysCount]);

    // Generate valid guardian signature
    const unvetMessage = new DSMUnvetMessage(
      blockNumber,
      blockHash,
      stakingModuleId,
      Number(nonce),
      nodeOperatorIds,
      vettedSigningKeysCounts,
    );
    // Stranger should be able to unvet with valid guardian signature
    const sig = await unvetMessage.sign(GUARDIAN_PRIVATE_KEY);

    // Get node operator state before unvetting
    expect(totalVettedValidatorsBefore).to.be.not.equal(vettedSigningKeysCount);
    const totalVettedValidatorsAfter = BigIntMath.max(
      vettedSigningKeysCount,
      nodeOperatorBefore.totalDepositedValidators,
    );

    // Unvet signing keys
    const tx = await dsm
      .connect(stranger)
      .unvetSigningKeys(blockNumber, blockHash, stakingModuleId, nonce, nodeOperatorIds, vettedSigningKeysCounts, sig);

    // Check events
    const receipt = await tx.wait();
    const unvetEvents = findEventsWithInterfaces(receipt!, "VettedSigningKeysCountChanged", [nor.interface]);
    expect(unvetEvents.length).to.equal(1);
    expect(unvetEvents[0].args.nodeOperatorId).to.equal(operatorId);
    expect(unvetEvents[0].args.approvedValidatorsCount).to.equal(totalVettedValidatorsAfter);

    // Verify node operator state after unvetting
    const nodeOperatorAfter = await nor.getNodeOperator(operatorId, true);
    expect(nodeOperatorAfter.totalVettedValidators).to.equal(totalVettedValidatorsAfter);
  });

  it("Should allow guardian to unvet signing keys directly", async () => {
    const { nor } = ctx.contracts;

    // Create new guardian with known (arbitrary)private key
    const guardian = new ethers.Wallet(GUARDIAN_PRIVATE_KEY).address;
    const guardianSigner = await impersonate(guardian, ether("1"));

    // Set single guardian
    await setSingleGuardian(ctx, guardian);
    const operatorId = 0n;

    // Get node operator state before unvetting
    const nodeOperatorBefore = await nor.getNodeOperator(operatorId, true);
    const totalDepositedValidatorsBefore = nodeOperatorBefore.totalDepositedValidators;
    expect(totalDepositedValidatorsBefore).to.be.gte(1n);
    const totalVettedValidatorsBefore = nodeOperatorBefore.totalVettedValidators;

    // Prepare unvet parameters
    const stakingModuleId = 1;
    const vettedSigningKeysCount = totalVettedValidatorsBefore - 3n;
    const blockNumber = await time.latestBlock();
    const blockHash = (await ethers.provider.getBlock(blockNumber))!.hash!;
    const nonce = await ctx.contracts.stakingRouter.getStakingModuleNonce(stakingModuleId);

    // Get node operator state before unvetting
    const totalVettedValidatorsAfter = Math.max(
      Number(vettedSigningKeysCount),
      Number(nodeOperatorBefore.totalDepositedValidators),
    );
    expect(totalDepositedValidatorsBefore).to.be.gte(1n);

    // Pack operator IDs into bytes (8 bytes per ID)
    const nodeOperatorIds = ethers.solidityPacked(["uint64"], [operatorId]);

    // Pack vetted signing keys counts into bytes (16 bytes per count)
    const vettedSigningKeysCounts = ethers.solidityPacked(["uint128"], [vettedSigningKeysCount]);

    // Guardian should be able to unvet directly without signature
    const tx = await dsm
      .connect(guardianSigner)
      .unvetSigningKeys(blockNumber, blockHash, stakingModuleId, nonce, nodeOperatorIds, vettedSigningKeysCounts, {
        r: ZeroHash,
        vs: ZeroHash,
      });

    // Check events
    const receipt = await tx.wait();
    const unvetEvents = findEventsWithInterfaces(receipt!, "VettedSigningKeysCountChanged", [nor.interface]);
    expect(unvetEvents.length).to.equal(1);
    expect(unvetEvents[0].args.nodeOperatorId).to.equal(operatorId);
    expect(unvetEvents[0].args.approvedValidatorsCount).to.equal(totalVettedValidatorsAfter);

    // Verify node operator state after unvetting
    const nodeOperatorAfter = await nor.getNodeOperator(operatorId, true);
    expect(nodeOperatorAfter.totalDepositedValidators).to.equal(totalDepositedValidatorsBefore);
    expect(nodeOperatorAfter.totalVettedValidators).to.equal(totalVettedValidatorsAfter);
  });

  it("Should allow guardian to decrease vetted signing keys count", async () => {
    const { nor } = ctx.contracts;

    // Add node operator and signing keys
    const stakingModuleId = 1;
    const rewardAddress = certainAddress("rewardAddress");
    const operatorId = await norSdvtAddNodeOperator(ctx, ctx.contracts.nor, {
      name: "test",
      rewardAddress,
    });

    // Add signing keys
    await norSdvtAddOperatorKeys(ctx, ctx.contracts.nor, {
      operatorId,
      keysToAdd: 10n,
    });

    // Set staking limit to 8
    await norSdvtSetOperatorStakingLimit(ctx, ctx.contracts.nor, {
      operatorId,
      limit: 8n,
    });

    // Prepare unvet parameters
    const blockNumber = await time.latestBlock();
    const blockHash = (await ethers.provider.getBlock(blockNumber))!.hash!;
    const nonce = await ctx.contracts.stakingRouter.getStakingModuleNonce(stakingModuleId);

    // Pack operator IDs into bytes (8 bytes per ID)
    const nodeOperatorIds = ethers.solidityPacked(["uint64"], [operatorId]);

    // Pack vetted signing keys counts into bytes (16 bytes per count)
    const vettedSigningKeysCountsAfterUnvet = 3n;
    const vettedSigningKeysCounts = ethers.solidityPacked(["uint128"], [vettedSigningKeysCountsAfterUnvet]);

    // Set single guardian
    await setSingleGuardian(ctx, stranger.address);

    // Guardian should be able to unvet directly without signature
    const tx = await dsm
      .connect(stranger)
      .unvetSigningKeys(blockNumber, blockHash, stakingModuleId, nonce, nodeOperatorIds, vettedSigningKeysCounts, {
        r: ZeroHash,
        vs: ZeroHash,
      });

    // Check events
    const receipt = await tx.wait();
    const unvetEvents = findEventsWithInterfaces(receipt!, "VettedSigningKeysCountChanged", [nor.interface]);
    expect(unvetEvents.length).to.equal(1);
    expect(unvetEvents[0].args.nodeOperatorId).to.equal(operatorId);
    expect(unvetEvents[0].args.approvedValidatorsCount).to.equal(vettedSigningKeysCountsAfterUnvet);

    // Verify node operator state after unvetting
    const nodeOperatorAfterUnvetting = await nor.getNodeOperator(operatorId, true);
    expect(nodeOperatorAfterUnvetting.totalVettedValidators).to.equal(vettedSigningKeysCountsAfterUnvet);
  });
});
