import { expect } from "chai";
import { ContractTransactionReceipt, ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, ValidatorsExitBus__Harness } from "typechain-types";

import { de0x, numberToHex, VEBO_CONSENSUS_VERSION } from "lib";

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

describe("ValidatorsExitBusOracle.sol:gas", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;

  let oracleVersion: bigint;

  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;

  const NUM_MODULES = 5;
  const NODE_OPS_PER_MODULE = 100;

  let nextValIndex = 1;

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
    const reportData = [items.consensusVersion, items.refSlot, items.requestsCount, items.dataFormat, items.data];
    const reportDataHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["(uint256,uint256,uint256,uint256,bytes)"], [reportData]),
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
    await consensus.connect(member1).submitReport(refSlot, hash, VEBO_CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, hash, VEBO_CONSENSUS_VERSION);
    expect((await consensus.getConsensusState()).consensusReport).to.equal(hash);
  };

  const generateExitRequests = (totalRequests: number) => {
    const requestsPerModule = Math.max(1, Math.floor(totalRequests / NUM_MODULES));
    const requestsPerNodeOp = Math.max(1, Math.floor(requestsPerModule / NODE_OPS_PER_MODULE));

    const requests = [];

    for (let i = 0; i < totalRequests; ++i) {
      const moduleId = Math.floor(i / requestsPerModule);
      const nodeOpId = Math.floor((i - moduleId * requestsPerModule) / requestsPerNodeOp);
      const valIndex = nextValIndex++;
      const valPubkey = PUBKEYS[valIndex % PUBKEYS.length];
      requests.push({ moduleId: moduleId + 1, nodeOpId, valIndex, valPubkey });
    }

    return { requests, requestsPerModule, requestsPerNodeOp };
  };

  const gasUsages: { totalRequests: number; requestsPerModule: number; requestsPerNodeOp: number; gasUsed: number }[] =
    [];

  before(async () => {
    [admin, member1, member2, member3] = await ethers.getSigners();

    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;

    await initVEBO({
      admin: admin.address,
      oracle,
      consensus,
      resumeAfterDeploy: true,
    });

    oracleVersion = await oracle.getContractVersion();

    await consensus.addMember(member1, 1);
    await consensus.addMember(member2, 2);
    await consensus.addMember(member3, 2);
  });

  after(async () => {
    gasUsages.forEach(({ totalRequests, requestsPerModule, requestsPerNodeOp, gasUsed }) =>
      console.log(
        `${totalRequests} requests (per module ${requestsPerModule}, ` +
          `per node op ${requestsPerNodeOp}): total gas ${gasUsed}, ` +
          `gas per request: ${Math.round(gasUsed / totalRequests)}`,
      ),
    );
  });

  for (const totalRequests of [10, 50, 100, 1000, 2000]) {
    context(`Total requests: ${totalRequests}`, () => {
      let exitRequests: { requests: ExitRequest[]; requestsPerModule: number; requestsPerNodeOp: number };
      let reportFields: ReportFields;
      let reportHash: string;
      let originalState: string;

      before(async () => (originalState = await Snapshot.take()));

      after(async () => await Snapshot.restore(originalState));

      it("initially, consensus report is not being processed", async () => {
        const { refSlot } = await consensus.getCurrentFrame();

        const report = await oracle.getConsensusReport();
        expect(refSlot).to.above(report.refSlot);

        const procState = await oracle.getProcessingState();
        expect(procState.dataHash, ZeroHash);
        expect(procState.dataSubmitted).to.equal(false);
      });

      it("committee reaches consensus on a report hash", async () => {
        const { refSlot } = await consensus.getCurrentFrame();

        exitRequests = generateExitRequests(totalRequests);

        reportFields = {
          consensusVersion: VEBO_CONSENSUS_VERSION,
          refSlot: refSlot,
          requestsCount: exitRequests.requests.length,
          dataFormat: DATA_FORMAT_LIST,
          data: encodeExitRequestsDataList(exitRequests.requests),
        };

        reportHash = calcValidatorsExitBusReportDataHash(reportFields);

        await triggerConsensusOnHash(reportHash);
      });

      it("oracle gets the report hash", async () => {
        const report = await oracle.getConsensusReport();
        expect(report.hash).to.equal(reportHash);
        expect(report.refSlot).to.equal(reportFields.refSlot);
        expect(report.processingDeadlineTime).to.equal(computeTimestampAtSlot(report.refSlot + SLOTS_PER_FRAME));
        expect(report.processingStarted).to.equal(false);

        const procState = await oracle.getProcessingState();
        expect(procState.dataHash).to.equal(reportHash);
        expect(procState.dataSubmitted).to.equal(false);
        expect(procState.dataFormat).to.equal(0);
        expect(procState.requestsCount).to.equal(0);
        expect(procState.requestsSubmitted).to.equal(0);
      });

      it("some time passes", async () => {
        await consensus.advanceTimeBy(SECONDS_PER_FRAME / 3n);
      });

      it(`a committee member submits the report data, exit requests are emitted`, async () => {
        const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        const receipt = (await tx.wait()) as ContractTransactionReceipt;
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, reportHash);
        expect((await oracle.getConsensusReport()).processingStarted).to.equal(true);

        const timestamp = await oracle.getTime();

        const evFirst = exitRequests.requests[0];
        const evLast = exitRequests.requests[exitRequests.requests.length - 1];

        await expect(tx)
          .to.emit(oracle, "ValidatorExitRequest")
          .withArgs(evFirst.moduleId, evFirst.nodeOpId, evFirst.valIndex, evFirst.valPubkey, timestamp);

        await expect(tx)
          .to.emit(oracle, "ValidatorExitRequest")
          .withArgs(evLast.moduleId, evLast.nodeOpId, evLast.valIndex, evLast.valPubkey, timestamp);

        const { gasUsed } = receipt;

        gasUsages.push({
          totalRequests,
          requestsPerModule: exitRequests.requestsPerModule,
          requestsPerNodeOp: exitRequests.requestsPerNodeOp,
          gasUsed: Number(gasUsed),
        });
      });

      it(`reports are marked as processed`, async () => {
        const procState = await oracle.getProcessingState();
        expect(procState.dataHash).to.equal(reportHash);
        expect(procState.dataSubmitted).to.equal(true);
        expect(procState.dataFormat).to.equal(DATA_FORMAT_LIST);
        expect(procState.requestsCount).to.equal(exitRequests.requests.length);
        expect(procState.requestsSubmitted).to.equal(exitRequests.requests.length);
      });

      it("some time passes", async () => {
        const prevFrame = await consensus.getCurrentFrame();
        await consensus.advanceTimeBy(SECONDS_PER_FRAME - SECONDS_PER_FRAME / 3n);
        const newFrame = await consensus.getCurrentFrame();
        expect(newFrame.refSlot).to.above(prevFrame.refSlot);
      });
    });
  }
});
