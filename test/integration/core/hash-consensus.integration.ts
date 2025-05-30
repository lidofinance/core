import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus } from "typechain-types";

import { ether, impersonate } from "lib";
import {
  calcReportDataHash,
  getProtocolContext,
  getReportDataItems,
  ProtocolContext,
  report,
  waitNextAvailableReportTime,
} from "lib/protocol";

import { Snapshot, ZERO_HASH } from "test/suite";

const UINT64_MAX = 2n ** 64n - 1n;

describe("Hash consensus negative scenarios", () => {
  let ctx: ProtocolContext;
  let stranger: HardhatEthersSigner;
  let hashConsensus: HashConsensus;
  let agent: HardhatEthersSigner;

  let snapshot: string;
  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();
    hashConsensus = ctx.contracts.hashConsensus;
    [stranger] = await ethers.getSigners();
    agent = await ctx.getSigner("agent");
    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  it("Should not allow updating initial epoch after initialization", async () => {
    await expect(hashConsensus.connect(agent).updateInitialEpoch(1)).to.be.revertedWithCustomError(
      hashConsensus,
      "InitialEpochAlreadyArrived",
    );
  });

  it("Should validate frame config parameters", async () => {
    // Grant MANAGE_FRAME_CONFIG_ROLE to stranger
    const MANAGE_FRAME_CONFIG_ROLE = await hashConsensus.MANAGE_FRAME_CONFIG_ROLE();
    await hashConsensus.connect(agent).grantRole(MANAGE_FRAME_CONFIG_ROLE, stranger.address);

    // Get slots per epoch from chain config
    const [slotsPerEpoch] = await hashConsensus.getChainConfig();

    // Test epochs per frame cannot be zero
    await expect(hashConsensus.connect(stranger).setFrameConfig(0, 1)).to.be.revertedWithCustomError(
      hashConsensus,
      "EpochsPerFrameCannotBeZero",
    );

    // Test fast lane period cannot be longer than frame
    const epochsPerFrame = 2n;
    await expect(
      hashConsensus.connect(stranger).setFrameConfig(epochsPerFrame, epochsPerFrame * slotsPerEpoch + 1n),
    ).to.be.revertedWithCustomError(hashConsensus, "FastLanePeriodCannotBeLongerThanFrame");
  });

  it("Should validate fast lane length slots parameter", async () => {
    // Grant MANAGE_FAST_LANE_CONFIG_ROLE to stranger
    const MANAGE_FAST_LANE_CONFIG_ROLE = await hashConsensus.MANAGE_FAST_LANE_CONFIG_ROLE();
    await hashConsensus.connect(agent).grantRole(MANAGE_FAST_LANE_CONFIG_ROLE, stranger.address);

    // Get chain config and frame config
    const [slotsPerEpoch] = await hashConsensus.getChainConfig();
    const [, epochsPerFrame] = await hashConsensus.getFrameConfig();

    // Test fast lane period cannot be longer than frame
    await expect(
      hashConsensus.connect(stranger).setFastLaneLengthSlots(epochsPerFrame * slotsPerEpoch + 1n),
    ).to.be.revertedWithCustomError(hashConsensus, "FastLanePeriodCannotBeLongerThanFrame");
  });

  it("Should validate member addition", async () => {
    // Grant MANAGE_MEMBERS_AND_QUORUM_ROLE to stranger
    const MANAGE_MEMBERS_AND_QUORUM_ROLE = await hashConsensus.MANAGE_MEMBERS_AND_QUORUM_ROLE();
    await hashConsensus.connect(agent).grantRole(MANAGE_MEMBERS_AND_QUORUM_ROLE, stranger.address);

    const currentQuorum = await hashConsensus.getQuorum();
    const [members] = await hashConsensus.getMembers();

    // Test cannot add duplicate member
    await expect(hashConsensus.connect(stranger).addMember(members[0], currentQuorum)).to.be.revertedWithCustomError(
      hashConsensus,
      "DuplicateMember",
    );

    // Test cannot add zero address
    await expect(hashConsensus.connect(stranger).addMember(ZeroAddress, currentQuorum)).to.be.revertedWithCustomError(
      hashConsensus,
      "AddressCannotBeZero",
    );

    // Test quorum must be greater than half members + 1
    const requiredQuorum = Math.floor((members.length + 1) / 2) + 1;
    await expect(hashConsensus.connect(stranger).addMember(stranger.address, requiredQuorum - 1))
      .to.be.revertedWithCustomError(hashConsensus, "QuorumTooSmall")
      .withArgs(requiredQuorum, requiredQuorum - 1);
  });

  it("Should validate member removal", async () => {
    // Grant MANAGE_MEMBERS_AND_QUORUM_ROLE to stranger
    const MANAGE_MEMBERS_AND_QUORUM_ROLE = await hashConsensus.MANAGE_MEMBERS_AND_QUORUM_ROLE();
    await hashConsensus.connect(agent).grantRole(MANAGE_MEMBERS_AND_QUORUM_ROLE, stranger.address);

    const [members] = await hashConsensus.getMembers();

    // Test cannot remove non-member
    await expect(hashConsensus.connect(stranger).removeMember(stranger.address, 1n)).to.be.revertedWithCustomError(
      hashConsensus,
      "NonMember",
    );

    // Test quorum must be greater than half members - 1
    const requiredQuorum = Math.floor((members.length - 1) / 2) + 1; // -1 for the removed member
    await expect(hashConsensus.connect(stranger).removeMember(members[0], requiredQuorum - 1))
      .to.be.revertedWithCustomError(hashConsensus, "QuorumTooSmall")
      .withArgs(requiredQuorum, requiredQuorum - 1);
  });

  it("Should validate quorum updates", async () => {
    // Grant MANAGE_MEMBERS_AND_QUORUM_ROLE to stranger
    const MANAGE_MEMBERS_AND_QUORUM_ROLE = await hashConsensus.MANAGE_MEMBERS_AND_QUORUM_ROLE();
    await hashConsensus.connect(agent).grantRole(MANAGE_MEMBERS_AND_QUORUM_ROLE, stranger.address);

    const [members] = await hashConsensus.getMembers();

    // Test quorum must be greater than half members
    const requiredQuorum = Math.floor(members.length / 2) + 1;
    await expect(hashConsensus.connect(stranger).setQuorum(requiredQuorum - 1))
      .to.be.revertedWithCustomError(hashConsensus, "QuorumTooSmall")
      .withArgs(requiredQuorum, requiredQuorum - 1);
  });

  it("Should validate report processor updates", async () => {
    // Grant MANAGE_REPORT_PROCESSOR_ROLE to stranger
    const MANAGE_REPORT_PROCESSOR_ROLE = await hashConsensus.MANAGE_REPORT_PROCESSOR_ROLE();
    await hashConsensus.connect(agent).grantRole(MANAGE_REPORT_PROCESSOR_ROLE, stranger.address);

    const prevReportProcessor = await hashConsensus.getReportProcessor();

    // Test cannot set zero address
    await expect(hashConsensus.connect(stranger).setReportProcessor(ZeroAddress)).to.be.revertedWithCustomError(
      hashConsensus,
      "ReportProcessorCannotBeZero",
    );

    // Test cannot set same address
    await expect(hashConsensus.connect(stranger).setReportProcessor(prevReportProcessor)).to.be.revertedWithCustomError(
      hashConsensus,
      "NewProcessorCannotBeTheSame",
    );
  });

  it("Should validate report submission", async () => {
    await waitNextAvailableReportTime(ctx);

    const { accountingOracle } = ctx.contracts;

    const consensusVersion = await accountingOracle.getConsensusVersion();
    const contractVersion = await accountingOracle.getContractVersion();

    const [members] = await hashConsensus.getMembers();
    const member = members[0];
    const memberSigner = await impersonate(member, ether("1"));

    async function getLanesMembers() {
      const [fastLaneMembers] = await hashConsensus.getFastLaneMembers();
      const nonFastLaneMembers = members.filter((m) => !fastLaneMembers.includes(m));
      return { fastLaneMembers, nonFastLaneMembers };
    }

    const { data: reportData } = await report(ctx, { clDiff: 1234567n, dryRun: true });

    const items = getReportDataItems(reportData);
    const reportHash = calcReportDataHash(items);

    // Test cannot submit with invalid slot
    await expect(
      hashConsensus.connect(memberSigner).submitReport(0n, reportHash, consensusVersion),
    ).to.be.revertedWithCustomError(hashConsensus, "InvalidSlot");

    // Test numeric overflow
    await expect(
      hashConsensus.connect(memberSigner).submitReport(UINT64_MAX + 1n, reportHash, consensusVersion),
    ).to.be.revertedWithCustomError(hashConsensus, "NumericOverflow");

    // Test empty report
    await expect(
      hashConsensus.connect(memberSigner).submitReport(1n, ZERO_HASH, consensusVersion),
    ).to.be.revertedWithCustomError(hashConsensus, "EmptyReport");

    // Test non-member cannot submit
    await expect(
      hashConsensus.connect(stranger).submitReport(1n, reportHash, consensusVersion),
    ).to.be.revertedWithCustomError(hashConsensus, "NonMember");

    // Test unexpected consensus version
    await expect(hashConsensus.connect(memberSigner).submitReport(1n, reportHash, consensusVersion + 1n))
      .to.be.revertedWithCustomError(hashConsensus, "UnexpectedConsensusVersion")
      .withArgs(consensusVersion, consensusVersion + 1n);

    // Test invalid slot
    await expect(
      hashConsensus.connect(memberSigner).submitReport(1n, reportHash, consensusVersion),
    ).to.be.revertedWithCustomError(hashConsensus, "InvalidSlot");

    // Test reaching consensus
    const { refSlot } = await hashConsensus.getCurrentFrame();

    const { fastLaneMembers } = await getLanesMembers();

    const fastLaneMember = fastLaneMembers[0];
    const fastLaneMemberSigner = await impersonate(fastLaneMember, ether("1"));

    for (const m of fastLaneMembers) {
      const mSigner = await impersonate(m, ether("1"));
      await hashConsensus.connect(mSigner).submitReport(refSlot, reportHash, consensusVersion);
    }

    // Test duplicate report
    await expect(
      hashConsensus.connect(fastLaneMemberSigner).submitReport(refSlot, reportHash, consensusVersion),
    ).to.be.revertedWithCustomError(hashConsensus, "DuplicateReport");

    await accountingOracle.connect(memberSigner).submitReportData(reportData, contractVersion);

    await expect(
      hashConsensus.connect(fastLaneMemberSigner).submitReport(refSlot, reportHash, consensusVersion),
    ).to.be.revertedWithCustomError(hashConsensus, "ConsensusReportAlreadyProcessing");

    await waitNextAvailableReportTime(ctx);

    const { nonFastLaneMembers } = await getLanesMembers();
    expect(nonFastLaneMembers.length).to.be.gt(0);

    // Test non-fast lane member cannot report within fast lane interval
    const { refSlot: newRefSlot } = await hashConsensus.getCurrentFrame();
    await expect(
      hashConsensus
        .connect(await impersonate(nonFastLaneMembers[0], ether("1")))
        .submitReport(newRefSlot, reportHash, consensusVersion),
    ).to.be.revertedWithCustomError(hashConsensus, "NonFastLaneMemberCannotReportWithinFastLaneInterval");
  });
});
