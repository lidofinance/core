import { expect } from "chai";
import { ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { BaseOracleTimeTravellable, MockConsensusContract } from "typechain-types";

import { Snapshot } from "lib";

import {
  computeDeadlineFromRefSlot,
  computeEpochFirstSlotAt,
  computeNextRefSlotFromRefSlot,
  deployBaseOracle,
  HASH_1,
  HASH_2,
  HASH_3,
  SECONDS_PER_SLOT,
} from "./baseOracle";

describe("BaseOracle.sol", () => {
  let admin: HardhatEthersSigner;

  let originalState: string;
  let baseOracle: BaseOracleTimeTravellable;
  let initialRefSlot: number;
  let consensus: MockConsensusContract;

  const deployContract = async () => {
    const deployed = await deployBaseOracle(admin, { initialEpoch: 1 });
    consensus = deployed.consensusContract;
    baseOracle = deployed.oracle;
    const time = Number(await baseOracle.getTime());
    initialRefSlot = computeEpochFirstSlotAt(time);
  };

  before(async () => {
    [admin] = await ethers.getSigners();
    await deployContract();
  });

  const takeSnapshot = async () => {
    originalState = await Snapshot.take();
  };

  const rollback = async () => {
    await Snapshot.restore(originalState);
  };

  describe("submitConsensusReport is called and changes the contract state", () => {
    context("submitConsensusReport rejects a report whose deadline has already passed", () => {
      before(takeSnapshot);
      after(rollback);

      it("the report is rejected", async () => {
        const deadline = computeDeadlineFromRefSlot(initialRefSlot);
        await baseOracle.setTime(deadline + 1);
        await expect(consensus.submitReportAsConsensus(HASH_1, initialRefSlot, deadline))
          .to.be.revertedWithCustomError(baseOracle, "ProcessingDeadlineMissed")
          .withArgs(deadline);
      });
    });

    context("submitConsensusReport checks pre-conditions", () => {
      before(takeSnapshot);
      after(rollback);

      it("only setConsensus contract can call submitConsensusReport", async () => {
        await expect(
          baseOracle.submitConsensusReport(HASH_1, initialRefSlot, computeDeadlineFromRefSlot(initialRefSlot)),
        ).to.be.revertedWithCustomError(baseOracle, "SenderIsNotTheConsensusContract");
      });

      it("zero hash cannot be submitted as a report", async () => {
        await expect(
          consensus.submitReportAsConsensus(ZeroHash, initialRefSlot, computeDeadlineFromRefSlot(initialRefSlot)),
        ).to.be.revertedWithCustomError(baseOracle, "HashCannotBeZero");
      });

      it("initial report is submitted and _handleConsensusReport is called", async () => {
        expect((await baseOracle.getConsensusReportLastCall()).callCount).to.be.equal(0);
        const tx = await consensus.submitReportAsConsensus(
          HASH_1,
          initialRefSlot,
          computeDeadlineFromRefSlot(initialRefSlot),
        );
        await expect(tx)
          .to.emit(baseOracle, "ReportSubmitted")
          .withArgs(initialRefSlot, HASH_1, computeDeadlineFromRefSlot(initialRefSlot));
        const { report, callCount } = await baseOracle.getConsensusReportLastCall();
        expect(callCount).to.be.equal(1);
        expect(report.hash).to.be.equal(HASH_1);
        expect(report.refSlot).to.be.equal(initialRefSlot);
        expect(report.processingDeadlineTime).to.be.equal(computeDeadlineFromRefSlot(initialRefSlot));
      });

      it("older report cannot be submitted", async () => {
        await expect(
          consensus.submitReportAsConsensus(HASH_1, initialRefSlot - 1, computeDeadlineFromRefSlot(initialRefSlot - 1)),
        )
          .to.be.revertedWithCustomError(baseOracle, "RefSlotCannotDecrease")
          .withArgs(initialRefSlot - 1, initialRefSlot);
      });

      it("oracle starts processing last report", async () => {
        await baseOracle.startProcessing();
      });

      it("consensus cannot resubmit already processing report", async () => {
        await expect(
          consensus.submitReportAsConsensus(HASH_1, initialRefSlot, computeDeadlineFromRefSlot(initialRefSlot)),
        )
          .to.be.revertedWithCustomError(baseOracle, "RefSlotMustBeGreaterThanProcessingOne")
          .withArgs(initialRefSlot, initialRefSlot);
      });

      it("warning event is emitted when newer report is submitted and prev has not started processing yet", async () => {
        const RefSlot2 = computeNextRefSlotFromRefSlot(initialRefSlot);
        const RefSlot3 = computeNextRefSlotFromRefSlot(RefSlot2);

        const tx1 = await consensus.submitReportAsConsensus(HASH_1, RefSlot2, computeDeadlineFromRefSlot(RefSlot2));
        expect((await baseOracle.getConsensusReportLastCall()).callCount).to.be.equal(2);
        await expect(tx1).to.emit(baseOracle, "ReportSubmitted");

        const tx2 = await consensus.submitReportAsConsensus(HASH_1, RefSlot3, computeDeadlineFromRefSlot(RefSlot3));
        await expect(tx2).to.emit(baseOracle, "WarnProcessingMissed").withArgs(RefSlot2);
        expect((await baseOracle.getConsensusReportLastCall()).callCount).to.be.equal(3);
        await expect(tx2).to.emit(baseOracle, "ReportSubmitted");
      });
    });

    context("submitConsensusReport updates getConsensusReport", () => {
      let nextRefSlot: number;
      let nextRefSlotDeadline: number;

      before(async () => {
        await takeSnapshot();
        nextRefSlot = computeNextRefSlotFromRefSlot(initialRefSlot);
        nextRefSlotDeadline = computeDeadlineFromRefSlot(nextRefSlot);
      });
      after(rollback);

      it("getConsensusReport at deploy returns empty state", async () => {
        const report = await baseOracle.getConsensusReport();
        expect(report.hash).to.be.equal(ZeroHash);
        expect(report.refSlot).to.be.equal(0);
        expect(report.processingDeadlineTime).to.be.equal(0);
        expect(report.processingStarted).to.be.false;
      });

      it("cannot start processing on empty state", async () => {
        await expect(baseOracle.startProcessing()).to.be.revertedWithCustomError(
          baseOracle,
          "NoConsensusReportToProcess",
        );
      });

      it("initial report is submitted", async () => {
        await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, computeDeadlineFromRefSlot(initialRefSlot));
        const report = await baseOracle.getConsensusReport();
        expect(report.hash).to.be.equal(HASH_1);
        expect(report.refSlot).to.be.equal(initialRefSlot);
        expect(report.processingDeadlineTime).to.be.equal(computeDeadlineFromRefSlot(initialRefSlot));
        expect(report.processingStarted).to.be.false;
      });

      it("next report is submitted, initial report is missed, warning event fired", async () => {
        const tx = await consensus.submitReportAsConsensus(HASH_2, nextRefSlot, nextRefSlotDeadline);
        await expect(tx).to.emit(baseOracle, "WarnProcessingMissed").withArgs(initialRefSlot);
        const report = await baseOracle.getConsensusReport();
        expect(report.hash).to.be.equal(HASH_2);
        expect(report.refSlot).to.be.equal(nextRefSlot);
        expect(report.processingDeadlineTime).to.be.equal(nextRefSlotDeadline);
        expect(report.processingStarted).to.be.false;
      });

      it("next report is re-agreed, no missed warning", async () => {
        const tx = await consensus.submitReportAsConsensus(HASH_3, nextRefSlot, nextRefSlotDeadline);
        await expect(tx).not.to.emit(baseOracle, "WarnProcessingMissed");
        const report = await baseOracle.getConsensusReport();
        expect(report.hash).to.be.equal(HASH_3);
        expect(report.refSlot).to.be.equal(nextRefSlot);
        expect(report.processingDeadlineTime).to.be.equal(nextRefSlotDeadline);
        expect(report.processingStarted).to.be.false;
      });

      it("report processing started for last report", async () => {
        await baseOracle.startProcessing();
        const report = await baseOracle.getConsensusReport();
        expect(report.hash).to.be.equal(HASH_3);
        expect(report.refSlot).to.be.equal(nextRefSlot);
        expect(report.processingDeadlineTime).to.be.equal(nextRefSlotDeadline);
        expect(report.processingStarted).to.be.true;
      });
    });
  });

  describe("_startProcessing safely advances processing state", () => {
    let refSlot1: number, refSlot2: number;
    let refSlot1Deadline: number, refSlot2Deadline: number;

    before(async () => {
      await takeSnapshot();
      refSlot1 = computeNextRefSlotFromRefSlot(initialRefSlot);
      refSlot1Deadline = computeDeadlineFromRefSlot(refSlot1);

      refSlot2 = computeNextRefSlotFromRefSlot(refSlot1);
      refSlot2Deadline = computeDeadlineFromRefSlot(refSlot2);
    });

    after(rollback);

    it("initial contract state, no reports, cannot startProcessing", async () => {
      await expect(baseOracle.startProcessing()).to.be.revertedWithCustomError(
        baseOracle,
        "NoConsensusReportToProcess",
      );
    });

    it("submit first report for initial slot", async () => {
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, computeDeadlineFromRefSlot(initialRefSlot));
      const tx = await baseOracle.startProcessing();
      await expect(tx).to.emit(baseOracle, "ProcessingStarted").withArgs(initialRefSlot, HASH_1);
      await expect(tx).to.emit(baseOracle, "MockStartProcessingResult").withArgs("0");
    });

    it("trying to start processing the same slot again reverts", async () => {
      await expect(baseOracle.startProcessing()).to.be.revertedWithCustomError(baseOracle, "RefSlotAlreadyProcessing");
    });

    it("next report comes in, start processing, state advances", async () => {
      await consensus.submitReportAsConsensus(HASH_2, refSlot1, refSlot1Deadline);
      const tx = await baseOracle.startProcessing();
      await expect(tx).to.emit(baseOracle, "ProcessingStarted").withArgs(refSlot1, HASH_2);
      await expect(tx).to.emit(baseOracle, "MockStartProcessingResult").withArgs(String(initialRefSlot));
      const processingSlot = await baseOracle.getLastProcessingRefSlot();
      expect(processingSlot).to.be.equal(refSlot1);
    });

    it("another report but deadline is missed, reverts", async () => {
      await consensus.submitReportAsConsensus(HASH_3, refSlot2, refSlot2Deadline);
      await baseOracle.setTime(refSlot2Deadline + SECONDS_PER_SLOT * 10);
      await expect(baseOracle.startProcessing())
        .to.be.revertedWithCustomError(baseOracle, "ProcessingDeadlineMissed")
        .withArgs(refSlot2Deadline);
    });
  });

  describe("discardConsensusReport", () => {
    let nextRefSlot: number;

    before(async () => {
      await takeSnapshot();
      nextRefSlot = computeNextRefSlotFromRefSlot(initialRefSlot);
    });

    after(rollback);

    it("noop if no report for this frame", async () => {
      const tx = await consensus.discardReportAsConsensus(initialRefSlot);
      await expect(tx).not.to.emit(baseOracle, "ReportDiscarded");
    });

    it("initial report", async () => {
      await consensus.submitReportAsConsensus(HASH_1, initialRefSlot, computeDeadlineFromRefSlot(initialRefSlot));
    });

    it("noop if discarding future report", async () => {
      const tx = await consensus.discardReportAsConsensus(nextRefSlot);
      await expect(tx).not.to.emit(baseOracle, "ReportDiscarded");
    });

    it("reverts for invalid slot", async () => {
      await expect(consensus.discardReportAsConsensus(initialRefSlot - 1))
        .to.be.revertedWithCustomError(baseOracle, "RefSlotCannotDecrease")
        .withArgs(initialRefSlot - 1, initialRefSlot);
    });

    it("discards report and throws events", async () => {
      const tx = await consensus.discardReportAsConsensus(initialRefSlot);
      await expect(tx).to.emit(baseOracle, "ReportDiscarded").withArgs(initialRefSlot, HASH_1);
      const currentReport = await baseOracle.getConsensusReport();
      expect(currentReport.hash).to.be.equal(ZeroHash);
      expect(currentReport.refSlot).to.be.equal(initialRefSlot);
      expect(currentReport.processingDeadlineTime).to.be.equal(computeDeadlineFromRefSlot(initialRefSlot));
      expect(currentReport.processingStarted).to.be.false;
    });

    it("internal _handleConsensusReportDiscarded was called during discard", async () => {
      const discardedReport = await baseOracle.lastDiscardedReport();
      expect(discardedReport.hash).to.be.equal(HASH_1);
      expect(discardedReport.refSlot).to.be.equal(initialRefSlot);
      expect(discardedReport.processingDeadlineTime).to.be.equal(computeDeadlineFromRefSlot(initialRefSlot));
    });

    it("cannot start processing on zero report", async () => {
      await expect(baseOracle.startProcessing()).to.be.revertedWithCustomError(
        baseOracle,
        "NoConsensusReportToProcess",
      );
    });

    it("report can be resubmitted after discard", async () => {
      await consensus.submitReportAsConsensus(HASH_2, initialRefSlot, computeDeadlineFromRefSlot(initialRefSlot));
      const currentReport = await baseOracle.getConsensusReport();
      expect(currentReport.hash).to.be.equal(HASH_2);
      expect(currentReport.refSlot).to.be.equal(initialRefSlot);
      expect(currentReport.processingDeadlineTime).to.be.equal(computeDeadlineFromRefSlot(initialRefSlot));
      expect(currentReport.processingStarted).to.be.false;
      await baseOracle.startProcessing();
    });

    it("reverts if processing started", async () => {
      await expect(consensus.discardReportAsConsensus(initialRefSlot)).to.be.revertedWithCustomError(
        baseOracle,
        "RefSlotAlreadyProcessing",
      );
    });
  });
});
