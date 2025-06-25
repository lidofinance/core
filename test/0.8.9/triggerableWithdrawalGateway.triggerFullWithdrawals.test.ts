import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  StakingRouter__MockForTWG,
  TriggerableWithdrawalsGateway__Harness,
  WithdrawalVault__MockForTWG,
} from "typechain-types";

import { deployLidoLocator, updateLidoLocatorImplementation } from "../deploy/locator";

interface ExitRequest {
  moduleId: number;
  nodeOpId: number;
  valIndex: number;
  valPubkey: string;
}

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
];

const exitRequests = [
  { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
  { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
  { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
];

const ZERO_ADDRESS = ethers.ZeroAddress;

describe("TriggerableWithdrawalsGateway.sol:triggerFullWithdrawals", () => {
  let triggerableWithdrawalsGateway: TriggerableWithdrawalsGateway__Harness;
  let withdrawalVault: WithdrawalVault__MockForTWG;
  let stakingRouter: StakingRouter__MockForTWG;
  let admin: HardhatEthersSigner;
  let authorizedEntity: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const createValidatorDataList = (requests: ExitRequest[]) => {
    return requests.map((request) => ({
      stakingModuleId: request.moduleId,
      nodeOperatorId: request.nodeOpId,
      pubkey: request.valPubkey,
    }));
  };

  before(async () => {
    [admin, authorizedEntity, stranger] = await ethers.getSigners();

    const locator = await deployLidoLocator();
    const locatorAddr = await locator.getAddress();

    withdrawalVault = await ethers.deployContract("WithdrawalVault__MockForTWG");
    stakingRouter = await ethers.deployContract("StakingRouter__MockForTWG");

    await updateLidoLocatorImplementation(locatorAddr, {
      withdrawalVault: await withdrawalVault.getAddress(),
      stakingRouter: await stakingRouter.getAddress(),
    });

    triggerableWithdrawalsGateway = await ethers.deployContract("TriggerableWithdrawalsGateway__Harness", [
      admin,
      locatorAddr,
      100,
      1,
      48,
    ]);

    const role = await triggerableWithdrawalsGateway.ADD_FULL_WITHDRAWAL_REQUEST_ROLE();
    await triggerableWithdrawalsGateway.grantRole(role, authorizedEntity);
  });

  it("should revert if caller does not have the `ADD_FULL_WITHDRAWAL_REQUEST_ROLE", async () => {
    const requests = createValidatorDataList(exitRequests);
    const role = await triggerableWithdrawalsGateway.ADD_FULL_WITHDRAWAL_REQUEST_ROLE();

    await expect(
      triggerableWithdrawalsGateway.connect(stranger).triggerFullWithdrawals(requests, ZERO_ADDRESS, 0, { value: 10 }),
    ).to.be.revertedWithOZAccessControlError(stranger.address, role);
  });

  it("should revert with ZeroArgument error if msg.value == 0", async () => {
    const requests = createValidatorDataList(exitRequests);

    await expect(
      triggerableWithdrawalsGateway
        .connect(authorizedEntity)
        .triggerFullWithdrawals(requests, ZERO_ADDRESS, 0, { value: 0 }),
    )
      .to.be.revertedWithCustomError(triggerableWithdrawalsGateway, "ZeroArgument")
      .withArgs("msg.value");
  });

  it("should revert with ZeroArgument error if requests count is zero", async () => {
    await expect(
      triggerableWithdrawalsGateway
        .connect(authorizedEntity)
        .triggerFullWithdrawals([], ZERO_ADDRESS, 0, { value: 10 }),
    )
      .to.be.revertedWithCustomError(triggerableWithdrawalsGateway, "ZeroArgument")
      .withArgs("validatorsData");
  });

  it("should revert if total fee value sent is insufficient to cover all provided TW requests ", async () => {
    const requests = createValidatorDataList(exitRequests);

    await expect(
      triggerableWithdrawalsGateway
        .connect(authorizedEntity)
        .triggerFullWithdrawals(requests, ZERO_ADDRESS, 0, { value: 1 }),
    )
      .to.be.revertedWithCustomError(triggerableWithdrawalsGateway, "InsufficientFee")
      .withArgs(3, 1);
  });

  it("should not allow to set limit without role TW_EXIT_LIMIT_MANAGER_ROLE", async () => {
    const reportLimitRole = await triggerableWithdrawalsGateway.TW_EXIT_LIMIT_MANAGER_ROLE();

    await expect(
      triggerableWithdrawalsGateway.connect(stranger).setExitRequestLimit(4, 1, 48),
    ).to.be.revertedWithOZAccessControlError(await stranger.getAddress(), reportLimitRole);
  });

  it("set limit", async () => {
    const role = await triggerableWithdrawalsGateway.TW_EXIT_LIMIT_MANAGER_ROLE();
    await triggerableWithdrawalsGateway.grantRole(role, authorizedEntity);

    const exitLimitTx = await triggerableWithdrawalsGateway.connect(authorizedEntity).setExitRequestLimit(4, 1, 48);
    await expect(exitLimitTx).to.emit(triggerableWithdrawalsGateway, "ExitRequestsLimitSet").withArgs(4, 1, 48);
  });

  it("should add withdrawal request", async () => {
    const requests = createValidatorDataList(exitRequests);

    const tx = await triggerableWithdrawalsGateway
      .connect(authorizedEntity)
      .triggerFullWithdrawals(requests, ZERO_ADDRESS, 0, { value: 4 });

    const pubkeys = exitRequests.map((request) => request.valPubkey);

    for (const request of exitRequests) {
      await expect(tx)
        .to.emit(stakingRouter, "Mock__onValidatorExitTriggered")
        .withArgs(request.moduleId, request.nodeOpId, request.valPubkey, 1, 0);

      await expect(tx).to.emit(withdrawalVault, "AddFullWithdrawalRequestsCalled").withArgs(pubkeys);
    }
  });

  it("check current limit", async () => {
    const data = await triggerableWithdrawalsGateway.getExitRequestLimitFullInfo();

    // maxExitRequestsLimit
    expect(data[0]).to.equal(4);
    // exitsPerFrame
    expect(data[1]).to.equal(1);
    // frameDurationInSec
    expect(data[2]).to.equal(48);
    // prevExitRequestsLimit
    // maxExitRequestsLimit (4) - exitRequests.length (3)
    expect(data[3]).to.equal(1);
    // currentExitRequestsLimit
    // equal to prevExitRequestsLimit as timestamp is mocked in test and we didnt increase it yet
    expect(data[4]).to.equal(1);
  });

  it("should revert if limit doesnt cover requests count", async () => {
    const requests = createValidatorDataList(exitRequests);

    await expect(
      triggerableWithdrawalsGateway
        .connect(authorizedEntity)
        .triggerFullWithdrawals(requests, ZERO_ADDRESS, 0, { value: 4 }),
    )
      .to.be.revertedWithCustomError(triggerableWithdrawalsGateway, "ExitRequestsLimitExceeded")
      .withArgs(3, 1);
  });

  it("rewind time", async () => {
    await triggerableWithdrawalsGateway.advanceTimeBy(2 * 48);
  });

  it("current limit should be increased by 2", async () => {
    const data = await triggerableWithdrawalsGateway.getExitRequestLimitFullInfo();

    // maxExitRequestsLimit
    expect(data[0]).to.equal(4);
    // exitsPerFrame
    expect(data[1]).to.equal(1);
    // frameDurationInSec
    expect(data[2]).to.equal(48);
    // prevExitRequestsLimit
    // maxExitRequestsLimit (4) - exitRequests.length (3)
    expect(data[3]).to.equal(1);
    // currentExitRequestsLimit
    expect(data[4]).to.equal(3);
  });

  it("should add withdrawal request as limit is enough for processing all requests", async () => {
    const requests = createValidatorDataList(exitRequests);

    const tx = await triggerableWithdrawalsGateway
      .connect(authorizedEntity)
      .triggerFullWithdrawals(requests, ZERO_ADDRESS, 0, { value: 4 });

    const pubkeys = exitRequests.map((request) => request.valPubkey);

    for (const request of exitRequests) {
      await expect(tx)
        .to.emit(stakingRouter, "Mock__onValidatorExitTriggered")
        .withArgs(request.moduleId, request.nodeOpId, request.valPubkey, 1, 0);

      await expect(tx).to.emit(withdrawalVault, "AddFullWithdrawalRequestsCalled").withArgs(pubkeys);
    }
  });

  it("rewind time", async () => {
    await triggerableWithdrawalsGateway.advanceTimeBy(3 * 48);
  });

  it("should refund fee to recipient address", async () => {
    const prevBalance = await ethers.provider.getBalance(stranger);
    const requests = createValidatorDataList(exitRequests);

    await triggerableWithdrawalsGateway
      .connect(authorizedEntity)
      .triggerFullWithdrawals(requests, stranger, 0, { value: 3 + 7 });

    const newBalance = await ethers.provider.getBalance(stranger);

    expect(newBalance).to.equal(prevBalance + 7n);
  });

  it("rewind time", async () => {
    await triggerableWithdrawalsGateway.advanceTimeBy(3 * 48);
  });

  it("should refund fee to sender address", async () => {
    const SENDER_ADDR = authorizedEntity.address;
    const prevBalance = await ethers.provider.getBalance(SENDER_ADDR);

    const requests = createValidatorDataList(exitRequests);

    const tx = await triggerableWithdrawalsGateway
      .connect(authorizedEntity)
      .triggerFullWithdrawals(requests, ZERO_ADDRESS, 0, { value: 3 + 7 });

    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

    const newBalance = await ethers.provider.getBalance(SENDER_ADDR);
    expect(newBalance).to.equal(prevBalance - gasUsed - 3n);
  });

  it("rewind time", async () => {
    await triggerableWithdrawalsGateway.advanceTimeBy(3 * 48);
  });

  it("preserves eth balance when calling triggerFullWithdrawals", async () => {
    const requests = createValidatorDataList(exitRequests);
    const refundRecipient = ZERO_ADDRESS;
    const exitType = 2;
    const ethBefore = await ethers.provider.getBalance(triggerableWithdrawalsGateway.getAddress());

    await triggerableWithdrawalsGateway
      .connect(authorizedEntity)
      .triggerFullWithdrawals(requests, refundRecipient, exitType, { value: 4 });

    const ethAfter = await ethers.provider.getBalance(triggerableWithdrawalsGateway.getAddress());
    expect(ethAfter).to.equal(ethBefore);
  });

  it("should not make refund if refund is zero", async () => {
    const fee = 10n;
    const prevBalance = await ethers.provider.getBalance(authorizedEntity.address);

    const tx = await triggerableWithdrawalsGateway
      .connect(authorizedEntity)
      .refundFee(fee, authorizedEntity.address, { value: fee });

    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

    const newBalance = await ethers.provider.getBalance(authorizedEntity.address);

    expect(newBalance).to.equal(prevBalance - gasUsed - fee);
  });

  it("should refund ETH if refund > 0", async () => {
    const fee = 6n;
    const totalValue = 10n;
    const refundRecipient = authorizedEntity;

    const prevBalance = await ethers.provider.getBalance(refundRecipient.address);

    const tx = await triggerableWithdrawalsGateway
      .connect(authorizedEntity)
      .refundFee(fee, refundRecipient.address, { value: totalValue });

    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

    const newBalance = await ethers.provider.getBalance(refundRecipient.address);
    expect(newBalance).to.equal(prevBalance - gasUsed - fee);
  });

  it("should reverts if recipient refuses ETH", async () => {
    const RefundReverterFactory = await ethers.getContractFactory("RefundReverter");
    const refundReverter = await RefundReverterFactory.deploy();

    await expect(
      triggerableWithdrawalsGateway.connect(authorizedEntity).refundFee(5, refundReverter.getAddress(), { value: 10 }),
    ).to.be.revertedWithCustomError(triggerableWithdrawalsGateway, "FeeRefundFailed");
  });

  it("should set maxExitRequestsLimit equal to 0 and return as currentExitRequestsLimit type(uint256).max", async () => {
    const tx = await triggerableWithdrawalsGateway.connect(authorizedEntity).setExitRequestLimit(0, 0, 48);
    await expect(tx).to.emit(triggerableWithdrawalsGateway, "ExitRequestsLimitSet").withArgs(0, 0, 48);

    const data = await triggerableWithdrawalsGateway.getExitRequestLimitFullInfo();

    expect(data.maxExitRequestsLimit).to.equal(0);
    expect(data.exitsPerFrame).to.equal(0);
    expect(data.frameDurationInSec).to.equal(48);
    expect(data.prevExitRequestsLimit).to.equal(0);
    expect(data.currentExitRequestsLimit).to.equal(2n ** 256n - 1n);
  });

  it("should add unlimited amount of withdrawal requests", async () => {
    const requests = [
      { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
      { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
      { moduleId: 2, nodeOpId: 1, valIndex: 1, valPubkey: PUBKEYS[2] },
      { moduleId: 2, nodeOpId: 2, valIndex: 1, valPubkey: PUBKEYS[2] },
      { moduleId: 2, nodeOpId: 3, valIndex: 1, valPubkey: PUBKEYS[2] },
      { moduleId: 2, nodeOpId: 4, valIndex: 1, valPubkey: PUBKEYS[2] },
      { moduleId: 2, nodeOpId: 5, valIndex: 1, valPubkey: PUBKEYS[2] },
      { moduleId: 2, nodeOpId: 6, valIndex: 1, valPubkey: PUBKEYS[2] },
      { moduleId: 2, nodeOpId: 7, valIndex: 1, valPubkey: PUBKEYS[2] },
    ];

    const requestData = createValidatorDataList(requests);

    const tx = await triggerableWithdrawalsGateway
      .connect(authorizedEntity)
      .triggerFullWithdrawals(requestData, ZERO_ADDRESS, 0, { value: 10 });

    const pubkeys = requests.map((request) => request.valPubkey);

    for (const request of exitRequests) {
      await expect(tx)
        .to.emit(stakingRouter, "Mock__onValidatorExitTriggered")
        .withArgs(request.moduleId, request.nodeOpId, request.valPubkey, 1, 0);

      await expect(tx).to.emit(withdrawalVault, "AddFullWithdrawalRequestsCalled").withArgs(pubkeys);
    }
  });

  it("Should not allow to set exitsPerFrame bigger than maxExitRequestsLimit", async () => {
    await expect(
      triggerableWithdrawalsGateway.connect(authorizedEntity).setExitRequestLimit(0, 1, 48),
    ).to.be.revertedWithCustomError(triggerableWithdrawalsGateway, "TooLargeExitsPerFrame");
  });
});
