import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, ValidatorsExitBus__Harness } from "typechain-types";

import { de0x, numberToHex } from "lib";

import { DATA_FORMAT_LIST, deployVEBO, initVEBO } from "test/deploy";

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

// -----------------------------------------------------------------------------
// Encoding
// -----------------------------------------------------------------------------
interface ExitRequest {
  moduleId: number;
  nodeOpId: number;
  valIndex: number;
  valPubkey: string;
}

interface ExitRequestData {
  dataFormat: number;
  data: string;
}

const encodeExitRequestHex = ({ moduleId, nodeOpId, valIndex, valPubkey }: ExitRequest) => {
  const pubkeyHex = de0x(valPubkey);
  expect(pubkeyHex.length).to.equal(48 * 2);
  return numberToHex(moduleId, 3) + numberToHex(nodeOpId, 5) + numberToHex(valIndex, 8) + pubkeyHex;
};

const encodeExitRequestsDataList = (requests: ExitRequest[]) => {
  return "0x" + requests.map(encodeExitRequestHex).join("");
};

const hashExitRequest = (request: { dataFormat: number; data: string }) => {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], [request.data, request.dataFormat]),
  );
};

describe("ValidatorsExitBusOracle.sol:submitExitRequestsData", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;

  let exitRequests = [
    { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
    { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
    { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
    { moduleId: 2, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[3] },
  ];

  let exitRequest: ExitRequestData = { dataFormat: DATA_FORMAT_LIST, data: encodeExitRequestsDataList(exitRequests) };

  let exitRequestHash: string = hashExitRequest(exitRequest);

  let authorizedEntity: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const LAST_PROCESSING_REF_SLOT = 1;

  const deploy = async () => {
    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;

    await initVEBO({
      admin: admin.address,
      oracle,
      consensus,
      resumeAfterDeploy: true,
      lastProcessingRefSlot: LAST_PROCESSING_REF_SLOT,
    });
  };

  describe("Common case", () => {
    // tests in this section related to ExitRequestsData mistakes
    // also here we tests successfull case

    before(async () => {
      [admin, authorizedEntity, stranger] = await ethers.getSigners();

      await deploy();
    });

    it("Initially, report was not submitted", async () => {
      await expect(oracle.submitExitRequestsData(exitRequest))
        .to.be.revertedWithCustomError(oracle, "ExitHashNotSubmitted")
        .withArgs();
    });

    it("Should revert without SUBMIT_REPORT_HASH_ROLE role", async () => {
      await expect(
        oracle.connect(stranger).submitExitRequestsHash(exitRequestHash),
      ).to.be.revertedWithOZAccessControlError(await stranger.getAddress(), await oracle.SUBMIT_REPORT_HASH_ROLE());
    });

    it("Should store exit hash for authorized entity", async () => {
      const role = await oracle.SUBMIT_REPORT_HASH_ROLE();

      await oracle.grantRole(role, authorizedEntity);

      const submitTx = await oracle.connect(authorizedEntity).submitExitRequestsHash(exitRequestHash);

      await expect(submitTx).to.emit(oracle, "RequestsHashSubmitted").withArgs(exitRequestHash);
    });

    it("Should revert if hash was already submitted", async () => {
      await expect(
        oracle.connect(authorizedEntity).submitExitRequestsHash(exitRequestHash),
      ).to.be.revertedWithCustomError(oracle, "ExitHashAlreadySubmitted");
    });

    it("Emit ValidatorExit event", async () => {
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

      await expect(emitTx)
        .to.emit(oracle, "ValidatorExitRequest")
        .withArgs(
          exitRequests[3].moduleId,
          exitRequests[3].nodeOpId,
          exitRequests[3].valIndex,
          exitRequests[3].valPubkey,
          timestamp,
        );
    });

    it("Should revert if wrong DATA_FORMAT", async () => {
      const exitRequestWrongDataFormat: ExitRequestData = {
        dataFormat: 2,
        data: encodeExitRequestsDataList(exitRequests),
      };
      const hash = hashExitRequest(exitRequestWrongDataFormat);
      const submitTx = await oracle.connect(authorizedEntity).submitExitRequestsHash(hash);

      await expect(submitTx).to.emit(oracle, "RequestsHashSubmitted").withArgs(hash);

      await expect(oracle.submitExitRequestsData(exitRequestWrongDataFormat))
        .to.be.revertedWithCustomError(oracle, "UnsupportedRequestsDataFormat")
        .withArgs(2);
    });

    it("Should revert if contains duplicates", async () => {
      const requests = [
        { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[1] },
      ];

      const exitRequestData: ExitRequestData = {
        dataFormat: 1,
        data: encodeExitRequestsDataList(requests),
      };
      const hash = hashExitRequest(exitRequestData);
      const submitTx = await oracle.connect(authorizedEntity).submitExitRequestsHash(hash);
      await expect(submitTx).to.emit(oracle, "RequestsHashSubmitted").withArgs(hash);

      await expect(oracle.submitExitRequestsData(exitRequestData)).to.be.revertedWithCustomError(
        oracle,
        "InvalidRequestsDataSortOrder",
      );
    });

    it("Should revert if data is not sorted in ascending order", async () => {
      const requests = [
        { moduleId: 2, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[1] },
      ];

      const exitRequestData: ExitRequestData = {
        dataFormat: 1,
        data: encodeExitRequestsDataList(requests),
      };
      const hash = hashExitRequest(exitRequestData);
      const submitTx = await oracle.connect(authorizedEntity).submitExitRequestsHash(hash);
      await expect(submitTx).to.emit(oracle, "RequestsHashSubmitted").withArgs(hash);

      await expect(oracle.submitExitRequestsData(exitRequestData)).to.be.revertedWithCustomError(
        oracle,
        "InvalidRequestsDataSortOrder",
      );
    });

    it("Should revert with InvalidRequestsDataLength if length of requests is equal to 0", async () => {
      const exitRequestData: ExitRequestData = {
        dataFormat: 1,
        data: "0x",
      };
      const hash = hashExitRequest(exitRequestData);

      const submitTx = await oracle.connect(authorizedEntity).submitExitRequestsHash(hash);
      await expect(submitTx).to.emit(oracle, "RequestsHashSubmitted").withArgs(hash);

      await expect(oracle.submitExitRequestsData(exitRequestData)).to.be.revertedWithCustomError(
        oracle,
        "InvalidRequestsDataLength",
      );
    });

    it("Should revert with InvalidRequestsDataLength if length of requests is not divided by request length without remainder", async () => {
      // 64 - length of request in bytes
      const request =
        "0x00000100000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".slice(
          0,
          2 + 64 * 2 - 4,
        );

      const exitRequestData: ExitRequestData = {
        dataFormat: 1,
        data: request,
      };
      const hash = hashExitRequest(exitRequestData);

      const submitTx = await oracle.connect(authorizedEntity).submitExitRequestsHash(hash);
      await expect(submitTx).to.emit(oracle, "RequestsHashSubmitted").withArgs(hash);

      await expect(oracle.submitExitRequestsData(exitRequestData)).to.be.revertedWithCustomError(
        oracle,
        "InvalidRequestsDataLength",
      );
    });

    it("Should revert if module id is equal to 0", async () => {
      const requests = [
        { moduleId: 0, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[1] },
      ];

      const exitRequestData: ExitRequestData = {
        dataFormat: 1,
        data: encodeExitRequestsDataList(requests),
      };
      const hash = hashExitRequest(exitRequestData);
      const submitTx = await oracle.connect(authorizedEntity).submitExitRequestsHash(hash);
      await expect(submitTx).to.emit(oracle, "RequestsHashSubmitted").withArgs(hash);

      await expect(oracle.submitExitRequestsData(exitRequestData)).to.be.revertedWithCustomError(
        oracle,
        "InvalidModuleId",
      );
    });
  });

  describe("Exit Request Limits", () => {
    before(async () => {
      [admin, authorizedEntity, stranger] = await ethers.getSigners();

      await deploy();
      const reportLimitRole = await oracle.EXIT_REQUEST_LIMIT_MANAGER_ROLE();
      await oracle.grantRole(reportLimitRole, authorizedEntity);
      await consensus.advanceTimeBy(24 * 60 * 60);

      const submitRole = await oracle.SUBMIT_REPORT_HASH_ROLE();
      await oracle.grantRole(submitRole, authorizedEntity);
    });

    // -----------------------------------------------------------------------------
    // Shared test data
    // -----------------------------------------------------------------------------
    const MAX_EXIT_REQUESTS_LIMIT = 5;
    const EXITS_PER_FRAME = 1;
    const FRAME_DURATION = 48;

    // Data for case when limit is not enough to process entire request
    const VALIDATORS: ExitRequest[] = [
      { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
      { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
      { moduleId: 2, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[3] },
      { moduleId: 3, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[4] },
    ];

    const REQUEST = {
      dataFormat: DATA_FORMAT_LIST,
      data: encodeExitRequestsDataList(VALIDATORS),
    };

    const HASH_REQUEST = hashExitRequest(REQUEST);

    it("Should not allow to set limit without role", async () => {
      const reportLimitRole = await oracle.EXIT_REQUEST_LIMIT_MANAGER_ROLE();

      await expect(
        oracle.connect(stranger).setExitRequestLimit(MAX_EXIT_REQUESTS_LIMIT, EXITS_PER_FRAME, FRAME_DURATION),
      ).to.be.revertedWithOZAccessControlError(await stranger.getAddress(), reportLimitRole);
    });

    it("Should not allow to set exits per frame bigger than max limit", async () => {
      await expect(
        oracle.connect(authorizedEntity).setExitRequestLimit(10, 12, FRAME_DURATION),
      ).to.be.revertedWithCustomError(oracle, "TooLargeExitsPerFrame");
    });

    it("Should deliver request as it is below limit", async () => {
      const exitLimitTx = await oracle
        .connect(authorizedEntity)
        .setExitRequestLimit(MAX_EXIT_REQUESTS_LIMIT, EXITS_PER_FRAME, FRAME_DURATION);
      await expect(exitLimitTx)
        .to.emit(oracle, "ExitRequestsLimitSet")
        .withArgs(MAX_EXIT_REQUESTS_LIMIT, EXITS_PER_FRAME, FRAME_DURATION);

      exitRequests = [
        { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      ];

      exitRequest = {
        dataFormat: DATA_FORMAT_LIST,
        data: encodeExitRequestsDataList(exitRequests),
      };

      exitRequestHash = hashExitRequest(exitRequest);

      await oracle.connect(authorizedEntity).submitExitRequestsHash(exitRequestHash);
      const emitTx = await oracle.submitExitRequestsData(exitRequest);
      const timestamp = await oracle.getTime();

      for (const request of exitRequests) {
        await expect(emitTx)
          .to.emit(oracle, "ValidatorExitRequest")
          .withArgs(request.moduleId, request.nodeOpId, request.valIndex, request.valPubkey, timestamp);
      }

      await expect(emitTx).to.emit(oracle, "ExitDataProcessing").withArgs(exitRequestHash);
    });

    it("Should not allow to deliver if limit doesnt cover full request", async () => {
      await oracle.connect(authorizedEntity).submitExitRequestsHash(HASH_REQUEST);
      await expect(oracle.submitExitRequestsData(REQUEST))
        .to.be.revertedWithCustomError(oracle, "ExitRequestsLimitExceeded")
        .withArgs(5, 3);
    });

    it("Current limit should be equal to 0", async () => {
      const data = await oracle.getExitRequestLimitFullInfo();

      expect(data.maxExitRequestsLimit).to.equal(MAX_EXIT_REQUESTS_LIMIT);
      expect(data.exitsPerFrame).to.equal(EXITS_PER_FRAME);
      expect(data.frameDurationInSec).to.equal(FRAME_DURATION);
      expect(data.prevExitRequestsLimit).to.equal(3);
      expect(data.currentExitRequestsLimit).to.equal(3);
    });

    it("Should current limit should be increased on 2 if 2*48 seconds passed", async () => {
      await consensus.advanceTimeBy(2 * 4 * 12);
      const data = await oracle.getExitRequestLimitFullInfo();

      expect(data.maxExitRequestsLimit).to.equal(MAX_EXIT_REQUESTS_LIMIT);
      expect(data.exitsPerFrame).to.equal(EXITS_PER_FRAME);
      expect(data.frameDurationInSec).to.equal(FRAME_DURATION);
      expect(data.prevExitRequestsLimit).to.equal(3);
      expect(data.currentExitRequestsLimit).to.equal(5);
    });

    it("Should process requests after 2 frames passes", async () => {
      const emitTx = await oracle.submitExitRequestsData(REQUEST);
      const timestamp = await oracle.getTime();

      for (let i = 0; i < 5; i++) {
        const request = VALIDATORS[i];
        await expect(emitTx)
          .to.emit(oracle, "ValidatorExitRequest")
          .withArgs(request.moduleId, request.nodeOpId, request.valIndex, request.valPubkey, timestamp);
      }

      await expect(emitTx).to.emit(oracle, "ExitDataProcessing").withArgs(HASH_REQUEST);
    });

    it("Should revert when request already delivered", async () => {
      await expect(oracle.submitExitRequestsData(REQUEST)).to.be.revertedWithCustomError(
        oracle,
        "RequestsAlreadyDelivered",
      );
    });

    it("Should not give to set new maximum requests per report value without EXIT_REQUEST_LIMIT_MANAGER_ROLE role", async () => {
      const maxRequestsPerReport = 4;

      await expect(
        oracle.connect(stranger).setMaxValidatorsPerReport(maxRequestsPerReport),
      ).to.be.revertedWithOZAccessControlError(
        await stranger.getAddress(),
        await oracle.EXIT_REQUEST_LIMIT_MANAGER_ROLE(),
      );
    });

    it("Should not allow to set new maximum requests per report value eq to 0", async () => {
      const role = await oracle.EXIT_REQUEST_LIMIT_MANAGER_ROLE();
      await oracle.grantRole(role, authorizedEntity);

      await expect(oracle.connect(authorizedEntity).setMaxValidatorsPerReport(0))
        .to.be.revertedWithCustomError(oracle, "ZeroArgument")
        .withArgs("maxValidatorsPerReport");
    });

    it("Should not allow to process request larger than MAX_VALIDATORS_PER_REPORT", async () => {
      await consensus.advanceTimeBy(MAX_EXIT_REQUESTS_LIMIT * 4 * 12);
      const data = await oracle.getExitRequestLimitFullInfo();
      expect(data.currentExitRequestsLimit).to.equal(MAX_EXIT_REQUESTS_LIMIT);

      const maxRequestsPerReport = 4;

      const tx = await oracle.connect(authorizedEntity).setMaxValidatorsPerReport(maxRequestsPerReport);
      await expect(tx).to.emit(oracle, "SetMaxValidatorsPerReport").withArgs(maxRequestsPerReport);
      expect(await oracle.connect(authorizedEntity).getMaxValidatorsPerReport()).to.equal(maxRequestsPerReport);

      const exitRequestsRandom = [
        { moduleId: 100, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 101, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
        { moduleId: 102, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 103, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
        { moduleId: 104, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      ];

      const exitRequestRandom = {
        dataFormat: DATA_FORMAT_LIST,
        data: encodeExitRequestsDataList(exitRequestsRandom),
      };

      const exitRequestHashRandom = hashExitRequest(exitRequestRandom);

      await oracle.connect(authorizedEntity).submitExitRequestsHash(exitRequestHashRandom);

      await expect(oracle.submitExitRequestsData(exitRequestRandom))
        .to.be.revertedWithCustomError(oracle, "TooManyExitRequestsInReport")
        .withArgs(5, 4);
    });

    it("Should set maxExitRequestsLimit equal to 0 and return as currentExitRequestsLimit type(uint256).max", async () => {
      // can't set just maxExitRequestsLimit to 0, as it will be less than exitsPerFrame
      const exitLimitTx = await oracle.connect(authorizedEntity).setExitRequestLimit(0, 0, FRAME_DURATION);
      await expect(exitLimitTx).to.emit(oracle, "ExitRequestsLimitSet").withArgs(0, 0, FRAME_DURATION);

      const data = await oracle.getExitRequestLimitFullInfo();

      expect(data.maxExitRequestsLimit).to.equal(0);
      expect(data.exitsPerFrame).to.equal(0);
      expect(data.frameDurationInSec).to.equal(FRAME_DURATION);
      expect(data.prevExitRequestsLimit).to.equal(0);
      expect(data.currentExitRequestsLimit).to.equal(2n ** 256n - 1n);
    });

    it("Should not check limit, if maxLimitRequests equal to 0 (means limit was not set)", async () => {
      const exitRequestsRandom = [
        { moduleId: 100, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 101, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      ];

      const exitRequestRandom = {
        dataFormat: DATA_FORMAT_LIST,
        data: encodeExitRequestsDataList(exitRequestsRandom),
      };

      const exitRequestRandomHash = hashExitRequest(exitRequestRandom);

      await oracle.connect(authorizedEntity).submitExitRequestsHash(exitRequestRandomHash);

      const emitTx = await oracle.submitExitRequestsData(exitRequestRandom);
      const timestamp = await oracle.getTime();

      for (let i = 0; i < 2; i++) {
        const request = exitRequestsRandom[i];
        await expect(emitTx)
          .to.emit(oracle, "ValidatorExitRequest")
          .withArgs(request.moduleId, request.nodeOpId, request.valIndex, request.valPubkey, timestamp);
      }

      await expect(emitTx).to.emit(oracle, "ExitDataProcessing").withArgs(exitRequestRandomHash);

      const data = await oracle.getExitRequestLimitFullInfo();

      expect(data.maxExitRequestsLimit).to.equal(0);
      expect(data.exitsPerFrame).to.equal(0);
      expect(data.frameDurationInSec).to.equal(FRAME_DURATION);
      expect(data.prevExitRequestsLimit).to.equal(0);
      // as time is mocked and we didnt change it since last consume, currentExitRequestsLimit was not increased
      expect(data.currentExitRequestsLimit).to.equal(2n ** 256n - 1n);
    });
  });

  describe("Version changed", () => {
    // version can be changed during deploy
    // but we will change it via accessing storage

    const VALIDATORS: ExitRequest[] = [{ moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] }];

    const REQUEST = {
      dataFormat: DATA_FORMAT_LIST,
      data: encodeExitRequestsDataList(VALIDATORS),
    };

    const HASH_REQUEST = hashExitRequest(REQUEST);

    before(async () => {
      [admin, authorizedEntity, stranger] = await ethers.getSigners();

      await deploy();

      const role = await oracle.SUBMIT_REPORT_HASH_ROLE();
      await oracle.grantRole(role, authorizedEntity);
    });

    it("Check version", async () => {
      // set in initialize in deployVEBO
      expect(await oracle.getContractVersion()).to.equal(2);
    });

    it("Store exit hash", async () => {
      await oracle.connect(authorizedEntity).submitExitRequestsHash(HASH_REQUEST);
    });

    it("set new version", async () => {
      await oracle.setContractVersion(3);
      expect(await oracle.getContractVersion()).to.equal(3);
    });

    it("Should revert if request has old contract version", async () => {
      await expect(oracle.submitExitRequestsData(REQUEST))
        .to.be.revertedWithCustomError(oracle, "UnexpectedContractVersion")
        .withArgs(3, 2);
    });
  });
});
