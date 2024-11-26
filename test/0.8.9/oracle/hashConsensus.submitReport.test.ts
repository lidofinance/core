import { expect } from "chai";
import { Signer } from "ethers";
import { ethers } from "hardhat";

import { HashConsensus__Harness, ReportProcessor__Mock } from "typechain-types";

import { CONSENSUS_VERSION } from "lib";

import { deployHashConsensus, HASH_1, HASH_2, ZERO_HASH } from "test/deploy";
import { Snapshot } from "test/suite";

const CONSENSUS_VERSION_NEW = 3n;

describe("HashConsensus.sol:submitReport", function () {
  let admin: Signer;
  let member1: Signer;
  let member2: Signer;
  let consensus: HashConsensus__Harness;
  let reportProcessor: ReportProcessor__Mock;
  let frame: Awaited<ReturnType<typeof consensus.getCurrentFrame>>;
  let originalState: string;

  const deploy = async (options = { epochsPerFrame: 200n }) => {
    [admin, member1, member2] = await ethers.getSigners();
    const deployed = await deployHashConsensus(await admin.getAddress(), options);
    consensus = deployed.consensus;
    reportProcessor = deployed.reportProcessor;
    frame = await consensus.getCurrentFrame();
    await consensus.addMember(await member1.getAddress(), 1);
  };

  before(deploy);

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("method submitReport", () => {
    it("reverts with NumericOverflow if slot is greater than max allowed", async () => {
      await expect(
        consensus.connect(member1).submitReport("20446744073709551615", HASH_1, CONSENSUS_VERSION),
      ).to.be.revertedWithCustomError(consensus, "NumericOverflow()");
    });

    it("reverts with InvalidSlot if slot is zero", async () => {
      await expect(consensus.connect(member1).submitReport(0, HASH_1, CONSENSUS_VERSION)).to.be.revertedWithCustomError(
        consensus,
        "InvalidSlot()",
      );
    });

    it("reverts with UnexpectedConsensusVersion", async () => {
      await expect(consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION_NEW))
        .to.be.revertedWithCustomError(consensus, "UnexpectedConsensusVersion")
        .withArgs(CONSENSUS_VERSION, CONSENSUS_VERSION_NEW);
    });

    it("reverts with EmptyReport", async () => {
      await expect(
        consensus.connect(member1).submitReport(frame.refSlot, ZERO_HASH, CONSENSUS_VERSION),
      ).to.be.revertedWithCustomError(consensus, "EmptyReport()");
    });

    it("reverts with ConsensusReportAlreadyProcessing", async () => {
      await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
      await reportProcessor.startReportProcessing();
      await expect(
        consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION),
      ).to.be.revertedWithCustomError(consensus, "ConsensusReportAlreadyProcessing()");
    });

    it("reverts with DuplicateReport", async () => {
      await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
      await expect(
        consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION),
      ).to.be.revertedWithCustomError(consensus, "DuplicateReport()");
    });

    it("does not revert with ConsensusReportAlreadyProcessing if member has not sent a report for this slot", async () => {
      await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
      await reportProcessor.startReportProcessing();
      await consensus.addMember(await member2.getAddress(), 2);
      await expect(consensus.connect(member2).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION)).not.to.be
        .reverted;
    });

    it("consensus loss on conflicting report submit", async () => {
      await consensus.addMember(await member2.getAddress(), 2);
      await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
      const tx1 = await consensus.connect(member2).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
      await expect(tx1).to.emit(consensus, "ConsensusReached");
      const tx2 = await consensus.connect(member2).submitReport(frame.refSlot, HASH_2, CONSENSUS_VERSION);
      await expect(tx2).to.emit(consensus, "ConsensusLost");
    });
  });
});
