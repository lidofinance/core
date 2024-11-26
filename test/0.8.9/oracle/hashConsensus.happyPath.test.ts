import { expect } from "chai";
import { Signer } from "ethers";
import { ethers } from "hardhat";

import { HashConsensus__Harness, ReportProcessor__Mock } from "typechain-types";

import { CONSENSUS_VERSION, EPOCHS_PER_FRAME, SECONDS_PER_SLOT, SLOTS_PER_EPOCH } from "lib";

import {
  computeEpochFirstSlotAt,
  computeTimestampAtEpoch,
  computeTimestampAtSlot,
  deployHashConsensus,
  HASH_1,
  HASH_2,
  HASH_3,
  SECONDS_PER_EPOCH,
  SECONDS_PER_FRAME,
  SLOTS_PER_FRAME,
  ZERO_HASH,
} from "test/deploy";

const INITIAL_EPOCH = 3n;

describe("HashConsensus.sol:happyPath", function () {
  let admin: Signer;
  let member1: Signer;
  let member2: Signer;
  let member3: Signer;
  let consensus: HashConsensus__Harness;
  let reportProcessor: ReportProcessor__Mock;

  before(async () => {
    [admin, member1, member2, member3] = await ethers.getSigners();
    const deployed = await deployHashConsensus(await admin.getAddress(), { initialEpoch: INITIAL_EPOCH });
    consensus = deployed.consensus;
    reportProcessor = deployed.reportProcessor;
  });

  it("adding members", async () => {
    await consensus.connect(admin).addMember(await member1.getAddress(), 1);
    expect(await consensus.getIsMember(await member1.getAddress())).to.be.true;
    expect(await consensus.getQuorum()).to.equal(1);

    await consensus.connect(admin).addMember(await member2.getAddress(), 2);
    expect(await consensus.getIsMember(await member2.getAddress())).to.be.true;
    expect(await consensus.getQuorum()).to.equal(2);

    await consensus.connect(admin).addMember(await member3.getAddress(), 2);
    expect(await consensus.getIsMember(await member3.getAddress())).to.be.true;
    expect(await consensus.getQuorum()).to.equal(2);
  });

  it("some fraction of the reporting frame passes", async () => {
    expect(await consensus.getTime()).to.equal(computeTimestampAtEpoch(INITIAL_EPOCH));
    await consensus.advanceTimeBySlots(3);
    expect(await consensus.getTime()).to.equal(computeTimestampAtEpoch(INITIAL_EPOCH) + 3n * SECONDS_PER_SLOT);
  });

  let frame: Awaited<ReturnType<typeof consensus.getCurrentFrame>>;

  it("reporting frame changes as more time passes", async () => {
    const frame1 = await consensus.getCurrentFrame();
    const time = BigInt(await consensus.getTime());
    const expectedRefSlot = computeEpochFirstSlotAt(time) - 1n;
    const expectedDeadlineSlot = expectedRefSlot + EPOCHS_PER_FRAME * SLOTS_PER_EPOCH;

    expect(frame1.refSlot).to.equal(expectedRefSlot);
    expect(frame1.reportProcessingDeadlineSlot).to.equal(expectedDeadlineSlot);

    await consensus.advanceTimeBy(SECONDS_PER_FRAME);
    const frame2 = await consensus.getCurrentFrame();

    expect(frame2.refSlot).to.equal(expectedRefSlot + SLOTS_PER_FRAME);
    expect(frame2.reportProcessingDeadlineSlot).to.equal(expectedDeadlineSlot + SLOTS_PER_FRAME);

    frame = frame2;
  });

  it("first member votes for hash 3", async () => {
    const { canReport } = await consensus.getConsensusStateForMember(await member1.getAddress());
    expect(canReport).to.be.true;

    const tx = await consensus.connect(member1).submitReport(frame.refSlot, HASH_3, CONSENSUS_VERSION);

    await expect(tx)
      .to.emit(consensus, "ReportReceived")
      .withArgs(frame.refSlot, await member1.getAddress(), HASH_3);
    await expect(tx).not.to.emit(consensus, "ConsensusReached");

    const memberInfo = await consensus.getConsensusStateForMember(await member1.getAddress());
    expect(memberInfo.isMember).to.be.true;
    expect(memberInfo.lastMemberReportRefSlot).to.equal(frame.refSlot);
    expect(memberInfo.currentFrameRefSlot).to.equal(frame.refSlot);
    expect(memberInfo.currentFrameMemberReport).to.equal(HASH_3);
    expect(memberInfo.canReport).to.be.true;
  });

  it("consensus is not reached", async () => {
    const consensusState = await consensus.getConsensusState();
    expect(consensusState.consensusReport).to.equal(ZERO_HASH);
    expect(consensusState.isReportProcessing).to.be.false;
    expect((await reportProcessor.getLastCall_submitReport()).callCount).to.equal(0);
    expect((await reportProcessor.getLastCall_discardReport()).callCount).to.equal(0);

    const memberInfo = await consensus.getConsensusStateForMember(await member1.getAddress());
    expect(memberInfo.currentFrameConsensusReport).to.equal(ZERO_HASH);
  });

  it("second member votes for hash 1", async () => {
    await consensus.advanceTimeBy(SECONDS_PER_EPOCH + 70n);

    const { canReport } = await consensus.getConsensusStateForMember(await member2.getAddress());
    expect(canReport).to.be.true;

    const tx = await consensus.connect(member2).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);

    await expect(tx)
      .to.emit(consensus, "ReportReceived")
      .withArgs(frame.refSlot, await member2.getAddress(), HASH_1);
    await expect(tx).not.to.emit(consensus, "ConsensusReached");

    const memberInfo = await consensus.getConsensusStateForMember(await member2.getAddress());
    expect(memberInfo.isMember).to.be.true;
    expect(memberInfo.lastMemberReportRefSlot).to.equal(frame.refSlot);
    expect(memberInfo.currentFrameRefSlot).to.equal(frame.refSlot);
    expect(memberInfo.currentFrameMemberReport).to.equal(HASH_1);
    expect(memberInfo.canReport).to.be.true;
  });

  it("consensus is not reached", async () => {
    const consensusState = await consensus.getConsensusState();
    expect(consensusState.consensusReport).to.equal(ZERO_HASH);
    expect(consensusState.isReportProcessing).to.be.false;
    expect((await reportProcessor.getLastCall_submitReport()).callCount).to.equal(0);
    expect((await reportProcessor.getLastCall_discardReport()).callCount).to.equal(0);

    const memberInfo = await consensus.getConsensusStateForMember(await member1.getAddress());
    expect(memberInfo.currentFrameConsensusReport).to.equal(ZERO_HASH);
  });

  it("third member votes for hash 3", async () => {
    await consensus.advanceTimeBy(SECONDS_PER_EPOCH + 5n);

    const { canReport } = await consensus.getConsensusStateForMember(await member3.getAddress());
    expect(canReport).to.be.true;

    const tx = await consensus.connect(member3).submitReport(frame.refSlot, HASH_3, CONSENSUS_VERSION);

    await expect(tx)
      .to.emit(consensus, "ReportReceived")
      .withArgs(frame.refSlot, await member3.getAddress(), HASH_3);
    await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(frame.refSlot, HASH_3, 2);

    const memberInfo = await consensus.getConsensusStateForMember(await member3.getAddress());
    expect(memberInfo.isMember).to.be.true;
    expect(memberInfo.lastMemberReportRefSlot).to.equal(frame.refSlot);
    expect(memberInfo.currentFrameRefSlot).to.equal(frame.refSlot);
    expect(memberInfo.currentFrameMemberReport).to.equal(HASH_3);
    expect(memberInfo.canReport).to.be.true;
  });

  it("consensus is reached", async () => {
    const consensusState = await consensus.getConsensusState();
    expect(consensusState.consensusReport).to.equal(HASH_3);
    expect(consensusState.isReportProcessing).to.be.false;

    const memberInfo = await consensus.getConsensusStateForMember(await member1.getAddress());
    expect(memberInfo.currentFrameConsensusReport).to.equal(HASH_3);

    const submitReportLastCall = await reportProcessor.getLastCall_submitReport();
    expect(submitReportLastCall.callCount).to.equal(1);
    expect(submitReportLastCall.report).to.equal(HASH_3);
    expect(submitReportLastCall.refSlot).to.equal(frame.refSlot);
    expect(submitReportLastCall.deadline).to.equal(computeTimestampAtSlot(frame.reportProcessingDeadlineSlot));

    expect((await reportProcessor.getLastCall_discardReport()).callCount).to.equal(0);
  });

  it("first member re-votes for hash 1", async () => {
    await consensus.advanceTimeBy(SECONDS_PER_EPOCH + 5n);
    const { canReport } = await consensus.getConsensusStateForMember(await member1.getAddress());
    expect(canReport).to.be.true;

    const tx = await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
    await expect(tx)
      .to.emit(consensus, "ReportReceived")
      .withArgs(frame.refSlot, await member1.getAddress(), HASH_1);
    await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(frame.refSlot, HASH_1, 2);

    const memberInfo = await consensus.getConsensusStateForMember(await member1.getAddress());
    expect(memberInfo.isMember).to.be.true;
    expect(memberInfo.lastMemberReportRefSlot).to.equal(frame.refSlot);
    expect(memberInfo.currentFrameRefSlot).to.equal(frame.refSlot);
    expect(memberInfo.currentFrameMemberReport).to.equal(HASH_1);
    expect(memberInfo.canReport).to.be.true;
  });

  it("new consensus is reached", async () => {
    const consensusState = await consensus.getConsensusState();
    expect(consensusState.consensusReport).to.equal(HASH_1);
    expect(consensusState.isReportProcessing).to.be.false;

    const memberInfo = await consensus.getConsensusStateForMember(await member1.getAddress());
    expect(memberInfo.currentFrameConsensusReport).to.equal(HASH_1);

    const submitReportLastCall = await reportProcessor.getLastCall_submitReport();
    expect(submitReportLastCall.callCount).to.equal(2);
    expect(submitReportLastCall.report).to.equal(HASH_1);
    expect(submitReportLastCall.refSlot).to.equal(frame.refSlot);
    expect(submitReportLastCall.deadline).to.equal(computeTimestampAtSlot(frame.reportProcessingDeadlineSlot));

    expect((await reportProcessor.getLastCall_discardReport()).callCount).to.equal(0);
  });

  it("second member re-votes for hash 2", async () => {
    await consensus.advanceTimeBy(SECONDS_PER_EPOCH + 5n);
    const { canReport } = await consensus.getConsensusStateForMember(await member2.getAddress());
    expect(canReport).to.be.true;

    const tx = await consensus.connect(member2).submitReport(frame.refSlot, HASH_2, CONSENSUS_VERSION);
    await expect(tx)
      .to.emit(consensus, "ReportReceived")
      .withArgs(frame.refSlot, await member2.getAddress(), HASH_2);
    await expect(tx).to.emit(consensus, "ConsensusLost").withArgs(frame.refSlot);

    const memberInfo = await consensus.getConsensusStateForMember(await member2.getAddress());
    expect(memberInfo.isMember).to.be.true;
    expect(memberInfo.lastMemberReportRefSlot).to.equal(frame.refSlot);
    expect(memberInfo.currentFrameRefSlot).to.equal(frame.refSlot);
    expect(memberInfo.currentFrameMemberReport).to.equal(HASH_2);
    expect(memberInfo.canReport).to.be.true;
  });

  it("consensus is lost", async () => {
    const consensusState = await consensus.getConsensusState();
    expect(consensusState.consensusReport).to.equal(ZERO_HASH);
    expect(consensusState.isReportProcessing).to.be.false;

    const memberInfo = await consensus.getConsensusStateForMember(await member1.getAddress());
    expect(memberInfo.currentFrameConsensusReport).to.equal(ZERO_HASH);

    const submitReportLastCall = await reportProcessor.getLastCall_submitReport();
    expect(submitReportLastCall.callCount).to.equal(2);

    const discardReportLastCall = await reportProcessor.getLastCall_discardReport();
    expect(discardReportLastCall.callCount).to.equal(1);
    expect(discardReportLastCall.refSlot).to.equal(frame.refSlot);
  });

  it("second member re-votes for hash 1", async () => {
    await consensus.advanceTimeBy(SECONDS_PER_EPOCH + 5n);

    const { canReport } = await consensus.getConsensusStateForMember(await member2.getAddress());
    expect(canReport).to.be.true;

    const tx = await consensus.connect(member2).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
    await expect(tx)
      .to.emit(consensus, "ReportReceived")
      .withArgs(frame.refSlot, await member2.getAddress(), HASH_1);
    await expect(tx).to.emit(consensus, "ConsensusReached").withArgs(frame.refSlot, HASH_1, 2);

    const memberInfo = await consensus.getConsensusStateForMember(await member2.getAddress());
    expect(memberInfo.isMember).to.be.true;
    expect(memberInfo.lastMemberReportRefSlot).to.equal(frame.refSlot);
    expect(memberInfo.currentFrameRefSlot).to.equal(frame.refSlot);
    expect(memberInfo.currentFrameMemberReport).to.equal(HASH_1);
    expect(memberInfo.canReport).to.be.true;
  });

  it("consensus is reached again", async () => {
    const consensusState = await consensus.getConsensusState();
    expect(consensusState.consensusReport).to.equal(HASH_1);
    expect(consensusState.isReportProcessing).to.be.false;

    const memberInfo = await consensus.getConsensusStateForMember(await member1.getAddress());
    expect(memberInfo.currentFrameConsensusReport).to.equal(HASH_1);

    const submitReportLastCall = await reportProcessor.getLastCall_submitReport();
    expect(submitReportLastCall.callCount).to.equal(3);
    expect(submitReportLastCall.report).to.equal(HASH_1);
    expect(submitReportLastCall.refSlot).to.equal(frame.refSlot);
    expect(submitReportLastCall.deadline).to.equal(computeTimestampAtSlot(frame.reportProcessingDeadlineSlot));

    expect((await reportProcessor.getLastCall_discardReport()).callCount).to.equal(1);
  });

  it("report processor starts processing the report", async () => {
    await consensus.advanceTimeBy(SECONDS_PER_EPOCH + 33n);

    await reportProcessor.startReportProcessing();

    const consensusState = await consensus.getConsensusState();
    expect(consensusState.consensusReport).to.equal(HASH_1);
    expect(consensusState.isReportProcessing).to.be.true;
  });

  it("second member cannot change their vote anymore", async () => {
    await consensus.advanceTimeBy(SECONDS_PER_EPOCH + 70n);
    const { canReport } = await consensus.getConsensusStateForMember(await member2.getAddress());
    expect(canReport).to.be.false;

    await expect(
      consensus.connect(member2).submitReport(frame.refSlot, HASH_3, CONSENSUS_VERSION),
    ).to.be.revertedWithCustomError(consensus, "ConsensusReportAlreadyProcessing()");
  });

  let prevFrame: Awaited<ReturnType<typeof consensus.getCurrentFrame>>;
  let newFrame: Awaited<ReturnType<typeof consensus.getCurrentFrame>>;

  it("time passes, a new frame starts", async () => {
    await consensus.advanceTimeBy(SECONDS_PER_FRAME);

    prevFrame = frame;
    newFrame = await consensus.getCurrentFrame();
    expect(newFrame.refSlot).to.equal(prevFrame.refSlot + SLOTS_PER_FRAME);

    const consensusState = await consensus.getConsensusState();
    expect(consensusState.consensusReport).to.equal(ZERO_HASH);
    expect(consensusState.isReportProcessing).to.be.false;

    const checkMember = async (member: Signer) => {
      const memberInfo = await consensus.getConsensusStateForMember(await member.getAddress());
      expect(memberInfo.currentFrameRefSlot).to.equal(newFrame.refSlot);
      expect(memberInfo.currentFrameConsensusReport).to.equal(ZERO_HASH);
      expect(memberInfo.isMember).to.be.true;
      expect(memberInfo.lastMemberReportRefSlot).to.equal(prevFrame.refSlot);
      expect(memberInfo.currentFrameMemberReport).to.equal(ZERO_HASH);
      expect(memberInfo.canReport).to.be.true;
    };

    await checkMember(member1);
    await checkMember(member2);
    await checkMember(member3);

    expect((await reportProcessor.getLastCall_submitReport()).callCount).to.equal(3);
    expect((await reportProcessor.getLastCall_discardReport()).callCount).to.equal(1);
  });

  it("a member cannot submit report for the previous ref slot", async () => {
    await expect(
      consensus.connect(member1).submitReport(prevFrame.refSlot, HASH_2, CONSENSUS_VERSION),
    ).to.be.revertedWithCustomError(consensus, "InvalidSlot()");
  });

  it("a member cannot submit report for a non-reference slot", async () => {
    await expect(
      consensus.connect(member1).submitReport(newFrame.refSlot - 1n, HASH_2, CONSENSUS_VERSION),
    ).to.be.revertedWithCustomError(consensus, "InvalidSlot()");
    await expect(
      consensus.connect(member1).submitReport(newFrame.refSlot + 1n, HASH_2, CONSENSUS_VERSION),
    ).to.be.revertedWithCustomError(consensus, "InvalidSlot()");
  });

  it("first member votes for hash 2", async () => {
    const tx = await consensus.connect(member1).submitReport(newFrame.refSlot, HASH_2, CONSENSUS_VERSION);

    await expect(tx)
      .to.emit(consensus, "ReportReceived")
      .withArgs(newFrame.refSlot, await member1.getAddress(), HASH_2);
    await expect(tx).not.to.emit(consensus, "ConsensusReached");

    const memberInfo = await consensus.getConsensusStateForMember(await member1.getAddress());
    expect(memberInfo.isMember).to.be.true;
    expect(memberInfo.lastMemberReportRefSlot).to.equal(newFrame.refSlot);
    expect(memberInfo.currentFrameRefSlot).to.equal(newFrame.refSlot);
    expect(memberInfo.currentFrameMemberReport).to.equal(HASH_2);
    expect(memberInfo.canReport).to.be.true;
  });

  it("consensus is not reached", async () => {
    const consensusState = await consensus.getConsensusState();
    expect(consensusState.consensusReport).to.equal(ZERO_HASH);
    expect(consensusState.isReportProcessing).to.be.false;
    expect((await reportProcessor.getLastCall_submitReport()).callCount).to.equal(3);
    expect((await reportProcessor.getLastCall_discardReport()).callCount).to.equal(1);

    const memberInfo = await consensus.getConsensusStateForMember(await member1.getAddress());
    expect(memberInfo.currentFrameConsensusReport).to.equal(ZERO_HASH);
  });
});
