import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ValidatorsExitBusOracle } from "typechain-types";

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

describe("ValidatorsExitBus integration", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let veb: ValidatorsExitBusOracle;
  let hashReporter: HardhatEthersSigner;
  let resumer: HardhatEthersSigner;
  let agent: HardhatEthersSigner;

  const moduleId = 1;
  const nodeOpId = 2;
  const valIndex = 3;
  const pubkey = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  const exitRequestPacked = "0x" + encodeExitRequestHex({ moduleId, nodeOpId, valIndex, valPubkey: pubkey });

  before(async () => {
    ctx = await getProtocolContext();
    veb = ctx.contracts.validatorsExitBusOracle;

    [hashReporter, resumer] = await ethers.getSigners();

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

  it("should submit hash and data, updating delivery history", async () => {
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

    const timestamp = await veb.getExitRequestsDeliveryHistory(exitRequestsHash);
    expect(timestamp).to.equal(blockTimestamp);
  });
});
