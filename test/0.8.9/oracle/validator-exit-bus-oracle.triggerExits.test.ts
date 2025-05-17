import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  HashConsensus__Harness,
  TriggerableWithdrawalsGateway__MockForVEB,
  ValidatorsExitBus__Harness,
} from "typechain-types";

import { CONSENSUS_VERSION, de0x, numberToHex } from "lib";

import { DATA_FORMAT_LIST, deployVEBO, initVEBO, SECONDS_PER_FRAME } from "test/deploy";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
];

const ZERO_ADDRESS = ethers.ZeroAddress;

describe("ValidatorsExitBusOracle.sol:triggerExits", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;
  let triggerableWithdrawalsGateway: TriggerableWithdrawalsGateway__MockForVEB;

  let oracleVersion: bigint;
  let exitRequests: ExitRequest[];
  let reportFields: ReportFields;
  let reportHash: string;

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

  const encodeTWGExitRequestsData = ({ moduleId, nodeOpId, valPubkey }: ExitRequest) => {
    const pubkeyHex = de0x(valPubkey);
    expect(pubkeyHex.length).to.equal(48 * 2);
    return numberToHex(moduleId, 3) + numberToHex(nodeOpId, 5) + pubkeyHex;
  };

  const encodeTWGExitDataList = (requests: ExitRequest[]) => {
    return "0x" + requests.map(encodeTWGExitRequestsData).join("");
  };

  const deploy = async () => {
    const deployed = await deployVEBO(admin.address);
    const locator = deployed.locator;
    oracle = deployed.oracle;
    consensus = deployed.consensus;
    triggerableWithdrawalsGateway = deployed.triggerableWithdrawalsGateway;

    console.log("twg=", await locator.triggerableWithdrawalsGateway());

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

  const triggerConsensusOnHash = async (hash: string) => {
    const { refSlot } = await consensus.getCurrentFrame();
    await consensus.connect(member1).submitReport(refSlot, hash, CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, hash, CONSENSUS_VERSION);
    expect((await consensus.getConsensusState()).consensusReport).to.equal(hash);
  };

  it("some time passes", async () => {
    await consensus.advanceTimeBy(24 * 60 * 60);
  });

  it("committee reaches consensus on a report hash", async () => {
    const { refSlot } = await consensus.getCurrentFrame();

    exitRequests = [
      { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
      { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
      { moduleId: 2, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[3] },
    ];

    reportFields = {
      consensusVersion: CONSENSUS_VERSION,
      refSlot: refSlot,
      requestsCount: exitRequests.length,
      dataFormat: DATA_FORMAT_LIST,
      data: encodeExitRequestsDataList(exitRequests),
    };

    reportHash = calcValidatorsExitBusReportDataHash(reportFields);

    await triggerConsensusOnHash(reportHash);
  });

  it("some time passes", async () => {
    await consensus.advanceTimeBy(SECONDS_PER_FRAME / 3n);
  });

  it("a committee member submits the report data, exit requests are emitted", async () => {
    const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);

    await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, reportHash);
    expect((await oracle.getConsensusReport()).processingStarted).to.equal(true);

    const timestamp = await oracle.getTime();

    for (const request of exitRequests) {
      await expect(tx)
        .to.emit(oracle, "ValidatorExitRequest")
        .withArgs(request.moduleId, request.nodeOpId, request.valIndex, request.valPubkey, timestamp);
    }
  });

  it("should triggers exits for all validators in exit request", async () => {
    const tx = await oracle.triggerExits(
      { data: reportFields.data, dataFormat: reportFields.dataFormat },
      [0, 1, 2, 3],
      ZERO_ADDRESS,
      0,
      { value: 4 },
    );

    const requests = encodeTWGExitDataList(exitRequests);

    await expect(tx)
      .to.emit(triggerableWithdrawalsGateway, "Mock__triggerFullWithdrawalsTriggered")
      .withArgs(requests, admin.address, 0);
  });

  it("should triggers exits only for validators in selected request indexes", async () => {
    const tx = await oracle.triggerExits(
      { data: reportFields.data, dataFormat: reportFields.dataFormat },
      [0, 1, 3],
      ZERO_ADDRESS,
      0,
      {
        value: 10,
      },
    );

    const requests = encodeTWGExitDataList(exitRequests.filter((req, i) => [0, 1, 3].includes(i)));

    await expect(tx)
      .to.emit(triggerableWithdrawalsGateway, "Mock__triggerFullWithdrawalsTriggered")
      .withArgs(requests, admin.address, 0);
  });

  it("should revert with error if the hash of `requestsData` was not previously submitted in the VEB", async () => {
    await expect(
      oracle.triggerExits(
        {
          data: "0x0000030000000000000000000000005a894d712b61ee6d5da473f87d9c8175c4022fd05a8255b6713dc75388b099a85514ceca78a52b9122d09aecda9010c047",
          dataFormat: reportFields.dataFormat,
        },
        [0],
        ZERO_ADDRESS,
        0,
        { value: 2 },
      ),
    ).to.be.revertedWithCustomError(oracle, "ExitHashNotSubmitted");
  });

  it("should revert with error if requested index out of range", async () => {
    await expect(
      oracle.triggerExits({ data: reportFields.data, dataFormat: reportFields.dataFormat }, [5], ZERO_ADDRESS, 0, {
        value: 2,
      }),
    )
      .to.be.revertedWithCustomError(oracle, "KeyIndexOutOfRange")
      .withArgs(5, 4);
  });

  it("should revert with an error if the key index array contains duplicates", async () => {
    await expect(
      oracle.triggerExits(
        { data: reportFields.data, dataFormat: reportFields.dataFormat },
        [1, 2, 2],
        ZERO_ADDRESS,
        0,
        {
          value: 2,
        },
      ),
    ).to.be.revertedWithCustomError(oracle, "InvalidKeyIndexSortOrder");
  });

  it("should revert with an error if the key index array is not strictly increasing", async () => {
    await expect(
      oracle.triggerExits(
        { data: reportFields.data, dataFormat: reportFields.dataFormat },
        [1, 2, 2],
        ZERO_ADDRESS,
        0,
        {
          value: 2,
        },
      ),
    ).to.be.revertedWithCustomError(oracle, "InvalidKeyIndexSortOrder");
  });
});
