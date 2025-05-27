import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ValidatorsExitBusOracle } from "typechain-types";

import { advanceChainTime, de0x, ether, numberToHex } from "lib";
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
  let limitManager: HardhatEthersSigner;

  const requests = [
    {
      moduleId: 1,
      nodeOpId: 1,
      valIndex: 1,
      valPubkey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    {
      moduleId: 2,
      nodeOpId: 2,
      valIndex: 2,
      valPubkey: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    {
      moduleId: 3,
      nodeOpId: 3,
      valIndex: 3,
      valPubkey: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
    {
      moduleId: 4,
      nodeOpId: 4,
      valIndex: 4,
      valPubkey: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    },
    {
      moduleId: 5,
      nodeOpId: 5,
      valIndex: 5,
      valPubkey: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    },
    {
      moduleId: 6,
      nodeOpId: 6,
      valIndex: 6,
      valPubkey: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    },
    {
      moduleId: 7,
      nodeOpId: 7,
      valIndex: 7,
      valPubkey: "0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111",
    },
    {
      moduleId: 8,
      nodeOpId: 8,
      valIndex: 8,
      valPubkey: "0x222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222",
    },
    {
      moduleId: 9,
      nodeOpId: 9,
      valIndex: 9,
      valPubkey: "0x333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333",
    },
    {
      moduleId: 10,
      nodeOpId: 10,
      valIndex: 10,
      valPubkey: "0x444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444",
    },
  ];

  const exitRequests = {
    dataFormat: 1,
    data:
      "0x" +
      requests
        .map(({ moduleId, nodeOpId, valIndex, valPubkey }) => {
          return encodeExitRequestHex({ moduleId, nodeOpId, valIndex, valPubkey });
        })
        .join(""),
  };

  before(async () => {
    ctx = await getProtocolContext();
    veb = ctx.contracts.validatorsExitBusOracle;

    [hashReporter, resumer, limitManager] = await ethers.getSigners();

    agent = await ctx.getSigner("agent", ether("1"));

    // Grant role to submit exit hash
    const submitReportHashRole = await veb.SUBMIT_REPORT_HASH_ROLE();
    await veb.connect(agent).grantRole(submitReportHashRole, hashReporter);

    const manageLimitRole = await veb.EXIT_REPORT_LIMIT_ROLE();
    await veb.connect(agent).grantRole(manageLimitRole, limitManager);

    if (await veb.isPaused()) {
      const resumeRole = await veb.RESUME_ROLE();
      await veb.connect(agent).grantRole(resumeRole, resumer);
      await veb.connect(resumer).resume();

      expect(veb.isPaused()).to.be.false;
    }
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));

  it("should submit hash and submit data in 4 deliveries", async () => {
    // --- Setup exit limit ---
    const maxLimit = 3;
    const exitsPerFrame = 1;
    const frameDurationSeconds = 48;
    await veb.connect(limitManager).setExitRequestLimit(maxLimit, exitsPerFrame, frameDurationSeconds);

    // --- Prepare data ---
    const exitRequestsHash: string = hashExitRequest(exitRequests);

    await expect(veb.connect(hashReporter).submitExitRequestsHash(exitRequestsHash))
      .to.emit(veb, "RequestsHashSubmitted")
      .withArgs(exitRequestsHash);

    // --- 1st delivery: deliver maxLimit (3) requests ---
    const tx1 = await veb.submitExitRequestsData(exitRequests);
    const receipt1 = await tx1.wait();
    const block1 = await ethers.provider.getBlock(receipt1!.blockNumber);
    const block1Timestamp = block1!.timestamp;

    // Validate logs & event count
    const logs1 = receipt1!.logs.filter(
      (log) => log.topics[0] === veb.interface.getEvent("ValidatorExitRequest").topicHash,
    );
    expect(logs1.length).to.equal(maxLimit);

    for (let i = 0; i < maxLimit; i++) {
      const decoded = veb.interface.decodeEventLog("ValidatorExitRequest", logs1[i].data, logs1[i].topics);
      console.log(decoded);
      const expected = requests[i];
      expect(decoded[0]).to.equal(expected.moduleId);
      expect(decoded[1]).to.equal(expected.nodeOpId);
      expect(decoded[2]).to.equal(expected.valIndex);
      expect(decoded[3]).to.equal(expected.valPubkey);
      expect(decoded[4]).to.equal(block1Timestamp);
    }

    // Validate delivery history
    const deliveryHistory1 = await veb.getExitRequestsDeliveryHistory(exitRequestsHash);
    expect(deliveryHistory1.length).to.equal(1);
    expect(deliveryHistory1[0].lastDeliveredExitDataIndex).to.equal(maxLimit - 1);

    // --- 2nd delivery: only 1 request can be processed after 48 seconds ---
    await advanceChainTime(BigInt(frameDurationSeconds));

    const tx2 = await veb.submitExitRequestsData(exitRequests);
    const receipt2 = await tx2.wait();
    const block2 = await ethers.provider.getBlock(receipt2!.blockNumber);
    const block2Timestamp = block2!.timestamp;

    const logs2 = receipt2!.logs.filter(
      (log) => log.topics[0] === veb.interface.getEvent("ValidatorExitRequest").topicHash,
    );
    expect(logs2.length).to.equal(1);

    const decoded2 = veb.interface.decodeEventLog("ValidatorExitRequest", logs2[0].data, logs2[0].topics);
    const expected2 = requests[maxLimit];
    expect(decoded2[0]).to.equal(expected2.moduleId);
    expect(decoded2[1]).to.equal(expected2.nodeOpId);
    expect(decoded2[2]).to.equal(expected2.valIndex);
    expect(decoded2[3]).to.equal(expected2.valPubkey);
    expect(decoded2[4]).to.equal(block2Timestamp);

    const deliveryHistory2 = await veb.getExitRequestsDeliveryHistory(exitRequestsHash);
    expect(deliveryHistory2.length).to.equal(2);
    expect(deliveryHistory2[1].lastDeliveredExitDataIndex).to.equal(maxLimit);

    // --- 3rd delivery: deliver remaining 6 requests after waiting (6 * 48) seconds ---
    let remainingRequestsCount = requests.length - (maxLimit + 1); // 10 - 4 = 6
    await advanceChainTime(BigInt(frameDurationSeconds * remainingRequestsCount));

    const tx3 = await veb.submitExitRequestsData(exitRequests);
    const receipt3 = await tx3.wait();

    const logs3 = receipt3!.logs.filter(
      (log) => log.topics[0] === veb.interface.getEvent("ValidatorExitRequest").topicHash,
    );

    expect(logs3.length).to.equal(maxLimit);

    for (let i = 0; i < logs3.length; i++) {
      const decoded = veb.interface.decodeEventLog("ValidatorExitRequest", logs3[i].data, logs3[i].topics);
      const expected = requests[4 + i];
      expect(decoded[0]).to.equal(expected.moduleId);
      expect(decoded[1]).to.equal(expected.nodeOpId);
      expect(decoded[2]).to.equal(expected.valIndex);
      expect(decoded[3]).to.equal(expected.valPubkey);
    }

    // --- 4th delivery: final 3 requests, but no need to increase time ---

    const currentLimit = (await veb.getExitRequestLimitFullInfo()).currentExitRequestsLimit;
    expect(currentLimit).to.be.equal(0);

    remainingRequestsCount = requests.length - (maxLimit * 2 + 1); // 3

    await advanceChainTime(BigInt(frameDurationSeconds * remainingRequestsCount));

    const tx4 = await veb.submitExitRequestsData(exitRequests);
    const receipt4 = await tx4.wait();
    const logs4 = receipt4!.logs.filter(
      (log) => log.topics[0] === veb.interface.getEvent("ValidatorExitRequest").topicHash,
    );
    expect(logs4.length).to.equal(maxLimit);

    for (let i = 0; i < logs4.length; i++) {
      const decoded = veb.interface.decodeEventLog("ValidatorExitRequest", logs4[i].data, logs4[i].topics);
      const expected = requests[7 + i];
      expect(decoded[0]).to.equal(expected.moduleId);
      expect(decoded[1]).to.equal(expected.nodeOpId);
      expect(decoded[2]).to.equal(expected.valIndex);
      expect(decoded[3]).to.equal(expected.valPubkey);
    }

    // --- Validate total logs delivered = 10 requests ---
    const totalDelivered = logs1.length + logs2.length + logs3.length + logs4.length;
    expect(totalDelivered).to.equal(requests.length);

    // --- Validate delivery history entries: 4 deliveries ---
    const finalHistory = await veb.getExitRequestsDeliveryHistory(exitRequestsHash);
    expect(finalHistory.length).to.equal(4);
    expect(finalHistory[3].lastDeliveredExitDataIndex).to.equal(requests.length - 1);
  });
});
