import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { NodeOperatorsRegistry, ValidatorsExitBusOracle, WithdrawalVault } from "typechain-types";

import { de0x, ether, numberToHex } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { norSdvtEnsureOperators } from "lib/protocol/helpers";
import { NOR_MODULE_ID } from "lib/protocol/helpers/staking-module";
import { LoadedContract } from "lib/protocol/types";

import { bailOnFailure, Snapshot } from "test/suite";

interface ExitRequest {
  moduleId: number;
  nodeOpId: number;
  valIndex: number;
  keyIndex: number;
  valPubkey: string;
}

// DATA_FORMAT_LIST_WITH_KEY_INDEX (=2): the only format accepted by submitExitRequestsData.
const encodeExitRequestHex = ({ moduleId, nodeOpId, valIndex, keyIndex, valPubkey }: ExitRequest) => {
  const pubkeyHex = de0x(valPubkey);
  expect(pubkeyHex.length).to.equal(48 * 2);
  return (
    numberToHex(moduleId, 3) +
    numberToHex(nodeOpId, 5) +
    numberToHex(valIndex, 8) +
    numberToHex(keyIndex, 8) +
    pubkeyHex
  );
};

const hashExitRequest = (request: { dataFormat: number; data: string }) => {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], [request.data, request.dataFormat]),
  );
};

describe("Scenario: ValidatorsExitBus Submit and Trigger Exits", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let veb: ValidatorsExitBusOracle;
  let wv: WithdrawalVault;
  let nor: LoadedContract<NodeOperatorsRegistry>;

  let hashReporter: HardhatEthersSigner;
  let resumer: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let refundRecipient: HardhatEthersSigner;

  const dataFormat = 2;

  // Built in `before` from real on-chain NOR signing keys, so format-2 key verification passes.
  let validatorsExitRequests: ExitRequest[];
  let exitRequest: { dataFormat: number; data: string };
  let exitRequestsHash: string;

  before(async () => {
    ctx = await getProtocolContext();
    veb = ctx.contracts.validatorsExitBusOracle;
    wv = ctx.contracts.withdrawalVault;
    nor = ctx.contracts.nor;

    [hashReporter, stranger, resumer, refundRecipient] = await ethers.getSigners();

    agent = await ctx.getSigner("agent", ether("1"));

    // Ensure NOR has node operators with signing keys, then build exit requests
    // referencing real registered keys (moduleId 1 = NOR).
    await norSdvtEnsureOperators(ctx, nor);

    const moduleId = Number(NOR_MODULE_ID);
    const requestDefs = [
      { nodeOpId: 0, keyIndex: 0, valIndex: 100 },
      { nodeOpId: 0, keyIndex: 1, valIndex: 101 },
      { nodeOpId: 1, keyIndex: 0, valIndex: 102 },
      { nodeOpId: 1, keyIndex: 1, valIndex: 200 },
      { nodeOpId: 2, keyIndex: 0, valIndex: 201 },
    ];

    validatorsExitRequests = [];
    for (const def of requestDefs) {
      const { key } = await nor.getSigningKey(def.nodeOpId, def.keyIndex);
      validatorsExitRequests.push({ moduleId, ...def, valPubkey: key });
    }

    const data = "0x" + validatorsExitRequests.map(encodeExitRequestHex).join("");
    exitRequest = { dataFormat, data };
    exitRequestsHash = hashExitRequest(exitRequest);

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

  it("should revert when non-authorized entity tries to submit hash", async () => {
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
    // Set a high enough balance limit (in ETH) to cover test requests
    const MAX_LIMIT = 1_000_000;
    await veb.connect(agent).setExitRequestLimit(MAX_LIMIT, 1, 48);
    // Resume the contract
    await veb.connect(resumer).resume();
    expect(await veb.isPaused()).to.be.false;

    await expect(veb.connect(hashReporter).submitExitRequestsHash(exitRequestsHash))
      .to.emit(veb, "RequestsHashSubmitted")
      .withArgs(exitRequestsHash);

    const limitBefore = await veb.getExitRequestLimitFullInfo();
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
    // Limit should decrease after processing
    expect(currentExitRequestsLimit).to.be.lessThan(limitBefore[4]);
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
