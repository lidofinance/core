import { expect } from "chai";
import { ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  HashConsensus__Harness,
  TriggerableWithdrawalsBus__MockForWithdrawalsOracle,
  WithdrawalsOracle__Harness,
} from "typechain-types";

import { WITHDRAWALS_ORACLE_CONSENSUS_VERSION } from "lib";

import {
  calcWithdrawalsOracleReportDataHash,
  computeTimestampAtSlot,
  deployWithdrawalsOracle,
  encodeWithdrawalRequests,
  initWithdrawalsOracle,
  makeMockPubkey,
  SECONDS_PER_FRAME,
  SLOTS_PER_FRAME,
  WithdrawalRequest,
  WithdrawalsOracleReportFields,
} from "test/deploy";

const GWEI_PER_ETH = 10n ** 9n;

describe("WithdrawalsOracle.sol:happyPath", () => {
  let consensus: HashConsensus__Harness;
  let oracle: WithdrawalsOracle__Harness;
  let triggerableWithdrawalsBus: TriggerableWithdrawalsBus__MockForWithdrawalsOracle;
  let admin: HardhatEthersSigner;

  let oracleVersion: bigint;
  let requests: WithdrawalRequest[];
  let reportFields: WithdrawalsOracleReportFields;
  let reportHash: string;

  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const LAST_PROCESSING_REF_SLOT = 1;

  before(async () => {
    [admin, member1, member2, member3, stranger] = await ethers.getSigners();

    const deployed = await deployWithdrawalsOracle(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;
    triggerableWithdrawalsBus = deployed.triggerableWithdrawalsBus;

    // module 2 has 0x02 withdrawal credentials and accepts partial withdrawals
    await deployed.stakingRouter.setStakingModulePartialWithdrawalsAllowed(2, true);

    await initWithdrawalsOracle({
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
    await consensus.connect(member1).submitReport(refSlot, hash, WITHDRAWALS_ORACLE_CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, hash, WITHDRAWALS_ORACLE_CONSENSUS_VERSION);
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
  });

  it("reference slot of the empty initial consensus report is set to the last processing slot passed to the initialize function", async () => {
    const report = await oracle.getConsensusReport();
    expect(report.refSlot).to.equal(LAST_PROCESSING_REF_SLOT);
  });

  it("committee reaches consensus on a report hash", async () => {
    const { refSlot } = await consensus.getCurrentFrame();

    requests = [
      { moduleId: 1, nodeOpId: 0, keyIndex: 0, amount: 0n }, // FWR, 0x01 module
      { moduleId: 2, nodeOpId: 0, keyIndex: 2, amount: 16n * GWEI_PER_ETH }, // PWR, 0x02 module
      { moduleId: 1, nodeOpId: 0, keyIndex: 1, amount: 0n }, // FWR, 0x01 module
    ];

    reportFields = {
      consensusVersion: WITHDRAWALS_ORACLE_CONSENSUS_VERSION,
      refSlot: refSlot,
      requestsCount: requests.length,
      data: encodeWithdrawalRequests(requests),
    };

    reportHash = calcWithdrawalsOracleReportDataHash(reportFields);

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
    const invalidReport = { ...reportFields, consensusVersion: WITHDRAWALS_ORACLE_CONSENSUS_VERSION + 1n };
    await expect(oracle.connect(member1).submitReportData(invalidReport, oracleVersion))
      .to.be.revertedWithCustomError(oracle, "UnexpectedConsensusVersion")
      .withArgs(WITHDRAWALS_ORACLE_CONSENSUS_VERSION, WITHDRAWALS_ORACLE_CONSENSUS_VERSION + 1n);
  });

  it("a data not matching the consensus hash cannot be submitted", async () => {
    const invalidReport = {
      ...reportFields,
      requestsCount: reportFields.requestsCount + 1,
    };
    const invalidReportHash = calcWithdrawalsOracleReportDataHash(invalidReport);

    await expect(oracle.connect(member1).submitReportData(invalidReport, oracleVersion))
      .to.be.revertedWithCustomError(oracle, "UnexpectedDataHash")
      .withArgs(reportHash, invalidReportHash);
  });

  it("a committee member submits the report data, withdrawal intents are queued", async () => {
    const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);

    await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, reportHash);
    expect((await oracle.getConsensusReport()).processingStarted).to.equal(true);

    for (const { moduleId, nodeOpId, keyIndex, amount } of requests) {
      await expect(tx)
        .to.emit(oracle, "WithdrawalRequested")
        .withArgs(moduleId, nodeOpId, makeMockPubkey(nodeOpId, keyIndex), amount);
    }

    const intents = await triggerableWithdrawalsBus.getWithdrawalIntents();
    expect(intents.length).to.equal(requests.length);
    intents.forEach((intent, i) => {
      const { nodeOpId, keyIndex, amount } = requests[i];
      expect(intent.amount).to.equal(amount);
      expect(intent.pubkey).to.equal(makeMockPubkey(nodeOpId, keyIndex));
    });
  });

  it("reports are marked as processed", async () => {
    const frame = await consensus.getCurrentFrame();
    const procState = await oracle.getProcessingState();

    expect(procState.currentFrameRefSlot).to.equal(frame.refSlot);
    expect(procState.dataHash).to.equal(reportHash);
    expect(procState.processingDeadlineTime).to.equal(computeTimestampAtSlot(frame.reportProcessingDeadlineSlot));
    expect(procState.dataSubmitted).to.equal(true);
  });

  it("no data can be submitted for the same reference slot again", async () => {
    await expect(oracle.connect(member2).submitReportData(reportFields, oracleVersion)).to.be.revertedWithCustomError(
      oracle,
      "RefSlotAlreadyProcessing",
    );
  });
});
