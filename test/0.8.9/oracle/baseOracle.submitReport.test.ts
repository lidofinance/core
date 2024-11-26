import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { BaseOracle__Harness, ConsensusContract__Mock } from "typechain-types";

import { SECONDS_PER_SLOT } from "lib";

import {
  deadlineFromRefSlot,
  deployBaseOracle,
  epochFirstSlotAt,
  HASH_1,
  HASH_2,
  HASH_3,
  nextRefSlotFromRefSlot,
  ZERO_HASH,
} from "test/deploy";
import { Snapshot } from "test/suite";

describe("BaseOracle.sol:submitReport", () => {
  let admin: HardhatEthersSigner;

  let originalState: string;
  let baseOracle: BaseOracle__Harness;
  let initialRefSlot: bigint;
  let consensus: ConsensusContract__Mock;

  before(async () => {
    [admin] = await ethers.getSigners();

    const deployed = await deployBaseOracle(admin, { initialEpoch: 1n });
    consensus = deployed.consensusContract;
    baseOracle = deployed.oracle;

    const time = await baseOracle.getTime();
    initialRefSlot = epochFirstSlotAt(time);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("getConsensusReport", () => {
    let nextRefSlot: bigint;
    let nextRefSlotDeadline: bigint;

    beforeEach(async () => {
      nextRefSlot = nextRefSlotFromRefSlot(initialRefSlot);
      nextRefSlotDeadline = deadlineFromRefSlot(nextRefSlot);
    });

    it("Returns empty state", async () => {
      const report = await baseOracle.getConsensusReport();

      expect(report.hash).to.equal(ZERO_HASH);
      expect(report.refSlot).to.equal(0);
      expect(report.processingDeadlineTime).to.equal(0);
      expect(report.processingStarted).to.be.false;
    });

    it("Returns initial report", async () => {
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot));
      const report = await baseOracle.getConsensusReport();

      expect(report.hash).to.equal(HASH_1);
      expect(report.refSlot).to.equal(initialRefSlot);
      expect(report.processingDeadlineTime).to.equal(deadlineFromRefSlot(initialRefSlot));
      expect(report.processingStarted).to.be.false;
    });

    it("Returns next reports", async () => {
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot));

      // next report is submitted, initial report is missed, warning event fired
      await expect(consensus.submitReportAsConsensus(HASH_2, nextRefSlot, nextRefSlotDeadline))
        .to.emit(baseOracle, "WarnProcessingMissed")
        .withArgs(initialRefSlot);

      const report1 = await baseOracle.getConsensusReport();

      expect(report1.hash).to.equal(HASH_2);
      expect(report1.refSlot).to.equal(nextRefSlot);
      expect(report1.processingDeadlineTime).to.equal(nextRefSlotDeadline);
      expect(report1.processingStarted).to.be.false;

      // next report is re-agreed, no missed warnings
      await expect(consensus.submitReportAsConsensus(HASH_3, nextRefSlot, nextRefSlotDeadline)).not.to.emit(
        baseOracle,
        "WarnProcessingMissed",
      );

      const report2 = await baseOracle.getConsensusReport();
      expect(report2.hash).to.equal(HASH_3);
      expect(report2.refSlot).to.equal(nextRefSlot);
      expect(report2.processingDeadlineTime).to.equal(nextRefSlotDeadline);
      expect(report2.processingStarted).to.be.false;
    });

    it("Returns report while processing", async () => {
      // Simulating multiple reports submitted
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot));
      await consensus.submitReportAsConsensus(HASH_2, nextRefSlot, nextRefSlotDeadline);
      await consensus.submitReportAsConsensus(HASH_3, nextRefSlot, nextRefSlotDeadline);

      await baseOracle.startProcessing();
      const report = await baseOracle.getConsensusReport();

      expect(report.hash).to.equal(HASH_3);
      expect(report.refSlot).to.equal(nextRefSlot);
      expect(report.processingDeadlineTime).to.equal(nextRefSlotDeadline);
      expect(report.processingStarted).to.be.true;
    });
  });

  context("startProcessing", () => {
    let refSlot1: bigint;
    let refSlot2: bigint;
    let refSlot1Deadline: bigint;
    let refSlot2Deadline: bigint;

    beforeEach(async () => {
      refSlot1 = nextRefSlotFromRefSlot(initialRefSlot);
      refSlot1Deadline = deadlineFromRefSlot(refSlot1);

      refSlot2 = nextRefSlotFromRefSlot(refSlot1);
      refSlot2Deadline = deadlineFromRefSlot(refSlot2);
    });

    context("Reverts", () => {
      it("on empty state", async () => {
        await expect(baseOracle.startProcessing()).to.be.revertedWithCustomError(
          baseOracle,
          "NoConsensusReportToProcess",
        );
      });

      it("on zero report", async () => {
        await expect(baseOracle.startProcessing()).to.be.revertedWithCustomError(
          baseOracle,
          "NoConsensusReportToProcess",
        );
      });

      it("on zero report (after discarded)", async () => {
        await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot));
        await consensus.discardReportAsConsensus(initialRefSlot);

        await expect(baseOracle.startProcessing()).to.be.revertedWithCustomError(
          baseOracle,
          "NoConsensusReportToProcess",
        );
      });

      it("on processing the same slot again reverts", async () => {
        await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot));
        await baseOracle.startProcessing();

        await expect(baseOracle.startProcessing()).to.be.revertedWithCustomError(
          baseOracle,
          "RefSlotAlreadyProcessing",
        );
      });

      it("on report with missed deadline is missed", async () => {
        await consensus.submitReportAsConsensus(HASH_3, refSlot2, refSlot2Deadline);

        await baseOracle.setTime(refSlot2Deadline + SECONDS_PER_SLOT * 10n);

        await expect(baseOracle.startProcessing())
          .to.be.revertedWithCustomError(baseOracle, "ProcessingDeadlineMissed")
          .withArgs(refSlot2Deadline);
      });
    });

    it("Starts report processing", async () => {
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot));

      await expect(baseOracle.startProcessing())
        .to.emit(baseOracle, "ProcessingStarted")
        .withArgs(initialRefSlot, HASH_1)
        .to.emit(baseOracle, "MockStartProcessingResult")
        .withArgs("0");
    });

    it("Advances state on next report processing", async () => {
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot));
      await baseOracle.startProcessing();

      await consensus.submitReportAsConsensus(HASH_2, refSlot1, refSlot1Deadline);
      await expect(await baseOracle.startProcessing())
        .to.emit(baseOracle, "ProcessingStarted")
        .withArgs(refSlot1, HASH_2)
        .to.emit(baseOracle, "MockStartProcessingResult")
        .withArgs(String(initialRefSlot));

      const processingSlot = await baseOracle.getLastProcessingRefSlot();
      expect(processingSlot).to.equal(refSlot1);
    });
  });

  context("submitConsensusReport", () => {
    context("Reverts", () => {
      it("if report whose deadline has already passed", async () => {
        const deadline = deadlineFromRefSlot(initialRefSlot);
        await baseOracle.setTime(deadline + 1n);

        await expect(consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadline))
          .to.be.revertedWithCustomError(baseOracle, "ProcessingDeadlineMissed")
          .withArgs(deadline);
      });

      it("if not called by setConsensus contract", async () => {
        await expect(
          baseOracle.submitConsensusReport(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot)),
        ).to.be.revertedWithCustomError(baseOracle, "SenderIsNotTheConsensusContract");
      });

      it("if try to submit zero hash", async () => {
        await expect(
          consensus.submitReportAsConsensus(ZERO_HASH, initialRefSlot, deadlineFromRefSlot(initialRefSlot)),
        ).to.be.revertedWithCustomError(baseOracle, "HashCannotBeZero");
      });

      it("if submitting older report", async () => {
        await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot));

        const badSlot = initialRefSlot - 1n;

        await expect(consensus.submitReportAsConsensus(HASH_1, badSlot, deadlineFromRefSlot(badSlot)))
          .to.be.revertedWithCustomError(baseOracle, "RefSlotCannotDecrease")
          .withArgs(badSlot, initialRefSlot);
      });

      it("if resubmit already processing report", async () => {
        await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot));

        await baseOracle.startProcessing();

        await expect(consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot)))
          .to.be.revertedWithCustomError(baseOracle, "RefSlotMustBeGreaterThanProcessingOne")
          .withArgs(initialRefSlot, initialRefSlot);
      });
    });

    it("Submits initial report and calls _handleConsensusReport", async () => {
      const before = await baseOracle.getConsensusReportLastCall();
      expect(before.callCount).to.equal(0);

      await expect(consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot)))
        .to.emit(baseOracle, "ReportSubmitted")
        .withArgs(initialRefSlot, HASH_1, deadlineFromRefSlot(initialRefSlot));

      const after = await baseOracle.getConsensusReportLastCall();

      expect(after.callCount).to.equal(1);
      expect(after.report.hash).to.equal(HASH_1);
      expect(after.report.refSlot).to.equal(initialRefSlot);
      expect(after.report.processingDeadlineTime).to.equal(deadlineFromRefSlot(initialRefSlot));
    });

    it("Emits warning event when newer report is submitted and previous has not started processing yet", async () => {
      const secondRefSlot = nextRefSlotFromRefSlot(initialRefSlot);
      const thirdRefSlot = nextRefSlotFromRefSlot(secondRefSlot);

      const before = await baseOracle.getConsensusReportLastCall();
      expect(before.callCount).to.equal(0);

      await expect(
        consensus.submitReportAsConsensus(HASH_1, secondRefSlot, deadlineFromRefSlot(secondRefSlot)),
      ).to.emit(baseOracle, "ReportSubmitted");

      await expect(consensus.submitReportAsConsensus(HASH_1, thirdRefSlot, deadlineFromRefSlot(thirdRefSlot)))
        .to.emit(baseOracle, "ReportSubmitted")
        .to.emit(baseOracle, "WarnProcessingMissed")
        .withArgs(secondRefSlot);

      const after = await baseOracle.getConsensusReportLastCall();
      expect(after.callCount).to.equal(2);
    });
  });

  context("discardConsensusReport", () => {
    let nextRefSlot: bigint;

    before(async () => {
      nextRefSlot = nextRefSlotFromRefSlot(initialRefSlot);
    });

    context("Reverts", () => {
      beforeEach(async () => {
        await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot));
      });

      it("if slot is invalid", async () => {
        const badSlot = initialRefSlot - 1n;

        await expect(consensus.discardReportAsConsensus(badSlot))
          .to.be.revertedWithCustomError(baseOracle, "RefSlotCannotDecrease")
          .withArgs(badSlot, initialRefSlot);
      });

      it("if processing started", async () => {
        await baseOracle.startProcessing();

        await expect(consensus.discardReportAsConsensus(initialRefSlot)).to.be.revertedWithCustomError(
          baseOracle,
          "RefSlotAlreadyProcessing",
        );
      });
    });

    it("Does not discard when no report exists for the frame", async () => {
      await expect(consensus.discardReportAsConsensus(initialRefSlot)).not.to.emit(baseOracle, "ReportDiscarded");
    });

    it("Does not discard when attempting to discard a future report", async () => {
      await expect(await consensus.discardReportAsConsensus(nextRefSlot)).not.to.emit(baseOracle, "ReportDiscarded");
    });

    it("Submits initial report successfully", async () => {
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot));

      const report = await baseOracle.getConsensusReport();
      expect(report.hash).to.equal(HASH_1);
    });

    it("Discards report", async () => {
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot));

      await expect(consensus.discardReportAsConsensus(initialRefSlot))
        .to.emit(baseOracle, "ReportDiscarded")
        .withArgs(initialRefSlot, HASH_1);

      const currentReport = await baseOracle.getConsensusReport();

      expect(currentReport.hash).to.equal(ZERO_HASH);
      expect(currentReport.refSlot).to.equal(initialRefSlot);
      expect(currentReport.processingDeadlineTime).to.equal(deadlineFromRefSlot(initialRefSlot));
      expect(currentReport.processingStarted).to.be.false;
    });

    it("Calls _handleConsensusReportDiscarded when report is discarded", async () => {
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadlineFromRefSlot(initialRefSlot));
      await consensus.discardReportAsConsensus(initialRefSlot);

      const discardedReport = await baseOracle.lastDiscardedReport();

      expect(discardedReport.hash).to.equal(HASH_1);
      expect(discardedReport.refSlot).to.equal(initialRefSlot);
      expect(discardedReport.processingDeadlineTime).to.equal(deadlineFromRefSlot(initialRefSlot));
    });

    it("Allows re-submitting report after it was discarded", async () => {
      await consensus.submitReportAsConsensus(HASH_2, initialRefSlot, deadlineFromRefSlot(initialRefSlot));
      const currentReport = await baseOracle.getConsensusReport();

      expect(currentReport.hash).to.equal(HASH_2);
      expect(currentReport.refSlot).to.equal(initialRefSlot);
      expect(currentReport.processingDeadlineTime).to.equal(deadlineFromRefSlot(initialRefSlot));
      expect(currentReport.processingStarted).to.be.false;
    });
  });
});
