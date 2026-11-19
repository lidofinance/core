import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, WithdrawalsOracle__Harness } from "typechain-types";

import { advanceChainTime, getCurrentBlockTimestamp, WITHDRAWALS_ORACLE_CONSENSUS_VERSION } from "lib";

import {
  calcWithdrawalsOracleReportDataHash,
  deployWithdrawalsOracle,
  encodeWithdrawalRequests,
  initWithdrawalsOracle,
  WithdrawalsOracleReportFields,
} from "test/deploy";

const LAST_PROCESSING_REF_SLOT = 1;

const REQUESTS = [{ moduleId: 1, nodeOpId: 0, keyIndex: 0, amount: 0n }];

describe("WithdrawalsOracle: pause checks", () => {
  let oracle: WithdrawalsOracle__Harness;
  let consensus: HashConsensus__Harness;
  let admin: HardhatEthersSigner;
  let pauser: HardhatEthersSigner;
  let resumer: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;

  // Builds a report and brings the committee to consensus on its hash
  const prepareReport = async (): Promise<WithdrawalsOracleReportFields> => {
    const { refSlot } = await consensus.getCurrentFrame();
    const report = {
      consensusVersion: WITHDRAWALS_ORACLE_CONSENSUS_VERSION,
      refSlot,
      requestsCount: REQUESTS.length,
      data: encodeWithdrawalRequests(REQUESTS),
    };
    const reportHash = calcWithdrawalsOracleReportDataHash(report);

    await consensus.connect(member1).submitReport(refSlot, reportHash, WITHDRAWALS_ORACLE_CONSENSUS_VERSION);
    await consensus.connect(member2).submitReport(refSlot, reportHash, WITHDRAWALS_ORACLE_CONSENSUS_VERSION);

    return report;
  };

  beforeEach(async () => {
    [admin, pauser, resumer, stranger, member1, member2] = await ethers.getSigners();

    const deployed = await deployWithdrawalsOracle(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;

    await initWithdrawalsOracle({
      admin: admin.address,
      oracle,
      consensus,
      resumeAfterDeploy: true,
      lastProcessingRefSlot: LAST_PROCESSING_REF_SLOT,
    });

    await consensus.addMember(member1, 1);
    await consensus.addMember(member2, 2);

    await oracle.grantRole(await oracle.PAUSE_ROLE(), pauser);
    await oracle.grantRole(await oracle.RESUME_ROLE(), resumer);
  });

  it("Should not allow pauseFor call without PAUSE_ROLE", async () => {
    await expect(oracle.connect(stranger).pauseFor(60)).to.be.revertedWithOZAccessControlError(
      stranger.address,
      await oracle.PAUSE_ROLE(),
    );
  });

  it("Should not allow pauseUntil call without PAUSE_ROLE", async () => {
    await expect(oracle.connect(stranger).pauseUntil(60)).to.be.revertedWithOZAccessControlError(
      stranger.address,
      await oracle.PAUSE_ROLE(),
    );
  });

  it("pauseFor(0) → ZeroPauseDuration", async () => {
    await expect(oracle.connect(pauser).pauseFor(0)).to.be.revertedWithCustomError(oracle, "ZeroPauseDuration");
  });

  it("pauseFor blocks protected calls until resumed", async () => {
    const report = await prepareReport();
    const oracleVersion = await oracle.getContractVersion();

    // pause 1 h
    await oracle.connect(pauser).pauseFor(3600);

    await expect(oracle.connect(member1).submitReportData(report, oracleVersion)).to.be.revertedWithCustomError(
      oracle,
      "ResumedExpected",
    );

    // stranger can’t resume
    await expect(oracle.connect(stranger).resume()).to.be.revertedWithOZAccessControlError(
      stranger.address,
      await oracle.RESUME_ROLE(),
    );

    // authorised resume
    await oracle.connect(resumer).resume();

    // calls work again
    await expect(oracle.connect(member1).submitReportData(report, oracleVersion)).to.emit(oracle, "ProcessingStarted");
  });

  it("second pause while already paused → ResumedExpected", async () => {
    await oracle.connect(pauser).pauseFor(100);
    await expect(oracle.connect(pauser).pauseFor(100)).to.be.revertedWithCustomError(oracle, "ResumedExpected");
  });

  it("resume when not paused → PausedExpected", async () => {
    await expect(oracle.connect(resumer).resume()).to.be.revertedWithCustomError(oracle, "PausedExpected");
  });

  it("pauseUntil blocks only until the timestamp", async () => {
    const report = await prepareReport();
    const oracleVersion = await oracle.getContractVersion();

    const until = (await getCurrentBlockTimestamp()) + 3600n;
    await oracle.connect(pauser).pauseUntil(until);

    await expect(oracle.connect(member1).submitReportData(report, oracleVersion)).to.be.revertedWithCustomError(
      oracle,
      "ResumedExpected",
    );

    // move the chain past the inclusive pause end: the pause lifts without resume()
    await advanceChainTime(until - (await getCurrentBlockTimestamp()) + 1n);
    expect(await oracle.isPaused()).to.equal(false);

    await expect(oracle.connect(member1).submitReportData(report, oracleVersion)).to.emit(oracle, "ProcessingStarted");
  });
});
