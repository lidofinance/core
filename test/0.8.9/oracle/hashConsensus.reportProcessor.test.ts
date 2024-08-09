import { expect } from "chai";
import { Signer, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HashConsensusTimeTravellable, MockReportProcessor, MockReportProcessor__factory } from "typechain-types";

import { CONSENSUS_VERSION, streccak } from "lib";

import { deployHashConsensus, HASH_1, HASH_2 } from "test/deploy";
import { Snapshot } from "test/suite";

const manageReportProcessorRoleKeccak256 = streccak("MANAGE_REPORT_PROCESSOR_ROLE");

describe("HashConsensus:reportProcessor", function() {
  let admin: Signer;
  let member1: Signer;
  let member2: Signer;
  let stranger: Signer;

  let consensus: HashConsensusTimeTravellable;
  let reportProcessor1: MockReportProcessor;
  let reportProcessor2: MockReportProcessor;

  let snapshot: string;

  const deploy = async () => {
    [admin, member1, member2, stranger] = await ethers.getSigners();
    const deployed = await deployHashConsensus(await admin.getAddress());
    consensus = deployed.consensus;
    reportProcessor1 = deployed.reportProcessor;

    reportProcessor2 = await new MockReportProcessor__factory(admin).deploy(CONSENSUS_VERSION);

    snapshot = await Snapshot.take();
  };

  const rollback = async () => {
    snapshot = await Snapshot.refresh(snapshot);
  };

  before(deploy);

  describe("initial setup", () => {
    afterEach(rollback);

    it("properly set initial report processor", async () => {
      expect(await consensus.getReportProcessor()).to.equal(
        await reportProcessor1.getAddress(),
        "processor address differs",
      );
    });
  });

  describe("method setReportProcessor", () => {
    afterEach(rollback);

    it("checks next processor is not zero", async () => {
      await expect(consensus.setReportProcessor(ZeroAddress)).to.be.revertedWithCustomError(
        consensus,
        "ReportProcessorCannotBeZero()",
      );
    });

    it("checks next processor is not the same as previous", async () => {
      await expect(consensus.setReportProcessor(await reportProcessor1.getAddress())).to.be.revertedWithCustomError(
        consensus,
        "NewProcessorCannotBeTheSame()",
      );
    });

    it("checks tx sender for MANAGE_REPORT_PROCESSOR_ROLE", async () => {
      await expect(consensus.connect(stranger).setReportProcessor(reportProcessor2.getAddress())).to.be.revertedWith(
        `AccessControl: account ${(await stranger.getAddress()).toLowerCase()} is missing role ${manageReportProcessorRoleKeccak256}`,
      );
    });

    it("emits ReportProcessorSet event", async () => {
      const oldReportProcessor = await consensus.getReportProcessor();
      const tx = await consensus.setReportProcessor(await reportProcessor2.getAddress());
      await expect(tx)
        .to.emit(consensus, "ReportProcessorSet")
        .withArgs(await reportProcessor2.getAddress(), oldReportProcessor);
      const newReportProcessor = await consensus.getReportProcessor();
      expect(oldReportProcessor).to.equal(await reportProcessor1.getAddress());
      expect(newReportProcessor).to.equal(await reportProcessor2.getAddress());
    });

    it("prev did not processed last report yet — do submit report to next", async () => {
      const frame = await consensus.getCurrentFrame();

      await consensus.connect(admin).addMember(member1, 1);
      await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);

      // There is no `processor.startReportProcessing()`
      // to simulate situation when processing still in progress

      await consensus.setReportProcessor(await reportProcessor2.getAddress());
      expect((await reportProcessor2.getLastCall_submitReport()).callCount).to.equal(1);
    });

    it("prev did processed current frame report — do not submit report to next", async () => {
      const frame = await consensus.getCurrentFrame();

      await consensus.connect(admin).addMember(member1, 1);
      await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);

      await reportProcessor1.startReportProcessing();

      await consensus.setReportProcessor(await reportProcessor2.getAddress());
      expect((await reportProcessor2.getLastCall_submitReport()).callCount).to.equal(0);
    });

    it("next processor already have processed report for current frame", async () => {
      const frame = await consensus.getCurrentFrame();

      // 1 — Make up state of unfinished processing for reportProcessor1
      await consensus.connect(admin).addMember(member1, 1);
      await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);

      // 2 — Make up state of finished processing for reportProcessor2
      await reportProcessor2.setLastProcessingStartedRefSlot(frame.refSlot);

      // 3 — Check call count of report submits
      await consensus.setReportProcessor(await reportProcessor2.getAddress());
      expect((await reportProcessor2.getLastCall_submitReport()).callCount).to.equal(0);
    });

    it("do not submit report to next processor if there was no consensus", async () => {
      const frame = await consensus.getCurrentFrame();

      await consensus.connect(admin).addMember(member1, 1);
      await consensus.connect(admin).addMember(member2, 2);

      await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
      await reportProcessor1.startReportProcessing();

      await consensus.setReportProcessor(await reportProcessor2.getAddress());
      expect((await reportProcessor2.getLastCall_submitReport()).callCount).to.equal(
        0,
        "processor reported but there was no quorum",
      );
    });

    it("do not submit report to next processor if consensus was lost", async () => {
      const frame = await consensus.getCurrentFrame();

      await consensus.connect(admin).addMember(member1, 1);
      await consensus.connect(admin).addMember(member2, 2);

      await consensus.connect(member1).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
      await consensus.connect(member2).submitReport(frame.refSlot, HASH_1, CONSENSUS_VERSION);
      await consensus.connect(member2).submitReport(frame.refSlot, HASH_2, CONSENSUS_VERSION);
      expect((await reportProcessor1.getLastCall_discardReport()).callCount).to.equal(1, "report withdrawn");

      await consensus.setReportProcessor(await reportProcessor2.getAddress());
      expect((await reportProcessor2.getLastCall_submitReport()).callCount).to.equal(0, "no report submitted");
    });
  });

  context("consensus version", () => {
    afterEach(rollback);

    it("equals to version of initial processor", async () => {
      expect(await consensus.getConsensusVersion()).to.equal(CONSENSUS_VERSION);
    });

    it("equals to new processor version after it was changed", async () => {
      const CONSENSUS_VERSION_2 = 2;

      const reportProcessor_v2 = await new MockReportProcessor__factory(admin).deploy(CONSENSUS_VERSION_2);

      await consensus.setReportProcessor(await reportProcessor_v2.getAddress());
      expect(await consensus.getConsensusVersion()).to.equal(CONSENSUS_VERSION_2);
    });
  });

  context("method getReportVariants", () => {
    afterEach(rollback);

    it(`returns empty data if lastReportRefSlot != currentFrame.refSlot`, async () => {
      const { refSlot } = await consensus.getCurrentFrame();
      await consensus.connect(admin).addMember(member1, 1);

      await consensus.connect(member1).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);
      const reportVariants1 = await consensus.getReportVariants();
      expect([...reportVariants1.variants]).to.have.ordered.members([HASH_1]);
      expect([...reportVariants1.support]).to.have.ordered.members([1n]);

      await consensus.advanceTimeToNextFrameStart();
      const reportVariants2 = await consensus.getReportVariants();
      expect([...reportVariants2.variants]).to.be.empty;
      expect([...reportVariants2.support]).to.be.empty;
    });
  });
});
