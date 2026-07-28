import { expect } from "chai";
import { BigNumberish, Contract, Wallet } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { DepositSecurityModule } from "typechain-types";

import { BigIntMath, certainAddress, DSMUnvetMessage, ether, findEventsWithInterfaces, impersonate } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { setSingleGuardian } from "lib/protocol/helpers/dsm";
import { deployDelegationContract } from "lib/protocol/helpers/edf";
import {
  norSdvtAddNodeOperator,
  norSdvtAddOperatorKeys,
  norSdvtSetOperatorStakingLimit,
} from "lib/protocol/helpers/nor-sdvt";

import { Snapshot } from "test/suite";

describe("Integration: DSM keys unvetting", () => {
  let ctx: ProtocolContext;
  let stranger: HardhatEthersSigner;
  let delegationOwner: HardhatEthersSigner;
  let delegate: HardhatEthersSigner;
  let dsm: DepositSecurityModule;

  let snapshot: string;
  let originalState: string;

  before(async function () {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    if (ctx.isMainnet) this.skip();
    dsm = ctx.contracts.depositSecurityModule;

    [stranger, delegationOwner, delegate] = await ethers.getSigners();

    DSMUnvetMessage.setMessagePrefix(await dsm.UNVET_MESSAGE_PREFIX());
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot));

  async function deployGuardian(delegateAddress: string) {
    const guardian = await deployDelegationContract(delegationOwner, delegateAddress);
    await setSingleGuardian(ctx, guardian.address);
    return guardian;
  }

  type UnvetCallArgs = readonly [BigNumberish, string, BigNumberish, BigNumberish, string, string];

  async function executeUnvet(guardian: Contract, caller: HardhatEthersSigner, args: UnvetCallArgs) {
    const data = dsm.interface.encodeFunctionData("unvetSigningKeys", [
      ...args,
      { guardian: ethers.ZeroAddress, signature: "0x" },
    ]);
    return await (guardian.connect(caller) as Contract).execute(await dsm.getAddress(), data);
  }

  it("Should allow owner to set max operators per unvetting", async () => {
    const owner = await dsm.getOwner();
    const ownerSigner = await impersonate(owner, ether("1"));

    // Check initial value
    const initialMaxOperators = await dsm.getMaxOperatorsPerUnvetting();

    // Should revert when stranger tries to set value
    await expect(dsm.connect(stranger).setMaxOperatorsPerUnvetting(1)).to.be.revertedWithCustomError(dsm, "NotAnOwner");

    // Owner should be able to set new value
    await (await dsm.connect(ownerSigner).setMaxOperatorsPerUnvetting(1)).wait();
    expect(await dsm.getMaxOperatorsPerUnvetting()).to.equal(1);

    // Reset to initial value
    await (await dsm.connect(ownerSigner).setMaxOperatorsPerUnvetting(initialMaxOperators)).wait();
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
    const nonGuardian = Wallet.createRandom();
    const unvetMessage = new DSMUnvetMessage(
      stranger.address,
      blockNumber,
      blockHash,
      stakingModuleId,
      Number(nonce),
      nodeOperatorIds,
      vettedSigningKeysCounts,
    );
    const sig = await unvetMessage.sign(nonGuardian.privateKey);

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
    const { nor, stakingRouter } = ctx.contracts;

    const guardianDelegate = Wallet.createRandom();

    // Set single guardian
    const guardian = await deployGuardian(guardianDelegate.address);

    // Prepare unvet parameters
    const stakingModuleId = 1;
    const operatorId = 0n;
    const blockNumber = await time.latestBlock();
    const blockHash = (await ethers.provider.getBlock(blockNumber))!.hash!;
    // Get node operator state before unvetting
    // eslint-disable-next-line prefer-const
    let { totalVettedValidators, totalDepositedValidators, totalAddedValidators } = await nor.getNodeOperator(
      operatorId,
      true,
    );

    // Add more keys if needed
    if (totalAddedValidators === totalDepositedValidators) {
      await norSdvtAddOperatorKeys(ctx, nor, { operatorId, keysToAdd: 2n });
      totalAddedValidators += 2n;
    }

    // Set more limit if needed
    if (totalVettedValidators === totalDepositedValidators) {
      await norSdvtSetOperatorStakingLimit(ctx, nor, { operatorId, limit: totalVettedValidators + 2n });
      totalVettedValidators += 2n;
    }

    const vettedSigningKeysCount = totalVettedValidators - 2n;

    // Pack operator IDs into bytes (8 bytes per ID)
    const nodeOperatorIds = ethers.solidityPacked(["uint64"], [operatorId]);

    // Pack vetted signing keys counts into bytes (16 bytes per count)
    const vettedSigningKeysCounts = ethers.solidityPacked(["uint128"], [vettedSigningKeysCount]);

    const nonce = await stakingRouter.getStakingModuleNonce(stakingModuleId);
    // Generate valid guardian signature
    const unvetMessage = new DSMUnvetMessage(
      guardian.address,
      blockNumber,
      blockHash,
      stakingModuleId,
      Number(nonce),
      nodeOperatorIds,
      vettedSigningKeysCounts,
    );
    // Stranger should be able to unvet with valid guardian signature
    const sig = await unvetMessage.sign(guardianDelegate.privateKey);

    // Get node operator state before unvetting
    expect(totalVettedValidators).to.be.not.equal(vettedSigningKeysCount);
    const totalVettedValidatorsAfter = BigIntMath.max(vettedSigningKeysCount, totalDepositedValidators);

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
    const { nor, stakingRouter } = ctx.contracts;

    // Create new guardian with known (arbitrary)private key
    const guardian = await deployGuardian(delegate.address);

    // Set single guardian
    const operatorId = 0n;

    // Get node operator state before unvetting
    // eslint-disable-next-line prefer-const
    let { totalDepositedValidators, totalVettedValidators, totalAddedValidators } = await nor.getNodeOperator(
      operatorId,
      true,
    );

    // Add more keys if needed
    if (totalAddedValidators === totalDepositedValidators) {
      await norSdvtAddOperatorKeys(ctx, nor, { operatorId, keysToAdd: 3n });
      totalAddedValidators += 3n;
    }

    // Set more limit if needed
    if (totalVettedValidators === totalDepositedValidators) {
      await norSdvtSetOperatorStakingLimit(ctx, nor, { operatorId, limit: totalVettedValidators + 3n });
      totalVettedValidators += 3n;
    }

    // Prepare unvet parameters
    const stakingModuleId = 1;
    const vettedSigningKeysCount = totalVettedValidators - 3n;
    const blockNumber = await time.latestBlock();
    const blockHash = (await ethers.provider.getBlock(blockNumber))!.hash!;
    const nonce = await stakingRouter.getStakingModuleNonce(stakingModuleId);

    // Get node operator state before unvetting
    const totalVettedValidatorsAfter = Math.max(Number(vettedSigningKeysCount), Number(totalDepositedValidators));

    // Pack operator IDs into bytes (8 bytes per ID)
    const nodeOperatorIds = ethers.solidityPacked(["uint64"], [operatorId]);

    // Pack vetted signing keys counts into bytes (16 bytes per count)
    const vettedSigningKeysCounts = ethers.solidityPacked(["uint128"], [vettedSigningKeysCount]);

    // Guardian should be able to unvet directly without signature
    const tx = await executeUnvet(guardian.contract, delegate, [
      blockNumber,
      blockHash,
      stakingModuleId,
      nonce,
      nodeOperatorIds,
      vettedSigningKeysCounts,
    ]);
    const receipt = await tx.wait();
    if (!receipt) throw new Error("DSM unvet transaction has no receipt");

    const unvetEvents = findEventsWithInterfaces(receipt, "VettedSigningKeysCountChanged", [nor.interface]);
    expect(unvetEvents).to.have.length(1);
    expect(unvetEvents[0].args.nodeOperatorId).to.equal(operatorId);
    expect(unvetEvents[0].args.approvedValidatorsCount).to.equal(totalVettedValidatorsAfter);

    // Verify node operator state after unvetting
    const nodeOperatorAfter = await nor.getNodeOperator(operatorId, true);
    expect(nodeOperatorAfter.totalDepositedValidators).to.equal(totalDepositedValidators);
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
    const guardian = await deployGuardian(stranger.address);

    // Guardian should be able to unvet directly without signature
    const tx = await executeUnvet(guardian.contract, stranger, [
      blockNumber,
      blockHash,
      stakingModuleId,
      nonce,
      nodeOperatorIds,
      vettedSigningKeysCounts,
    ]);

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
