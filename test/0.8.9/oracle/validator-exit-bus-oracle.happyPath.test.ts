import { expect } from "chai";
import { ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, ValidatorsExitBus__Harness } from "typechain-types";

import { de0x, numberToHex, VEBO_CONSENSUS_VERSION } from "lib";

import {
  computeTimestampAtSlot,
  DATA_FORMAT_LIST,
  deployVEBO,
  initVEBO,
  SECONDS_PER_FRAME,
  SLOTS_PER_FRAME,
} from "test/deploy";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
];

describe("ValidatorsExitBusOracle.sol:happyPath", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;

  let oracleVersion: bigint;
  let exitRequests: ExitRequest[];
  let reportFields: ReportFields;
  let reportHash: string;

  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const LAST_PROCESSING_REF_SLOT = 1;

  interface ExitRequest {
    moduleId: number;
    nodeOpId: number;
    valIndex: number;
    valPubkey: string;
  }

  interface ReportFields {
    consensusVersion: bigint;
    refSlot: bigint;
    requestsCount: number;
    dataFormat: number;
    data: string;
  }

  const calcValidatorsExitBusReportDataHash = (items: ReportFields) => {
    const reportData = [items.consensusVersion, items.refSlot, items.requestsCount, items.dataFormat, items.data];
    const reportDataHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["(uint256,uint256,uint256,uint256,bytes)"], [reportData]),
    );
    return reportDataHash;
  };

  const encodeExitRequestHex = ({ moduleId, nodeOpId, valIndex, valPubkey }: ExitRequest) => {
    const pubkeyHex = de0x(valPubkey);
    expect(pubkeyHex.length).to.equal(48 * 2);
    return numberToHex(moduleId, 3) + numberToHex(nodeOpId, 5) + numberToHex(valIndex, 8) + pubkeyHex;
  };

  const encodeExitRequestsDataList = (requests: ExitRequest[]) => {
    return "0x" + requests.map(encodeExitRequestHex).join("");
  };

  before(async () => {
    [admin, member1, member2, member3, stranger] = await ethers.getSigners();

    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;

    await initVEBO({
      admin: admin.address,
      oracle,
      consensus,
      resumeAfterDeploy: true,
      lastProcessingRefSlot: LAST_PROCESSING_REF_SLOT,
    });

    oracleVersion = await oracle.getContractVersion();

    await consensus.addMember(member1, 1);
    await consensus.addMember(member2, 2);
    await consensus.addMember(member3, 2);
  });

  const triggerConsensusOnHash = async (hash: string) => {
    const { refSlot } = await consensus.getCurrentFrame();
    await consensus.connect(member1).submitReport(refSlot, hash, VEBO_CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, hash, VEBO_CONSENSUS_VERSION);
    expect((await consensus.getConsensusState()).consensusReport).to.equal(hash);
  };

  it("initially, consensus report is empty and is not being processed", async () => {
    const report = await oracle.getConsensusReport();
    expect(report.hash).to.equal(ZeroHash);

    expect(report.processingDeadlineTime).to.equal(0);
    expect(report.processingStarted).to.equal(false);

    const frame = await consensus.getCurrentFrame();
    const procState = await oracle.getProcessingState();

    expect(procState.currentFrameRefSlot).to.equal(frame.refSlot);
    expect(procState.dataHash).to.equal(ZeroHash);
    expect(procState.processingDeadlineTime).to.equal(0);
    expect(procState.dataSubmitted).to.equal(false);
    expect(procState.dataFormat).to.equal(0);
    expect(procState.requestsCount).to.equal(0);
    expect(procState.requestsSubmitted).to.equal(0);
  });

  it("reference slot of the empty initial consensus report is set to the last processing slot passed to the initialize function", async () => {
    const report = await oracle.getConsensusReport();
    expect(report.refSlot).to.equal(LAST_PROCESSING_REF_SLOT);
  });

  it("committee reaches consensus on a report hash", async () => {
    const { refSlot } = await consensus.getCurrentFrame();

    exitRequests = [
      { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
      { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
    ];

    reportFields = {
      consensusVersion: VEBO_CONSENSUS_VERSION,
      refSlot: refSlot,
      requestsCount: exitRequests.length,
      dataFormat: DATA_FORMAT_LIST,
      data: encodeExitRequestsDataList(exitRequests),
    };

    reportHash = calcValidatorsExitBusReportDataHash(reportFields);

    await triggerConsensusOnHash(reportHash);
  });

  it("oracle gets the report hash", async () => {
    const report = await oracle.getConsensusReport();
    expect(report.hash).to.equal(reportHash);
    expect(report.refSlot).to.equal(reportFields.refSlot);
    expect(report.processingDeadlineTime).to.equal(computeTimestampAtSlot(report.refSlot + SLOTS_PER_FRAME));

    expect(report.processingStarted).to.equal(false);

    const frame = await consensus.getCurrentFrame();
    const procState = await oracle.getProcessingState();

    expect(procState.currentFrameRefSlot).to.equal(frame.refSlot);
    expect(procState.dataHash).to.equal(reportHash);
    expect(procState.processingDeadlineTime).to.equal(computeTimestampAtSlot(frame.reportProcessingDeadlineSlot));
    expect(procState.dataSubmitted).to.equal(false);
    expect(procState.dataFormat).to.equal(0);
    expect(procState.requestsCount).to.equal(0);
    expect(procState.requestsSubmitted).to.equal(0);
  });

  it("some time passes", async () => {
    await consensus.advanceTimeBy(SECONDS_PER_FRAME / 3n);
  });

  it("non-member cannot submit the data", async () => {
    await expect(oracle.connect(stranger).submitReportData(reportFields, oracleVersion)).to.be.revertedWithCustomError(
      oracle,
      "SenderNotAllowed",
    );
  });

  it("the data cannot be submitted passing a different contract version", async () => {
    await expect(oracle.connect(member1).submitReportData(reportFields, oracleVersion - 1n))
      .to.be.revertedWithCustomError(oracle, "UnexpectedContractVersion")
      .withArgs(oracleVersion, oracleVersion - 1n);
  });

  it("the data cannot be submitted passing a different consensus version", async () => {
    const invalidReport = { ...reportFields, consensusVersion: VEBO_CONSENSUS_VERSION + 1n };
    await expect(oracle.connect(member1).submitReportData(invalidReport, oracleVersion))
      .to.be.revertedWithCustomError(oracle, "UnexpectedConsensusVersion")
      .withArgs(VEBO_CONSENSUS_VERSION, VEBO_CONSENSUS_VERSION + 1n);
  });

  it("a data not matching the consensus hash cannot be submitted", async () => {
    const invalidReport = {
      ...reportFields,
      requestsCount: reportFields.requestsCount + 1,
    };
    const invalidReportHash = calcValidatorsExitBusReportDataHash(invalidReport);

    await expect(oracle.connect(member1).submitReportData(invalidReport, oracleVersion))
      .to.be.revertedWithCustomError(oracle, "UnexpectedDataHash")
      .withArgs(reportHash, invalidReportHash);
  });

  it("a committee member submits the report data, exit requests are emitted", async () => {
    const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);

    await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, reportHash);
    expect((await oracle.getConsensusReport()).processingStarted).to.equal(true);

    const timestamp = await oracle.getTime();

    for (const request of exitRequests) {
      await expect(tx)
        .to.emit(oracle, "ValidatorExitRequest")
        .withArgs(request.moduleId, request.nodeOpId, request.valIndex, request.valPubkey, timestamp);
    }
  });

  it("reports are marked as processed", async () => {
    const frame = await consensus.getCurrentFrame();
    const procState = await oracle.getProcessingState();

    expect(procState.currentFrameRefSlot).to.equal(frame.refSlot);
    expect(procState.dataHash).to.equal(reportHash);
    expect(procState.processingDeadlineTime).to.equal(computeTimestampAtSlot(frame.reportProcessingDeadlineSlot));
    expect(procState.dataSubmitted).to.equal(true);
    expect(procState.dataFormat).to.equal(DATA_FORMAT_LIST);
    expect(procState.requestsCount).to.equal(exitRequests.length);
    expect(procState.requestsSubmitted).to.equal(exitRequests.length);
  });

  it("no data can be submitted for the same reference slot again", async () => {
    await expect(oracle.connect(member2).submitReportData(reportFields, oracleVersion)).to.be.revertedWithCustomError(
      oracle,
      "RefSlotAlreadyProcessing",
    );
  });
});
