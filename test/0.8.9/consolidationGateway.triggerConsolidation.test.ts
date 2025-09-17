import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationGateway, WithdrawalVault__MockForCG } from "typechain-types";

import { advanceChainTime } from "lib/time";

import { Snapshot } from "test/suite";

import { deployLidoLocator, updateLidoLocatorImplementation } from "../deploy/locator";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
];

const ZERO_ADDRESS = ethers.ZeroAddress;

// Helper functions
const grantConsolidationRequestRole = async (
  consolidationGateway: ConsolidationGateway,
  account: HardhatEthersSigner,
) => {
  const role = await consolidationGateway.ADD_CONSOLIDATION_REQUEST_ROLE();
  await consolidationGateway.grantRole(role, account);
};

const grantLimitManagerRole = async (consolidationGateway: ConsolidationGateway, account: HardhatEthersSigner) => {
  const role = await consolidationGateway.CONSOLIDATION_LIMIT_MANAGER_ROLE();
  await consolidationGateway.grantRole(role, account);
};

const setConsolidationLimit = async (
  consolidationGateway: ConsolidationGateway,
  signer: HardhatEthersSigner,
  maxRequests: number,
  requestsPerFrame: number,
  frameDuration: number,
) => {
  return consolidationGateway
    .connect(signer)
    .setConsolidationRequestLimit(maxRequests, requestsPerFrame, frameDuration);
};

const expectLimitData = async (
  consolidationGateway: ConsolidationGateway,
  expectedMaxRequests: number,
  expectedPerFrame: number,
  expectedFrameDuration: number,
  expectedPrevLimit: number,
  expectedCurrentLimit: number | typeof ethers.MaxUint256,
) => {
  const data = await consolidationGateway.getConsolidationRequestLimitFullInfo();
  expect(data[0]).to.equal(expectedMaxRequests); // maxConsolidationRequestsLimit
  expect(data[1]).to.equal(expectedPerFrame); // consolidationsPerFrame
  expect(data[2]).to.equal(expectedFrameDuration); // frameDurationInSec
  expect(data[3]).to.equal(expectedPrevLimit); // prevConsolidationRequestsLimit
  expect(data[4]).to.equal(expectedCurrentLimit); // currentConsolidationRequestsLimit
};

describe("ConsolidationGateway.sol: triggerConsolidation", () => {
  let consolidationGateway: ConsolidationGateway;
  let withdrawalVault: WithdrawalVault__MockForCG;
  let admin: HardhatEthersSigner;
  let authorizedEntity: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalState: string;

  before(async () => {
    [admin, authorizedEntity, stranger] = await ethers.getSigners();

    const locator = await deployLidoLocator();
    const locatorAddr = await locator.getAddress();

    withdrawalVault = await ethers.deployContract("WithdrawalVault__MockForCG");

    await updateLidoLocatorImplementation(locatorAddr, {
      withdrawalVault: await withdrawalVault.getAddress(),
    });

    consolidationGateway = await ethers.deployContract("ConsolidationGateway", [
      admin,
      locatorAddr,
      100, // maxConsolidationRequestsLimit
      1, // consolidationsPerFrame
      48, // frameDurationInSec
    ]);

    await grantConsolidationRequestRole(consolidationGateway, authorizedEntity);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  it("should revert if caller does not have the ADD_CONSOLIDATION_REQUEST_ROLE", async () => {
    const role = await consolidationGateway.ADD_CONSOLIDATION_REQUEST_ROLE();

    await expect(
      consolidationGateway
        .connect(stranger)
        .triggerConsolidation([PUBKEYS[0]], [PUBKEYS[1]], ZERO_ADDRESS, { value: 2 }),
    ).to.be.revertedWithOZAccessControlError(stranger.address, role);
  });

  it("should revert with ZeroArgument error if msg.value == 0", async () => {
    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .triggerConsolidation([PUBKEYS[0]], [PUBKEYS[1]], ZERO_ADDRESS, { value: 0 }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "ZeroArgument")
      .withArgs("msg.value");
  });

  it("should revert with ZeroArgument error if sourcePubkeys count is zero", async () => {
    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .triggerConsolidation([], [PUBKEYS[1]], ZERO_ADDRESS, { value: 10 }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "ZeroArgument")
      .withArgs("sourcePubkeys");
  });

  it("should revert with ArraysLengthMismatch error if arrays have different lengths", async () => {
    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .triggerConsolidation([PUBKEYS[0]], [PUBKEYS[1], PUBKEYS[2]], ZERO_ADDRESS, { value: 10 }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "ArraysLengthMismatch")
      .withArgs(1, 2);
  });

  it("should revert if total fee value sent is insufficient to cover all provided consolidation requests", async () => {
    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .triggerConsolidation([PUBKEYS[0], PUBKEYS[1]], [PUBKEYS[1], PUBKEYS[2]], ZERO_ADDRESS, { value: 1 }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "InsufficientFee")
      .withArgs(2, 1);
  });

  it("should not allow to set limit without CONSOLIDATION_LIMIT_MANAGER_ROLE", async () => {
    const limitManagerRole = await consolidationGateway.CONSOLIDATION_LIMIT_MANAGER_ROLE();

    await expect(
      consolidationGateway.connect(stranger).setConsolidationRequestLimit(4, 1, 48),
    ).to.be.revertedWithOZAccessControlError(await stranger.getAddress(), limitManagerRole);
  });

  it("should set consolidation limit", async () => {
    await grantLimitManagerRole(consolidationGateway, authorizedEntity);

    const limitTx = await setConsolidationLimit(consolidationGateway, authorizedEntity, 4, 1, 48);
    await expect(limitTx).to.emit(consolidationGateway, "ConsolidationRequestsLimitSet").withArgs(4, 1, 48);
  });

  it("should trigger consolidation request", async () => {
    const sourcePubkeys = [PUBKEYS[0], PUBKEYS[1]];
    const targetPubkeys = [PUBKEYS[1], PUBKEYS[2]];

    const tx = await consolidationGateway
      .connect(authorizedEntity)
      .triggerConsolidation(sourcePubkeys, targetPubkeys, ZERO_ADDRESS, { value: 3 });

    // Check that the withdrawal vault was called with correct parameters
    await expect(tx).to.emit(withdrawalVault, "AddConsolidationRequestsCalled").withArgs(sourcePubkeys, targetPubkeys);
  });

  it("should check current consolidation limit", async () => {
    await expectLimitData(consolidationGateway, 100, 1, 48, 100, 100);

    const sourcePubkeys = [PUBKEYS[0], PUBKEYS[1]];
    const targetPubkeys = [PUBKEYS[1], PUBKEYS[2]];

    await consolidationGateway
      .connect(authorizedEntity)
      .triggerConsolidation(sourcePubkeys, targetPubkeys, ZERO_ADDRESS, { value: 3 });

    await expectLimitData(consolidationGateway, 100, 1, 48, 98, 98);

    await advanceChainTime(48n);

    await expectLimitData(consolidationGateway, 100, 1, 48, 98, 99);
  });

  it("should revert if limit doesn't cover requests count", async () => {
    await grantLimitManagerRole(consolidationGateway, authorizedEntity);
    await setConsolidationLimit(consolidationGateway, authorizedEntity, 2, 1, 48);

    const sourcePubkeys = [PUBKEYS[0], PUBKEYS[1], PUBKEYS[2]];
    const targetPubkeys = [PUBKEYS[1], PUBKEYS[2], PUBKEYS[0]];

    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .triggerConsolidation(sourcePubkeys, targetPubkeys, ZERO_ADDRESS, { value: 4 }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "ConsolidationRequestsLimitExceeded")
      .withArgs(3, 2);
  });

  it("should trigger consolidation request as limit is enough for processing all requests", async () => {
    await grantLimitManagerRole(consolidationGateway, authorizedEntity);
    await setConsolidationLimit(consolidationGateway, authorizedEntity, 3, 1, 48);

    const sourcePubkeys = [PUBKEYS[0], PUBKEYS[1], PUBKEYS[2]];
    const targetPubkeys = [PUBKEYS[1], PUBKEYS[2], PUBKEYS[0]];

    const tx = await consolidationGateway
      .connect(authorizedEntity)
      .triggerConsolidation(sourcePubkeys, targetPubkeys, ZERO_ADDRESS, { value: 4 });

    // Check that the withdrawal vault was called with correct parameters
    await expect(tx).to.emit(withdrawalVault, "AddConsolidationRequestsCalled").withArgs(sourcePubkeys, targetPubkeys);

    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .triggerConsolidation(sourcePubkeys, targetPubkeys, ZERO_ADDRESS, { value: 4 }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "ConsolidationRequestsLimitExceeded")
      .withArgs(3, 0);

    await advanceChainTime(48n * 3n);

    await expect(tx).to.emit(withdrawalVault, "AddConsolidationRequestsCalled").withArgs(sourcePubkeys, targetPubkeys);
  });

  it("should refund fee to recipient address", async () => {
    const prevBalance = await ethers.provider.getBalance(stranger);
    const sourcePubkeys = [PUBKEYS[0]];
    const targetPubkeys = [PUBKEYS[1]];

    await consolidationGateway
      .connect(authorizedEntity)
      .triggerConsolidation(sourcePubkeys, targetPubkeys, stranger, { value: 1 + 7 });

    const newBalance = await ethers.provider.getBalance(stranger);

    expect(newBalance).to.equal(prevBalance + 7n);
  });

  it("should refund fee to sender address when refundRecipient is zero", async () => {
    const SENDER_ADDR = authorizedEntity.address;
    const prevBalance = await ethers.provider.getBalance(SENDER_ADDR);

    const sourcePubkeys = [PUBKEYS[0]];
    const targetPubkeys = [PUBKEYS[1]];

    const tx = await consolidationGateway
      .connect(authorizedEntity)
      .triggerConsolidation(sourcePubkeys, targetPubkeys, ZERO_ADDRESS, { value: 1 + 7 });

    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

    const newBalance = await ethers.provider.getBalance(SENDER_ADDR);
    expect(newBalance).to.equal(prevBalance - gasUsed - 1n);
  });

  it("preserves eth balance when calling triggerConsolidation", async () => {
    const balanceBefore = await ethers.provider.getBalance(consolidationGateway);

    await consolidationGateway
      .connect(authorizedEntity)
      .triggerConsolidation([PUBKEYS[0]], [PUBKEYS[1]], ZERO_ADDRESS, { value: 2 });

    const balanceAfter = await ethers.provider.getBalance(consolidationGateway);
    expect(balanceAfter).to.equal(balanceBefore);
  });

  it("should not make refund if refund is zero", async () => {
    const recipientBalanceBefore = await ethers.provider.getBalance(stranger);

    await consolidationGateway
      .connect(authorizedEntity)
      .triggerConsolidation([PUBKEYS[0]], [PUBKEYS[1]], stranger, { value: 1 });

    const recipientBalanceAfter = await ethers.provider.getBalance(stranger);
    expect(recipientBalanceAfter).to.equal(recipientBalanceBefore);
  });

  it("should refund ETH if refund > 0", async () => {
    const recipientBalanceBefore = await ethers.provider.getBalance(stranger);

    await consolidationGateway
      .connect(authorizedEntity)
      .triggerConsolidation([PUBKEYS[0]], [PUBKEYS[1]], stranger, { value: 5 });

    const recipientBalanceAfter = await ethers.provider.getBalance(stranger);
    expect(recipientBalanceAfter).to.equal(recipientBalanceBefore + 4n); // 5 - 1 fee = 4 refund
  });

  it("should set maxConsolidationRequestsLimit to 0 and return currentConsolidationRequestsLimit as type(uint256).max", async () => {
    await grantLimitManagerRole(consolidationGateway, authorizedEntity);

    await setConsolidationLimit(consolidationGateway, authorizedEntity, 0, 0, 48);

    await expectLimitData(consolidationGateway, 0, 0, 48, 0, ethers.MaxUint256);
  });

  it("should allow unlimited consolidation requests when limit is 0", async () => {
    const sourcePubkeys = Array(10)
      .fill(0)
      .map((_, i) => PUBKEYS[i % 3]);
    const targetPubkeys = Array(10)
      .fill(0)
      .map((_, i) => PUBKEYS[(i + 1) % 3]);

    // Should not revert even with many requests when limit is 0 (unlimited)
    await consolidationGateway
      .connect(authorizedEntity)
      .triggerConsolidation(sourcePubkeys, targetPubkeys, ZERO_ADDRESS, { value: 15 });
  });

  it("should not allow to set consolidationsPerFrame bigger than maxConsolidationRequestsLimit", async () => {
    await grantLimitManagerRole(consolidationGateway, authorizedEntity);

    await expect(setConsolidationLimit(consolidationGateway, authorizedEntity, 0, 1, 48)).to.be.revertedWithCustomError(
      consolidationGateway,
      "TooLargeItemsPerFrame",
    );
  });
});
