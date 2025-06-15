import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { NodeOperatorsRegistry, ValidatorsExitBusOracle, WithdrawalVault } from "typechain-types";

import { de0x, ether, numberToHex } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";

interface ExitRequest {
  moduleId: number;
  nodeOpId: number;
  valIndex: number;
  valPubkey: string;
}

const encodeExitRequestHex = ({ moduleId, nodeOpId, valIndex, valPubkey }: ExitRequest) => {
  const pubkeyHex = de0x(valPubkey);
  expect(pubkeyHex.length).to.equal(48 * 2);
  return numberToHex(moduleId, 3) + numberToHex(nodeOpId, 5) + numberToHex(valIndex, 8) + pubkeyHex;
};

const hashExitRequest = (request: { dataFormat: number; data: string }) => {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], [request.data, request.dataFormat]),
  );
};

// TODO: enable when upgrade for TW will enable
describe.skip("ValidatorsExitBus integration", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let veb: ValidatorsExitBusOracle;
  let wv: WithdrawalVault;
  let nor: NodeOperatorsRegistry;

  let hashReporter: HardhatEthersSigner;
  let resumer: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let refundRecipient: HardhatEthersSigner;

  const dataFormat = 1;
  const exitRequestsLength = 5;

  const validatorsExitRequests: ExitRequest[] = [
    { moduleId: 1, nodeOpId: 10, valIndex: 100, valPubkey: "0x" + "11".repeat(48) },
    { moduleId: 1, nodeOpId: 11, valIndex: 101, valPubkey: "0x" + "22".repeat(48) },
    { moduleId: 1, nodeOpId: 12, valIndex: 102, valPubkey: "0x" + "33".repeat(48) },
    { moduleId: 2, nodeOpId: 20, valIndex: 200, valPubkey: "0x" + "44".repeat(48) },
    { moduleId: 2, nodeOpId: 21, valIndex: 201, valPubkey: "0x" + "55".repeat(48) },
  ];

  const multipleExitRequests = validatorsExitRequests.map((req) => "0x" + encodeExitRequestHex(req));
  const data = multipleExitRequests.reduce((acc, curr) => acc + curr.slice(2), "0x");
  const exitRequest = { dataFormat, data };
  const exitRequestsHash: string = hashExitRequest(exitRequest);

  before(async () => {
    ctx = await getProtocolContext();
    veb = ctx.contracts.validatorsExitBusOracle;
    wv = ctx.contracts.withdrawalVault;
    nor = ctx.contracts.nor;

    [hashReporter, stranger, resumer, refundRecipient] = await ethers.getSigners();

    agent = await ctx.getSigner("agent", ether("1"));

    // Grant role to submit exit hash
    const submitReportHashRole = await veb.SUBMIT_REPORT_HASH_ROLE();
    await veb.connect(agent).grantRole(submitReportHashRole, hashReporter);

    const resumeRole = await veb.RESUME_ROLE();
    const pauseRole = await veb.PAUSE_ROLE();
    const exitRequestLimitManagerRole = await veb.EXIT_REQUEST_LIMIT_MANAGER_ROLE();
    await veb.connect(agent).grantRole(resumeRole, resumer);
    await veb.connect(agent).grantRole(pauseRole, resumer);
    await veb.connect(agent).grantRole(exitRequestLimitManagerRole, agent);

    if (await veb.isPaused()) {
      await veb.connect(resumer).resume();

      expect(await veb.isPaused()).to.be.false;
    }
  });

  before(async () => (snapshot = await Snapshot.take()));
  beforeEach(bailOnFailure);
  after(async () => await Snapshot.restore(snapshot));

  it("check contract version", async () => {});
  // -EXECUTION REVERTED: REVERT: ACCESSCONTROL: ACCOUNT 0X70997970C51812DC3A010C7D01B50E0D17DC79C8 IS MISSING ROLE 0X22EBB4DBAFB72948800C1E1AFA1688772A1A4CFC54D5EBFCEC8163B1139C082E
  // +VM EXCEPTION WHILE PROCESSING TRANSACTION: REVERTED WITH REASON STRING 'ACCESSCONTROL: ACCOUNT 0X70997970C51812DC3A010C7D01B50E0D17DC79C8 IS MISSING ROLE 0X22EBB4DBAFB72948800C1E1AFA1688772A1A4CFC54D5EBFCEC8163B1139C082E'
  it.skip("should revert when non-authorized entity tries to submit hash", async () => {
    const SUBMIT_REPORT_HASH_ROLE = await veb.SUBMIT_REPORT_HASH_ROLE();
    const hasRole = await veb.hasRole(SUBMIT_REPORT_HASH_ROLE, stranger.address);
    expect(hasRole).to.be.false;

    await expect(veb.connect(stranger).submitExitRequestsHash(exitRequestsHash)).to.be.revertedWithOZAccessControlError(
      stranger.address,
      SUBMIT_REPORT_HASH_ROLE,
    );
  });

  it("should not alow to submit hash or report if veb is paused", async () => {
    // pause
    await veb.connect(resumer).pauseFor(60);

    // Verify contract is paused
    expect(await veb.isPaused()).to.be.true;

    await expect(veb.connect(hashReporter).submitExitRequestsHash(exitRequestsHash)).to.be.revertedWithCustomError(
      veb,
      "ResumedExpected",
    );

    await expect(veb.submitExitRequestsData(exitRequest)).to.be.revertedWithCustomError(veb, "ResumedExpected");
  });

  it("should submit hash and data if veb is resumed", async () => {
    // Configure exit requests limits
    const MAX_LIMIT = 100;
    await veb.connect(agent).setExitRequestLimit(MAX_LIMIT, 1, 48);
    // Resume the contract
    await veb.connect(resumer).resume();
    expect(await veb.isPaused()).to.be.false;

    await expect(veb.connect(hashReporter).submitExitRequestsHash(exitRequestsHash))
      .to.emit(veb, "RequestsHashSubmitted")
      .withArgs(exitRequestsHash);

    const tx = await veb.submitExitRequestsData(exitRequest);
    const receipt = await tx.wait();
    const block = await receipt?.getBlock();
    const blockTimestamp = block!.timestamp;

    for (const { moduleId, nodeOpId, valIndex, valPubkey } of validatorsExitRequests) {
      await expect(tx)
        .to.emit(veb, "ValidatorExitRequest")
        .withArgs(moduleId, nodeOpId, valIndex, valPubkey, blockTimestamp);
    }
    await expect(tx).to.emit(veb, "ExitDataProcessing").withArgs(exitRequestsHash);

    const timestamp = await veb.getDeliveryTimestamp(exitRequestsHash);
    expect(timestamp).to.equal(blockTimestamp);

    // check limit
    const exitLimitInfo = await veb.getExitRequestLimitFullInfo();
    const currentExitRequestsLimit = exitLimitInfo[4];
    expect(currentExitRequestsLimit).to.equal(MAX_LIMIT - exitRequestsLength);
  });

  it("should trigger exits", async () => {
    const ethBefore = await ethers.provider.getBalance(refundRecipient.getAddress());

    const triggerExitsTx = await veb
      .connect(refundRecipient)
      .triggerExits(exitRequest, [0], ZeroAddress, { value: 10 });
    await expect(triggerExitsTx).to.emit(wv, "WithdrawalRequestAdded");

    // check notification of 1 module
    await expect(triggerExitsTx).to.emit(nor, "ValidatorExitTriggered");

    const ethAfter = await ethers.provider.getBalance(refundRecipient.getAddress());

    const fee = await wv.getWithdrawalRequestFee();

    const txReceipt = await triggerExitsTx.wait();
    const gasUsed = BigInt(txReceipt!.gasUsed) * txReceipt!.gasPrice;

    expect(ethAfter).to.equal(ethBefore - gasUsed - fee);
  });

  it("should handle non-zero refundRecipient and refund the correct amount", async () => {
    const ethBefore = await ethers.provider.getBalance(refundRecipient.getAddress());

    const tx = await veb.triggerExits(exitRequest, [0], refundRecipient.getAddress(), { value: 10 });
    await expect(tx).to.emit(wv, "WithdrawalRequestAdded");
    // check notification of 1 module
    await expect(tx).to.emit(nor, "ValidatorExitTriggered");

    const fee = await wv.getWithdrawalRequestFee();

    const ethAfter = await ethers.provider.getBalance(refundRecipient.getAddress());

    // Should be increased by (10 - fee)
    expect(ethAfter - ethBefore).to.equal(10n - fee);
  });
});
