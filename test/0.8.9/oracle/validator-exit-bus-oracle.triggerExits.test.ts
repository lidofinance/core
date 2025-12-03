import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  HashConsensus__Harness,
  TriggerableWithdrawalsGateway__MockForVEB,
  ValidatorsExitBus__Harness,
} from "typechain-types";

import { de0x, numberToHex, VEBO_CONSENSUS_VERSION } from "lib";

import { DATA_FORMAT_LIST, deployVEBO, initVEBO, SECONDS_PER_FRAME } from "test/deploy";

// -----------------------------------------------------------------------------
// Constants & helpers
// -----------------------------------------------------------------------------

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
];

const ZERO_ADDRESS = ethers.ZeroAddress;

const LAST_PROCESSING_REF_SLOT = 1;

// -----------------------------------------------------------------------------
// Encoding
// -----------------------------------------------------------------------------

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

const createValidatorDataList = (requests: ExitRequest[]) => {
  return requests.map((request) => ({
    stakingModuleId: request.moduleId,
    nodeOperatorId: request.nodeOpId,
    pubkey: request.valPubkey,
  }));
};

const hashExitRequest = (request: { dataFormat: number; data: string }) => {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], [request.data, request.dataFormat]),
  );
};

describe("ValidatorsExitBusOracle.sol:triggerExits", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;
  let triggerableWithdrawalsGateway: TriggerableWithdrawalsGateway__MockForVEB;

  let oracleVersion: bigint;

  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;
  let authorizedEntity: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const deploy = async () => {
    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;
    triggerableWithdrawalsGateway = deployed.triggerableWithdrawalsGateway;

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

  const triggerConsensusOnHash = async (hash: string) => {
    const { refSlot } = await consensus.getCurrentFrame();
    await consensus.connect(member1).submitReport(refSlot, hash, VEBO_CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, hash, VEBO_CONSENSUS_VERSION);
    expect((await consensus.getConsensusState()).consensusReport).to.equal(hash);
  };

  describe("Submit via oracle flow ", async () => {
    const exitRequests = [
      { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
      { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
      { moduleId: 2, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[3] },
    ];

    let reportFields: ReportFields;
    let reportHash: string;

    before(async () => {
      [admin, member1, member2, member3, authorizedEntity, stranger] = await ethers.getSigners();

      await deploy();
    });

    it("some time passes", async () => {
      await consensus.advanceTimeBy(24 * 60 * 60);
    });

    it("committee reaches consensus on a report hash", async () => {
      const { refSlot } = await consensus.getCurrentFrame();

      reportFields = {
        consensusVersion: VEBO_CONSENSUS_VERSION,
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

      const timestamp = await oracle.getTime();

      for (const request of exitRequests) {
        await expect(tx)
          .to.emit(oracle, "ValidatorExitRequest")
          .withArgs(request.moduleId, request.nodeOpId, request.valIndex, request.valPubkey, timestamp);
      }
    });

    it("should revert with ZeroArgument error if msg.value == 0", async () => {
      await expect(
        oracle.triggerExits({ data: reportFields.data, dataFormat: reportFields.dataFormat }, [0], ZERO_ADDRESS, {
          value: 0,
        }),
      )
        .to.be.revertedWithCustomError(oracle, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("should revert with ZeroArgument error if exitRequestsData is empty", async () => {
      await expect(
        oracle.triggerExits({ data: reportFields.data, dataFormat: reportFields.dataFormat }, [], ZERO_ADDRESS, {
          value: 2,
        }),
      )
        .to.be.revertedWithCustomError(oracle, "ZeroArgument")
        .withArgs("exitDataIndexes");
    });

    it("should refund fee to recipient address", async () => {
      const tx = await oracle.triggerExits(
        { data: reportFields.data, dataFormat: reportFields.dataFormat },
        [0, 1, 2, 3],
        stranger,
        { value: 6 },
      );

      const requests = createValidatorDataList(exitRequests);

      await expect(tx)
        .to.emit(triggerableWithdrawalsGateway, "Mock__triggerFullWithdrawalsTriggered")
        .withArgs(requests.length, stranger.address, await oracle.EXIT_TYPE());
    });

    it("should triggers exits only for validators in selected request indexes", async () => {
      const tx = await oracle.triggerExits(
        { data: reportFields.data, dataFormat: reportFields.dataFormat },
        [0, 1, 3],
        ZERO_ADDRESS,
        {
          value: 10,
        },
      );

      const requests = createValidatorDataList(exitRequests.filter((req, i) => [0, 1, 3].includes(i)));

      await expect(tx)
        .to.emit(triggerableWithdrawalsGateway, "Mock__triggerFullWithdrawalsTriggered")
        .withArgs(requests.length, admin.address, await oracle.EXIT_TYPE());
    });

    it("preserves eth balance when calling triggerExits", async () => {
      const ethBefore = await ethers.provider.getBalance(oracle.getAddress());

      await oracle.triggerExits(
        { data: reportFields.data, dataFormat: reportFields.dataFormat },
        [0, 1, 3],
        ZERO_ADDRESS,
        {
          value: 10,
        },
      );

      const ethAfter = await ethers.provider.getBalance(oracle.getAddress());
      expect(ethAfter).to.equal(ethBefore);
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
          { value: 2 },
        ),
      ).to.be.revertedWithCustomError(oracle, "ExitHashNotSubmitted");
    });

    it("should revert with error if requested index out of range", async () => {
      await expect(
        oracle.triggerExits({ data: reportFields.data, dataFormat: reportFields.dataFormat }, [5], ZERO_ADDRESS, {
          value: 2,
        }),
      )
        .to.be.revertedWithCustomError(oracle, "ExitDataIndexOutOfRange")
        .withArgs(5, 4);
    });

    it("should revert with an error if the key index array contains duplicates", async () => {
      await expect(
        oracle.triggerExits({ data: reportFields.data, dataFormat: reportFields.dataFormat }, [1, 2, 2], ZERO_ADDRESS, {
          value: 2,
        }),
      ).to.be.revertedWithCustomError(oracle, "InvalidExitDataIndexSortOrder");
    });

    it("should revert with an error if the key index array is not strictly increasing", async () => {
      await expect(
        oracle.triggerExits({ data: reportFields.data, dataFormat: reportFields.dataFormat }, [2, 1, 3], ZERO_ADDRESS, {
          value: 2,
        }),
      ).to.be.revertedWithCustomError(oracle, "InvalidExitDataIndexSortOrder");
    });
  });

  describe("Submit via trustfull method", () => {
    const exitRequests = [
      { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
      { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      { moduleId: 2, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
    ];

    const exitRequest = {
      dataFormat: DATA_FORMAT_LIST,
      data: encodeExitRequestsDataList(exitRequests),
    };

    const exitRequestHash: string = hashExitRequest(exitRequest);

    before(async () => {
      [admin, member1, member2, member3, authorizedEntity] = await ethers.getSigners();

      await deploy();
    });

    it("should revert if request was not submitted", async () => {
      await expect(
        oracle.triggerExits(
          { data: exitRequest.data, dataFormat: exitRequest.dataFormat },
          [0, 1, 2, 3],
          ZERO_ADDRESS,
          { value: 4 },
        ),
      ).to.be.revertedWithCustomError(oracle, "ExitHashNotSubmitted");
    });

    it("Should store exit hash for authorized entity", async () => {
      const role = await oracle.SUBMIT_REPORT_HASH_ROLE();

      await oracle.grantRole(role, authorizedEntity);

      const submitTx = await oracle.connect(authorizedEntity).submitExitRequestsHash(exitRequestHash);

      await expect(submitTx).to.emit(oracle, "RequestsHashSubmitted").withArgs(exitRequestHash);
    });

    it("should revert if request was not delivered", async () => {
      await expect(
        oracle.triggerExits(
          { data: exitRequest.data, dataFormat: exitRequest.dataFormat },
          [0, 1, 2, 3],
          ZERO_ADDRESS,
          { value: 4 },
        ),
      ).to.be.revertedWithCustomError(oracle, "RequestsNotDelivered");
    });

    it("Should be executed without errors if request was previously delivered", async () => {
      const emitTx = await oracle.submitExitRequestsData(exitRequest);
      const timestamp = await oracle.getTime();

      await expect(emitTx)
        .to.emit(oracle, "ValidatorExitRequest")
        .withArgs(
          exitRequests[0].moduleId,
          exitRequests[0].nodeOpId,
          exitRequests[0].valIndex,
          exitRequests[0].valPubkey,
          timestamp,
        );

      await expect(emitTx)
        .to.emit(oracle, "ValidatorExitRequest")
        .withArgs(
          exitRequests[1].moduleId,
          exitRequests[1].nodeOpId,
          exitRequests[1].valIndex,
          exitRequests[1].valPubkey,
          timestamp,
        );

      await expect(emitTx)
        .to.emit(oracle, "ValidatorExitRequest")
        .withArgs(
          exitRequests[2].moduleId,
          exitRequests[2].nodeOpId,
          exitRequests[2].valIndex,
          exitRequests[2].valPubkey,
          timestamp,
        );

      await oracle.triggerExits(
        { data: exitRequest.data, dataFormat: exitRequest.dataFormat },
        [0, 1, 2],
        ZERO_ADDRESS,
        { value: 4 },
      );
    });

    it("should revert with error if module id is equal to 0", async () => {
      const requests = [
        { moduleId: 0, nodeOpId: 1, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
        { moduleId: 2, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      ];

      const request = {
        dataFormat: DATA_FORMAT_LIST,
        data: encodeExitRequestsDataList(requests),
      };

      const requestHash: string = hashExitRequest(request);

      // will store request data to mock exit delivery with wrong module id
      await oracle.storeNewHashRequestStatus(requestHash, 2, 123456);

      await expect(
        oracle.triggerExits(request, [0, 1, 2], ZERO_ADDRESS, {
          value: 4,
        }),
      ).to.be.revertedWithCustomError(oracle, "InvalidModuleId");
    });
  });
});
