import { expect } from "chai";
import { ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, ValidatorsExitBus__Harness, WithdrawalVault__MockForVebo } from "typechain-types";

import { CONSENSUS_VERSION, de0x, numberToHex } from "lib";

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

describe("ValidatorsExitBusOracle.sol:triggerExitHashVerify", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;
  let withdrawalVault: WithdrawalVault__MockForVebo;

  let oracleVersion: bigint;
  let exitRequests: ExitRequest[];
  let reportFields: ReportFields;
  let reportHash: string;

  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;

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

  const deploy = async () => {
    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;
    withdrawalVault = deployed.withdrawalVault;

    await initVEBO({
      admin: admin.address,
      oracle,
      consensus,
      withdrawalVault,
      resumeAfterDeploy: true,
      lastProcessingRefSlot: LAST_PROCESSING_REF_SLOT,
    });

    oracleVersion = await oracle.getContractVersion();

    await consensus.addMember(member1, 1);
    await consensus.addMember(member2, 2);
    await consensus.addMember(member3, 2);
  };

  before(async () => {
    [admin, member1, member2, member3] = await ethers.getSigners();

    await deploy();
  });

  const triggerConsensusOnHash = async (hash: string) => {
    const { refSlot } = await consensus.getCurrentFrame();
    await consensus.connect(member1).submitReport(refSlot, hash, CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, hash, CONSENSUS_VERSION);
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
      { moduleId: 2, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[3] },
    ];

    reportFields = {
      consensusVersion: CONSENSUS_VERSION,
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

  it("last requested validator indices are updated", async () => {
    const indices1 = await oracle.getLastRequestedValidatorIndices(1n, [0n, 1n, 2n, 3n]);
    const indices2 = await oracle.getLastRequestedValidatorIndices(2n, [0n, 1n, 2n, 3n]);

    expect([...indices1]).to.have.ordered.members([2n, -1n, -1n, -1n]);
    expect([...indices2]).to.have.ordered.members([3n, -1n, -1n, -1n]);
  });

  it("someone submitted exit report data and triggered exit", async () => {
    const tx = await oracle.triggerExitHashVerify(reportFields.data, [0, 1, 2, 3], { value: 4 });

    const pubkeys = [PUBKEYS[0], PUBKEYS[1], PUBKEYS[2], PUBKEYS[3]];
    const concatenatedPubKeys = pubkeys.map((pk) => pk.replace(/^0x/, "")).join("");
    await expect(tx)
      .to.emit(withdrawalVault, "AddFullWithdrawalRequestsCalled")
      .withArgs("0x" + concatenatedPubKeys);
  });

  it("someone submitted exit report data and triggered exit on not sequential indexes", async () => {
    const tx = await oracle.triggerExitHashVerify(reportFields.data, [0, 1, 3], { value: 3 });

    const pubkeys = [PUBKEYS[0], PUBKEYS[1], PUBKEYS[3]];
    const concatenatedPubKeys = pubkeys.map((pk) => pk.replace(/^0x/, "")).join("");
    await expect(tx)
      .to.emit(withdrawalVault, "AddFullWithdrawalRequestsCalled")
      .withArgs("0x" + concatenatedPubKeys);
  });

  it("Not enough fee", async () => {
    await expect(oracle.triggerExitHashVerify(reportFields.data, [0, 1], { value: 1 }))
      .to.be.revertedWithCustomError(oracle, "FeeNotEnough")
      .withArgs(1, 2, 1);
  });

  it("Should trigger withdrawals only for validators that were requested for voluntary exit by trusted entities earlier", async () => {
    await expect(
      oracle.triggerExitHashVerify(
        "0x0000030000000000000000000000005a894d712b61ee6d5da473f87d9c8175c4022fd05a8255b6713dc75388b099a85514ceca78a52b9122d09aecda9010c047",
        [0],
        { value: 2 },
      ),
    ).to.be.revertedWithCustomError(oracle, "ExitHashWasNotSubmitted");
  });

  it("Requested index out of range", async () => {
    await expect(oracle.triggerExitHashVerify(reportFields.data, [5], { value: 2 }))
      .to.be.revertedWithCustomError(oracle, "KeyIndexOutOfRange")
      .withArgs(5, 4);
  });
});
