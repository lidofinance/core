import { expect } from "chai";
import { ContractTransactionReceipt, ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, OracleReportSanityChecker, ValidatorsExitBus__Harness } from "typechain-types";

import { CONSENSUS_VERSION, de0x, numberToHex } from "lib";

import {
  computeTimestampAtSlot,
  DATA_FORMAT_LIST,
  deployVEBO,
  initVEBO,
  SECONDS_PER_FRAME,
  SLOTS_PER_FRAME,
} from "test/deploy";
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

  let oracleVersion: bigint;

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

  const calcValidatorsExitBusReportDataHash = (items: ReturnType<typeof getValidatorsExitBusReportDataItems>) => {
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["(uint256,uint256,uint256,uint256,bytes)"], [items]);
    return ethers.keccak256(data);
  };

  const getValidatorsExitBusReportDataItems = (r: ReportFields) => {
    return [r.consensusVersion, r.refSlot, r.requestsCount, r.dataFormat, r.data];
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

    const reportItems = getValidatorsExitBusReportDataItems(reportData);
    const reportHash = calcValidatorsExitBusReportDataHash(reportItems);

    await triggerConsensusOnHash(reportHash);

    return { reportData, reportHash };
  };

  const deploy = async () => {
    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;
    oracleReportSanityChecker = deployed.oracleReportSanityChecker;

    await initVEBO({
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
  };

  before(async () => {
    [admin, member1, member2, member3] = await ethers.getSigners();

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
          reportFields: { data: encodeExitRequestsDataList(exitRequests) + "aaaaaaaaaaaaaaaaaa", refSlot },
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
      // it("reverts if request limit is reached", async () => {
      //   const exitRequestsLimit = 1;
      //   await oracleReportSanityChecker.setMaxExitRequestsPerOracleReport(exitRequestsLimit);
      //   const report = await prepareReportAndSubmitHash([
      //     { moduleId: 5, nodeOpId: 3, valIndex: 2, valPubkey: PUBKEYS[2] },
      //     { moduleId: 5, nodeOpId: 3, valIndex: 2, valPubkey: PUBKEYS[3] },
      //   ]);
      //   await assert.reverts(
      //     oracle.submitReportData(report, oracleVersion, { from: member1 }),
      //     `IncorrectNumberOfExitRequestsPerReport(${exitRequestsLimit})`,
      //   );
      // });
      // it("pass if requests amount equals to limit", async () => {
      //   const exitRequestsLimit = 1;
      //   await oracleReportSanityChecker.setMaxExitRequestsPerOracleReport(exitRequestsLimit);
      //   const report = await prepareReportAndSubmitHash([
      //     { moduleId: 5, nodeOpId: 3, valIndex: 2, valPubkey: PUBKEYS[2] },
      //   ]);
      //   await oracle.submitReportData(report, oracleVersion, { from: member1 });
      // });
    });
  });
});
