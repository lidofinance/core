import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  StakingRouter__MockForTWG,
  TriggerableWithdrawalGateway__Harness,
  WithdrawalVault__MockForTWG,
} from "typechain-types";

import { de0x, numberToHex } from "lib";

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

describe("TriggerableWithdrawalGateway.sol:triggerFullWithdrawals", () => {
  let triggerableWithdrawalGateway: TriggerableWithdrawalGateway__Harness;
  let withdrawalVault: WithdrawalVault__MockForTWG;
  let stakingRouter: StakingRouter__MockForTWG;
  let admin: HardhatEthersSigner;
  let authorizedEntity: HardhatEthersSigner;

  const encodeTWGExitRequestsData = ({ moduleId, nodeOpId, valPubkey }: ExitRequest) => {
    const pubkeyHex = de0x(valPubkey);
    expect(pubkeyHex.length).to.equal(48 * 2);
    return numberToHex(moduleId, 3) + numberToHex(nodeOpId, 5) + pubkeyHex;
  };

  const encodeTWGExitDataList = (requests: ExitRequest[]) => {
    return "0x" + requests.map(encodeTWGExitRequestsData).join("");
  };

  before(async () => {
    [admin, authorizedEntity] = await ethers.getSigners();

    const locator = await deployLidoLocator();
    const locatorAddr = await locator.getAddress();

    withdrawalVault = await ethers.deployContract("WithdrawalVault__MockForTWG");
    stakingRouter = await ethers.deployContract("StakingRouter__MockForTWG");

    await updateLidoLocatorImplementation(locatorAddr, {
      withdrawalVault: await withdrawalVault.getAddress(),
      stakingRouter: await stakingRouter.getAddress(),
    });

    triggerableWithdrawalGateway = await ethers.deployContract("TriggerableWithdrawalGateway__Harness", [
      admin,
      locatorAddr,
    ]);
  });

  it("should revert if caller does not have the `ADD_FULL_WITHDRAWAL_REQUEST_ROLE", async () => {
    const requests = encodeTWGExitDataList(exitRequests);
    const role = await triggerableWithdrawalGateway.ADD_FULL_WITHDRAWAL_REQUEST_ROLE();
    await expect(
      triggerableWithdrawalGateway
        .connect(authorizedEntity)
        .triggerFullWithdrawals(requests, ZERO_ADDRESS, 0, { value: 10 }),
    ).to.be.revertedWithOZAccessControlError(await authorizedEntity.getAddress(), role);
  });

  it("should revert if total fee value sent is insufficient to cover all provided TW requests ", async () => {
    const role = await triggerableWithdrawalGateway.ADD_FULL_WITHDRAWAL_REQUEST_ROLE();
    await triggerableWithdrawalGateway.grantRole(role, authorizedEntity);

    const requests = encodeTWGExitDataList(exitRequests);

    await expect(
      triggerableWithdrawalGateway
        .connect(authorizedEntity)
        .triggerFullWithdrawals(requests, ZERO_ADDRESS, 0, { value: 1 }),
    )
      .to.be.revertedWithCustomError(triggerableWithdrawalGateway, "InsufficientWithdrawalFee")
      .withArgs(3, 1);
  });

  it("set limit", async () => {
    const role = await triggerableWithdrawalGateway.TW_EXIT_REPORT_LIMIT_ROLE();
    await triggerableWithdrawalGateway.grantRole(role, authorizedEntity);

    const exitLimitTx = await triggerableWithdrawalGateway.connect(authorizedEntity).setExitRequestLimit(4, 1, 48);
    await expect(exitLimitTx).to.emit(triggerableWithdrawalGateway, "ExitRequestsLimitSet").withArgs(4, 1, 48);
  });

  it("should add withdrawal request", async () => {
    const requests = encodeTWGExitDataList(exitRequests);

    const tx = await triggerableWithdrawalGateway
      .connect(authorizedEntity)
      .triggerFullWithdrawals(requests, ZERO_ADDRESS, 0, { value: 4 });

    const timestamp = await triggerableWithdrawalGateway.getTimestamp();

    const pubkeys =
      "0x" +
      exitRequests
        .map((request) => {
          const pubkeyHex = de0x(request.valPubkey);
          return pubkeyHex;
        })
        .join("");

    for (const request of exitRequests) {
      await expect(tx)
        .to.emit(triggerableWithdrawalGateway, "TriggerableExitRequest")
        .withArgs(request.moduleId, request.nodeOpId, request.valPubkey, timestamp);

      await expect(tx)
        .to.emit(stakingRouter, "Mock__onValidatorExitTriggered")
        .withArgs(request.moduleId, request.nodeOpId, request.valPubkey, 1, 0);

      await expect(tx).to.emit(withdrawalVault, "AddFullWithdrawalRequestsCalled").withArgs(pubkeys);
    }
  });

  it("check current limit", async () => {
    const data = await triggerableWithdrawalGateway.getExitRequestLimitFullInfo();

    // maxExitRequestsLimit
    expect(data[0]).to.equal(4);
    // exitsPerFrame
    expect(data[1]).to.equal(1);
    // frameDuration
    expect(data[2]).to.equal(48);
    // prevExitRequestsLimit
    // maxExitRequestsLimit (4) - exitRequests.length (3)
    expect(data[3]).to.equal(1);
    // currentExitRequestsLimit
    // equal to prevExitRequestsLimit as timestamp is mocked in test and we didnt increase it yet
    expect(data[4]).to.equal(1);
  });

  it("should revert if limit doesnt cover requests count", async () => {
    const requests = encodeTWGExitDataList(exitRequests);

    await expect(
      triggerableWithdrawalGateway
        .connect(authorizedEntity)
        .triggerFullWithdrawals(requests, ZERO_ADDRESS, 0, { value: 4 }),
    )
      .to.be.revertedWithCustomError(triggerableWithdrawalGateway, "ExitRequestsLimit")
      .withArgs(3, 1);
  });

  it("should revert if limit doesnt cover requests count", async () => {
    const requests = encodeTWGExitDataList(exitRequests);

    await expect(
      triggerableWithdrawalGateway
        .connect(authorizedEntity)
        .triggerFullWithdrawals(requests, ZERO_ADDRESS, 0, { value: 4 }),
    )
      .to.be.revertedWithCustomError(triggerableWithdrawalGateway, "ExitRequestsLimit")
      .withArgs(3, 1);
  });

  it("rewind time", async () => {
    await triggerableWithdrawalGateway.advanceTimeBy(2 * 48);
  });

  it("current limit should be increased by 2", async () => {
    const data = await triggerableWithdrawalGateway.getExitRequestLimitFullInfo();

    // maxExitRequestsLimit
    expect(data[0]).to.equal(4);
    // exitsPerFrame
    expect(data[1]).to.equal(1);
    // frameDuration
    expect(data[2]).to.equal(48);
    // prevExitRequestsLimit
    // maxExitRequestsLimit (4) - exitRequests.length (3)
    expect(data[3]).to.equal(1);
    // currentExitRequestsLimit
    expect(data[4]).to.equal(3);
  });

  it("should add withdrawal request ias limit is enough for processing all requests", async () => {
    const requests = encodeTWGExitDataList(exitRequests);

    const tx = await triggerableWithdrawalGateway
      .connect(authorizedEntity)
      .triggerFullWithdrawals(requests, ZERO_ADDRESS, 0, { value: 4 });

    const timestamp = await triggerableWithdrawalGateway.getTimestamp();

    const pubkeys =
      "0x" +
      exitRequests
        .map((request) => {
          const pubkeyHex = de0x(request.valPubkey);
          return pubkeyHex;
        })
        .join("");

    for (const request of exitRequests) {
      await expect(tx)
        .to.emit(triggerableWithdrawalGateway, "TriggerableExitRequest")
        .withArgs(request.moduleId, request.nodeOpId, request.valPubkey, timestamp);

      await expect(tx)
        .to.emit(stakingRouter, "Mock__onValidatorExitTriggered")
        .withArgs(request.moduleId, request.nodeOpId, request.valPubkey, 1, 0);

      await expect(tx).to.emit(withdrawalVault, "AddFullWithdrawalRequestsCalled").withArgs(pubkeys);
    }
  });
});
