import { expect } from "chai";
import { ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  HashConsensus__Harness,
  OracleReportSanityChecker,
  ValidatorsExitBus__Harness,
  WithdrawalVault__MockForVebo,
} from "typechain-types";

import { CONSENSUS_VERSION, de0x, numberToHex } from "lib";

import { computeTimestampAtSlot, DATA_FORMAT_LIST, deployVEBO, initVEBO } from "test/deploy";
import { Snapshot } from "test/suite";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
];
const HASH_1 = "0x1111111111111111111111111111111111111111111111111111111111111111";

describe("ValidatorsExitBusOracle.sol:submitReportData", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;
  let oracleReportSanityChecker: OracleReportSanityChecker;
  let withdrawalVault: WithdrawalVault__MockForVebo;

  let oracleVersion: bigint;

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
    const dataHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], [items.data]));
    const reportData = [items.consensusVersion, items.refSlot, items.requestsCount, items.dataFormat, dataHash];
    const reportDataHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["(uint256,uint256,uint256,uint256,bytes32)"], [reportData]),
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

  const triggerConsensusOnHash = async (hash: string) => {
    const { refSlot } = await consensus.getCurrentFrame();
    await consensus.connect(member1).submitReport(refSlot, hash, CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, hash, CONSENSUS_VERSION);
    expect((await consensus.getConsensusState()).consensusReport).to.equal(hash);
  };

  const prepareReportAndSubmitHash = async (
    requests = [{ moduleId: 5, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[2] }],
    options = { reportFields: {} },
  ) => {
    const { refSlot } = await consensus.getCurrentFrame();
    const reportData = {
      consensusVersion: CONSENSUS_VERSION,
      dataFormat: DATA_FORMAT_LIST,
      refSlot,
      requestsCount: requests.length,
      data: encodeExitRequestsDataList(requests),
      ...options.reportFields,
    };

    const reportHash = calcValidatorsExitBusReportDataHash(reportData);

    await triggerConsensusOnHash(reportHash);

    return { reportData, reportHash };
  };

  async function getLastRequestedValidatorIndex(moduleId: number, nodeOpId: number) {
    return (await oracle.getLastRequestedValidatorIndices(moduleId, [nodeOpId]))[0];
  }

  const deploy = async () => {
    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;
    oracleReportSanityChecker = deployed.oracleReportSanityChecker;
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
    [admin, member1, member2, member3, stranger] = await ethers.getSigners();

    await deploy();
  });

  context("discarded report prevents data submit", () => {
    let reportData: ReportFields;
    let reportHash: string;
    let originalState: string;

    before(async () => {
      originalState = await Snapshot.take();
    });

    after(async () => await Snapshot.restore(originalState));

    it("report is discarded", async () => {
      ({ reportData, reportHash } = await prepareReportAndSubmitHash());
      const { refSlot } = await consensus.getCurrentFrame();

      // change of mind
      const tx = await consensus.connect(member3).submitReport(refSlot, HASH_1, CONSENSUS_VERSION);

      await expect(tx).to.emit(oracle, "ReportDiscarded").withArgs(refSlot, reportHash);
    });

    it("processing state reverts to pre-report state ", async () => {
      const state = await oracle.getProcessingState();
      expect(state.dataHash).to.equal(ZeroHash);
      expect(state.dataSubmitted).to.equal(false);
      expect(state.dataFormat).to.equal(0);
      expect(state.requestsCount).to.equal(0);
      expect(state.requestsSubmitted).to.equal(0);
    });

    it("reverts on trying to submit the discarded report", async () => {
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
        .to.be.revertedWithCustomError(oracle, "UnexpectedDataHash")
        .withArgs(ZeroHash, reportHash);
    });
  });

  context("_handleConsensusReportData", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();
      await consensus.advanceTimeToNextFrameStart();
    });

    afterEach(async () => await Snapshot.restore(originalState));

    context("enforces data format", () => {
      it("dataFormat = 0 reverts", async () => {
        const dataFormatUnsupported = 0;
        const { reportData } = await prepareReportAndSubmitHash(
          [{ moduleId: 5, nodeOpId: 3, valIndex: 0, valPubkey: PUBKEYS[0] }],
          { reportFields: { dataFormat: dataFormatUnsupported } },
        );

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
          .to.be.revertedWithCustomError(oracle, "UnsupportedRequestsDataFormat")
          .withArgs(dataFormatUnsupported);
      });

      it("dataFormat = 2 reverts", async () => {
        const dataFormatUnsupported = 2;
        const { reportData } = await prepareReportAndSubmitHash(
          [{ moduleId: 5, nodeOpId: 3, valIndex: 0, valPubkey: PUBKEYS[0] }],
          { reportFields: { dataFormat: dataFormatUnsupported } },
        );

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
          .to.be.revertedWithCustomError(oracle, "UnsupportedRequestsDataFormat")
          .withArgs(dataFormatUnsupported);
      });

      it("dataFormat = 1 pass", async () => {
        const { reportData } = await prepareReportAndSubmitHash([
          { moduleId: 5, nodeOpId: 3, valIndex: 0, valPubkey: PUBKEYS[0] },
        ]);
        await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      });
    });

    context("enforces data length", () => {
      it("reverts if there is more data than expected", async () => {
        const { refSlot } = await consensus.getCurrentFrame();
        const exitRequests = [{ moduleId: 5, nodeOpId: 3, valIndex: 0, valPubkey: PUBKEYS[0] }];
        const { reportData } = await prepareReportAndSubmitHash(exitRequests, {
          reportFields: { refSlot, data: encodeExitRequestsDataList(exitRequests) + "aaaaaaaaaaaaaaaaaa" },
        });

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).to.be.revertedWithCustomError(
          oracle,
          "InvalidRequestsDataLength",
        );
      });

      it("reverts if there is less data than expected", async () => {
        const { refSlot } = await consensus.getCurrentFrame();
        const exitRequests = [{ moduleId: 5, nodeOpId: 3, valIndex: 0, valPubkey: PUBKEYS[0] }];
        const data = encodeExitRequestsDataList(exitRequests);

        const { reportData } = await prepareReportAndSubmitHash(exitRequests, {
          reportFields: {
            data: data.slice(0, data.length - 18),
            refSlot,
          },
        });

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).to.be.revertedWithCustomError(
          oracle,
          "InvalidRequestsDataLength",
        );
      });

      it("pass if there is exact amount of data", async () => {
        const { reportData } = await prepareReportAndSubmitHash([
          { moduleId: 5, nodeOpId: 3, valIndex: 0, valPubkey: PUBKEYS[0] },
        ]);
        await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      });
    });

    context("invokes sanity check", () => {
      before(async () => {
        await oracleReportSanityChecker.grantRole(
          await oracleReportSanityChecker.MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE(),
          admin.address,
        );
      });

      it("reverts if request limit is reached", async () => {
        const exitRequestsLimit = 1;
        await oracleReportSanityChecker.connect(admin).setMaxExitRequestsPerOracleReport(exitRequestsLimit);
        const { reportData } = await prepareReportAndSubmitHash([
          { moduleId: 5, nodeOpId: 3, valIndex: 2, valPubkey: PUBKEYS[2] },
          { moduleId: 5, nodeOpId: 3, valIndex: 2, valPubkey: PUBKEYS[3] },
        ]);
        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
          .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectNumberOfExitRequestsPerReport")
          .withArgs(exitRequestsLimit);
      });
      it("pass if requests amount equals to limit", async () => {
        const exitRequestsLimit = 1;
        await oracleReportSanityChecker.connect(admin).setMaxExitRequestsPerOracleReport(exitRequestsLimit);
        const { reportData } = await prepareReportAndSubmitHash([
          { moduleId: 5, nodeOpId: 3, valIndex: 2, valPubkey: PUBKEYS[2] },
        ]);
        await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      });
    });

    context("validates data.requestsCount field with given data", () => {
      it("reverts if requestsCount does not match with encoded data size", async () => {
        const { reportData } = await prepareReportAndSubmitHash(
          [{ moduleId: 5, nodeOpId: 3, valIndex: 0, valPubkey: PUBKEYS[0] }],
          { reportFields: { requestsCount: 2 } },
        );

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).to.be.revertedWithCustomError(
          oracle,
          "UnexpectedRequestsDataLength",
        );
      });
    });

    it("reverts if moduleId equals zero", async () => {
      const { reportData } = await prepareReportAndSubmitHash([
        { moduleId: 0, nodeOpId: 3, valIndex: 0, valPubkey: PUBKEYS[0] },
      ]);

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).to.be.revertedWithCustomError(
        oracle,
        "InvalidRequestsData",
      );
    });

    it("emits ValidatorExitRequest events", async () => {
      const requests = [
        { moduleId: 4, nodeOpId: 2, valIndex: 2, valPubkey: PUBKEYS[2] },
        { moduleId: 5, nodeOpId: 3, valIndex: 2, valPubkey: PUBKEYS[3] },
      ];
      const { reportData } = await prepareReportAndSubmitHash(requests);
      const tx = await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      const timestamp = await consensus.getTime();

      await expect(tx)
        .to.emit(oracle, "ValidatorExitRequest")
        .withArgs(requests[0].moduleId, requests[0].nodeOpId, requests[0].valIndex, requests[0].valPubkey, timestamp);

      await expect(tx)
        .to.emit(oracle, "ValidatorExitRequest")
        .withArgs(requests[1].moduleId, requests[1].nodeOpId, requests[1].valIndex, requests[1].valPubkey, timestamp);
    });

    it("updates processing state", async () => {
      const storageBefore = await oracle.getDataProcessingState();
      expect(storageBefore.refSlot).to.equal(0);
      expect(storageBefore.requestsCount).to.equal(0);

      expect(storageBefore.requestsProcessed).to.equal(0);
      expect(storageBefore.dataFormat).to.equal(0);

      const { refSlot } = await consensus.getCurrentFrame();
      const requests = [
        { moduleId: 4, nodeOpId: 3, valIndex: 2, valPubkey: PUBKEYS[2] },
        { moduleId: 5, nodeOpId: 3, valIndex: 2, valPubkey: PUBKEYS[3] },
      ];
      const { reportData } = await prepareReportAndSubmitHash(requests);
      await oracle.connect(member1).submitReportData(reportData, oracleVersion);

      const storageAfter = await oracle.getDataProcessingState();
      expect(storageAfter.refSlot).to.equal(refSlot);
      expect(storageAfter.requestsCount).to.equal(requests.length);
      expect(storageAfter.requestsProcessed).to.equal(requests.length);
      expect(storageAfter.dataFormat).to.equal(DATA_FORMAT_LIST);
    });

    it("updates total requests processed count", async () => {
      let currentCount = 0;
      const countStep0 = await oracle.getTotalRequestsProcessed();
      expect(countStep0).to.equal(currentCount);

      // Step 1 — process 1 item
      const requestsStep1 = [{ moduleId: 3, nodeOpId: 1, valIndex: 2, valPubkey: PUBKEYS[1] }];
      const { reportData: reportStep1 } = await prepareReportAndSubmitHash(requestsStep1);
      await oracle.connect(member1).submitReportData(reportStep1, oracleVersion);
      const countStep1 = await oracle.getTotalRequestsProcessed();
      currentCount += requestsStep1.length;
      expect(countStep1).to.equal(currentCount);

      // Step 2 — process 2 items
      await consensus.advanceTimeToNextFrameStart();
      const requestsStep2 = [
        { moduleId: 4, nodeOpId: 2, valIndex: 2, valPubkey: PUBKEYS[2] },
        { moduleId: 5, nodeOpId: 3, valIndex: 2, valPubkey: PUBKEYS[3] },
      ];
      const { reportData: reportStep2 } = await prepareReportAndSubmitHash(requestsStep2);
      await oracle.connect(member1).submitReportData(reportStep2, oracleVersion);
      const countStep2 = await oracle.getTotalRequestsProcessed();
      currentCount += requestsStep2.length;
      expect(countStep2).to.equal(currentCount);

      // // Step 3 — process no items
      await consensus.advanceTimeToNextFrameStart();
      const requestsStep3: ExitRequest[] = [];
      const { reportData: reportStep3 } = await prepareReportAndSubmitHash(requestsStep3);
      await oracle.connect(member1).submitReportData(reportStep3, oracleVersion);

      const countStep3 = await oracle.getTotalRequestsProcessed();
      currentCount += requestsStep3.length;
      expect(countStep3).to.equal(currentCount);
    });
  });

  context(`requires validator indices for the same node operator to increase`, () => {
    let originalState: string;

    before(async () => {
      originalState = await Snapshot.take();
      await consensus.advanceTimeToNextFrameStart();
    });

    after(async () => await Snapshot.restore(originalState));

    it(`requesting NO 5-3 to exit validator 0`, async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash([
        { moduleId: 5, nodeOpId: 3, valIndex: 0, valPubkey: PUBKEYS[0] },
      ]);
      await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      expect(await getLastRequestedValidatorIndex(5, 3)).to.equal(0);
    });

    it(`cannot request NO 5-3 to exit validator 0 again`, async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash([
        { moduleId: 5, nodeOpId: 3, valIndex: 0, valPubkey: PUBKEYS[0] },
      ]);

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
        .to.be.revertedWithCustomError(oracle, "NodeOpValidatorIndexMustIncrease")
        .withArgs(5, 3, 0, 0);
    });

    it(`requesting NO 5-3 to exit validator 1`, async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash([
        { moduleId: 5, nodeOpId: 3, valIndex: 1, valPubkey: PUBKEYS[1] },
      ]);
      await oracle.connect(member1).submitReportData(reportData, oracleVersion, { from: member1 });
      expect(await getLastRequestedValidatorIndex(5, 3)).to.equal(1);
    });

    it(`cannot request NO 5-3 to exit validator 1 again`, async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash([
        { moduleId: 5, nodeOpId: 3, valIndex: 1, valPubkey: PUBKEYS[1] },
      ]);

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
        .to.be.revertedWithCustomError(oracle, "NodeOpValidatorIndexMustIncrease")
        .withArgs(5, 3, 1, 1);
    });

    it(`cannot request NO 5-3 to exit validator 0 again`, async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash([
        { moduleId: 5, nodeOpId: 3, valIndex: 0, valPubkey: PUBKEYS[0] },
      ]);

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
        .to.be.revertedWithCustomError(oracle, "NodeOpValidatorIndexMustIncrease")
        .withArgs(5, 3, 1, 0);
    });

    it(`cannot request NO 5-3 to exit validator 1 again (multiple requests)`, async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash([
        { moduleId: 5, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
        { moduleId: 5, nodeOpId: 3, valIndex: 1, valPubkey: PUBKEYS[0] },
      ]);

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
        .to.be.revertedWithCustomError(oracle, "NodeOpValidatorIndexMustIncrease")
        .withArgs(5, 3, 1, 1);
    });

    it(`cannot request NO 5-3 to exit validator 1 again (multiple requests, case 2)`, async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash([
        { moduleId: 5, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[2] },
        { moduleId: 5, nodeOpId: 3, valIndex: 1, valPubkey: PUBKEYS[3] },
        { moduleId: 5, nodeOpId: 3, valIndex: 2, valPubkey: PUBKEYS[4] },
      ]);

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
        .to.be.revertedWithCustomError(oracle, "NodeOpValidatorIndexMustIncrease")
        .withArgs(5, 3, 1, 1);
    });

    it(`cannot request NO 5-3 to exit validator 2 two times per request`, async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash([
        { moduleId: 5, nodeOpId: 3, valIndex: 2, valPubkey: PUBKEYS[2] },
        { moduleId: 5, nodeOpId: 3, valIndex: 2, valPubkey: PUBKEYS[3] },
      ]);

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).to.be.revertedWithCustomError(
        oracle,
        "InvalidRequestsDataSortOrder",
      );
    });
  });

  context(`only consensus member or SUBMIT_DATA_ROLE can submit report on unpaused contract`, () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();
      await consensus.advanceTimeToNextFrameStart();
    });

    afterEach(async () => await Snapshot.restore(originalState));

    it("reverts on stranger", async () => {
      const { reportData } = await prepareReportAndSubmitHash();
      await expect(oracle.connect(stranger).submitReportData(reportData, oracleVersion)).to.be.revertedWithCustomError(
        oracle,
        "SenderNotAllowed",
      );
    });

    it("SUBMIT_DATA_ROLE is allowed", async () => {
      await oracle.grantRole(await oracle.SUBMIT_DATA_ROLE(), stranger, { from: admin });
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash();
      await oracle.connect(stranger).submitReportData(reportData, oracleVersion);
    });

    it("consensus member is allowed", async () => {
      expect(await consensus.getIsMember(member1)).to.equal(true);
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash();
      await oracle.connect(member1).submitReportData(reportData, oracleVersion);
    });

    it("reverts on paused contract", async () => {
      await consensus.advanceTimeToNextFrameStart();
      const PAUSE_INFINITELY = await oracle.PAUSE_INFINITELY();
      await oracle.pauseFor(PAUSE_INFINITELY, { from: admin });
      const { reportData } = await prepareReportAndSubmitHash();
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).to.be.revertedWithCustomError(
        oracle,
        "ResumedExpected",
      );
    });
  });

  context("invokes internal baseOracle checks", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();
      await consensus.advanceTimeToNextFrameStart();
    });

    afterEach(async () => await Snapshot.restore(originalState));

    it(`reverts on contract version mismatch`, async () => {
      const { reportData } = await prepareReportAndSubmitHash();

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion + 1n))
        .to.be.revertedWithCustomError(oracle, "UnexpectedContractVersion")
        .withArgs(oracleVersion, oracleVersion + 1n);
    });

    it("reverts on hash mismatch", async () => {
      const requests = [{ moduleId: 5, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[2] }];
      const { reportHash: actualReportHash } = await prepareReportAndSubmitHash(requests);
      const newRequests = [{ moduleId: 5, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[1] }];

      const { refSlot } = await consensus.getCurrentFrame();
      // change pubkey
      const reportData = {
        consensusVersion: CONSENSUS_VERSION,
        refSlot,
        requestsCount: requests.length,
        dataFormat: DATA_FORMAT_LIST,
        data: encodeExitRequestsDataList(newRequests),
      };

      const changedReportHash = calcValidatorsExitBusReportDataHash(reportData);

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
        .to.be.revertedWithCustomError(oracle, "UnexpectedDataHash")
        .withArgs(actualReportHash, changedReportHash);
    });

    it("reverts on processing deadline miss", async () => {
      const { reportData } = await prepareReportAndSubmitHash();
      const deadline = (await oracle.getConsensusReport()).processingDeadlineTime.toString(10);
      await consensus.advanceTimeToNextFrameStart();

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
        .to.be.revertedWithCustomError(oracle, "ProcessingDeadlineMissed")
        .withArgs(deadline);
    });
  });

  context("getTotalRequestsProcessed reflects report history", () => {
    let originalState: string;

    before(async () => {
      originalState = await Snapshot.take();
      await consensus.advanceTimeToNextFrameStart();
    });

    after(async () => await Snapshot.restore(originalState));

    let requestCount = 0;

    it("should be zero at init", async () => {
      requestCount = 0;
      expect(await oracle.getTotalRequestsProcessed()).to.equal(requestCount);
    });

    it("should increase after report", async () => {
      const { reportData } = await prepareReportAndSubmitHash([
        { moduleId: 5, nodeOpId: 3, valIndex: 0, valPubkey: PUBKEYS[0] },
      ]);
      await oracle.connect(member1).submitReportData(reportData, oracleVersion, { from: member1 });
      requestCount += 1;
      expect(await oracle.getTotalRequestsProcessed()).to.equal(requestCount);
    });

    it("should double increase for two exits", async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash([
        { moduleId: 5, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
        { moduleId: 5, nodeOpId: 3, valIndex: 1, valPubkey: PUBKEYS[0] },
      ]);
      await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      requestCount += 2;
      expect(await oracle.getTotalRequestsProcessed()).to.equal(requestCount);
    });

    it("should not change on empty report", async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash([]);
      await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      expect(await oracle.getTotalRequestsProcessed()).to.equal(requestCount);
    });
  });

  context("getProcessingState reflects state change", () => {
    let originalState: string;
    before(async () => {
      originalState = await Snapshot.take();
      await consensus.advanceTimeToNextFrameStart();
    });
    after(async () => await Snapshot.restore(originalState));

    let report: ReportFields;
    let hash: string;

    it("has correct defaults on init", async () => {
      const state = await oracle.getProcessingState();
      expect(Object.values(state)).to.deep.equal([
        (await consensus.getCurrentFrame()).refSlot,
        0,
        ZeroHash,
        false,
        0,
        0,
        0,
      ]);
    });

    it("consensus report submitted", async () => {
      ({ reportData: report, reportHash: hash } = await prepareReportAndSubmitHash([
        { moduleId: 5, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[2] },
        { moduleId: 5, nodeOpId: 3, valIndex: 1, valPubkey: PUBKEYS[3] },
      ]));
      const state = await oracle.getProcessingState();

      expect(Object.values(state)).to.deep.equal([
        (await consensus.getCurrentFrame()).refSlot,
        computeTimestampAtSlot((await consensus.getCurrentFrame()).reportProcessingDeadlineSlot),
        hash,
        false,
        0,
        0,
        0,
      ]);
    });

    it("report is processed", async () => {
      await oracle.connect(member1).submitReportData(report, oracleVersion);
      const state = await oracle.getProcessingState();
      expect(Object.values(state)).to.deep.equal([
        (await consensus.getCurrentFrame()).refSlot,
        computeTimestampAtSlot((await consensus.getCurrentFrame()).reportProcessingDeadlineSlot),
        hash,
        true,
        DATA_FORMAT_LIST,
        2,
        2,
      ]);
    });

    it("at next frame state resets", async () => {
      await consensus.advanceTimeToNextFrameStart();
      const state = await oracle.getProcessingState();
      expect(Object.values(state)).to.deep.equal([
        (await consensus.getCurrentFrame()).refSlot,
        0,
        ZeroHash,
        false,
        0,
        0,
        0,
      ]);
    });
  });
});
