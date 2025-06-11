import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ValidatorsExitBusOracle, WithdrawalVault } from "typechain-types";

import { de0x, ether, numberToHex } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

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

// TODO: update upon TW integrations arrive
describe.skip("ValidatorsExitBus integration", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let veb: ValidatorsExitBusOracle;
  let wv: WithdrawalVault;
  let hashReporter: HardhatEthersSigner;
  let resumer: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let refundRecipient: HardhatEthersSigner;

  const moduleId = 1;
  const nodeOpId = 2;
  const valIndex = 3;
  const pubkey = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  const exitRequestPacked = "0x" + encodeExitRequestHex({ moduleId, nodeOpId, valIndex, valPubkey: pubkey });

  before(async () => {
    ctx = await getProtocolContext();
    veb = ctx.contracts.validatorsExitBusOracle;
    wv = ctx.contracts.withdrawalVault;

    [hashReporter, resumer, refundRecipient] = await ethers.getSigners();

    agent = await ctx.getSigner("agent", ether("1"));

    // Grant role to submit exit hash
    const submitReportHashRole = await veb.SUBMIT_REPORT_HASH_ROLE();
    await veb.connect(agent).grantRole(submitReportHashRole, hashReporter);

    if (await veb.isPaused()) {
      const resumeRole = await veb.RESUME_ROLE();
      await veb.connect(agent).grantRole(resumeRole, resumer);
      await veb.connect(resumer).resume();

      expect(veb.isPaused()).to.be.false;
    }
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));

  it("should trigger exits", async () => {
    const dataFormat = 1;

    const exitRequest = { dataFormat, data: exitRequestPacked };

    const exitRequestsHash: string = hashExitRequest(exitRequest);

    await expect(veb.connect(hashReporter).submitExitRequestsHash(exitRequestsHash))
      .to.emit(veb, "RequestsHashSubmitted")
      .withArgs(exitRequestsHash);

    const tx = await veb.submitExitRequestsData(exitRequest);
    const receipt = await tx.wait();
    const block = await receipt?.getBlock();
    const blockTimestamp = block!.timestamp;

    await expect(tx)
      .to.emit(veb, "ValidatorExitRequest")
      .withArgs(moduleId, nodeOpId, valIndex, pubkey, blockTimestamp);

    const timestamp = await veb.getDeliveryTimestamp(exitRequestsHash);
    expect(timestamp).to.equal(blockTimestamp);

    const ethBefore = await ethers.provider.getBalance(refundRecipient.getAddress());

    const triggerExitsTx = await veb
      .connect(refundRecipient)
      .triggerExits(exitRequest, [0], ZeroAddress, { value: 10 });

    await expect(triggerExitsTx).to.emit(wv, "WithdrawalRequestAdded");

    const ethAfter = await ethers.provider.getBalance(refundRecipient.getAddress());

    const fee = await wv.getWithdrawalRequestFee();

    const txReceipt = await triggerExitsTx.wait();
    const gasUsed = BigInt(txReceipt!.gasUsed) * txReceipt!.gasPrice;

    expect(ethAfter).to.equal(ethBefore - gasUsed - fee);
  });

  it("should handle non-zero refundRecipient and refund the correct amount", async () => {
    const dataFormat = 1;

    const exitRequest = { dataFormat, data: exitRequestPacked };

    const exitRequestsHash = hashExitRequest(exitRequest);

    await veb.connect(hashReporter).submitExitRequestsHash(exitRequestsHash);
    await veb.submitExitRequestsData(exitRequest);

    const ethBefore = await ethers.provider.getBalance(refundRecipient.getAddress());

    const tx = await veb.triggerExits(exitRequest, [0], refundRecipient.getAddress(), { value: 10 });
    await expect(tx).to.emit(wv, "WithdrawalRequestAdded");

    const fee = await wv.getWithdrawalRequestFee();

    const ethAfter = await ethers.provider.getBalance(refundRecipient.getAddress());

    // Should be increased by (10 - fee)
    expect(ethAfter - ethBefore).to.equal(10n - fee);
  });
});
