import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, ValidatorsExitBus__Harness } from "typechain-types";

import { de0x, numberToHex } from "lib";

import { DATA_FORMAT_LIST, deployVEBO, initVEBO } from "test/deploy";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
];

describe("ValidatorsExitBusOracle.sol:submitExitRequestsData", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;

  let exitRequests: ExitRequest[];
  let exitRequestHash: string;
  let exitRequest: ExitRequestData;
  let authorizedEntity: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const LAST_PROCESSING_REF_SLOT = 1;

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

  before(async () => {
    [admin, authorizedEntity, stranger] = await ethers.getSigners();

    await deploy();
  });

  it("Initially, report was not submitted", async () => {
    exitRequests = [
      { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
      { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
      { moduleId: 2, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[3] },
    ];

    exitRequest = { dataFormat: DATA_FORMAT_LIST, data: encodeExitRequestsDataList(exitRequests) };

    await expect(oracle.submitExitRequestsData(exitRequest))
      .to.be.revertedWithCustomError(oracle, "ExitHashNotSubmitted")
      .withArgs();
  });

  it("Should revert without SUBMIT_REPORT_HASH_ROLE role", async () => {
    const request = [exitRequest.data, exitRequest.dataFormat];
    const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["(bytes, uint256)"], [request]));

    await expect(oracle.connect(stranger).submitExitRequestsHash(hash)).to.be.revertedWithOZAccessControlError(
      await stranger.getAddress(),
      await oracle.SUBMIT_REPORT_HASH_ROLE(),
    );
  });

  it("Should store exit hash for authorized entity", async () => {
    const role = await oracle.SUBMIT_REPORT_HASH_ROLE();

    await oracle.grantRole(role, authorizedEntity);

    exitRequestHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], [exitRequest.data, exitRequest.dataFormat]),
    );

    const submitTx = await oracle.connect(authorizedEntity).submitExitRequestsHash(exitRequestHash);

    await expect(submitTx).to.emit(oracle, "RequestsHashSubmitted").withArgs(exitRequestHash);
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
    const request = [exitRequest.data, 2];
    const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], request));
    const submitTx = await oracle.connect(authorizedEntity).submitExitRequestsHash(hash);
    await expect(submitTx).to.emit(oracle, "RequestsHashSubmitted").withArgs(hash);
    exitRequest = { dataFormat: 2, data: encodeExitRequestsDataList(exitRequests) };
    await expect(oracle.submitExitRequestsData(exitRequest))
      .to.be.revertedWithCustomError(oracle, "UnsupportedRequestsDataFormat")
      .withArgs(2);
  });

  describe("Exit Request Limits", function () {
    before(async () => {
      const role = await oracle.EXIT_REPORT_LIMIT_ROLE();
      await oracle.grantRole(role, authorizedEntity);
      await consensus.advanceTimeBy(24 * 60 * 60);
    });

    it("Should deliver request fully as it is below limit", async () => {
      const exitLimitTx = await oracle.connect(authorizedEntity).setExitRequestLimit(5, 1, 48);
      await expect(exitLimitTx).to.emit(oracle, "ExitRequestsLimitSet").withArgs(5, 1, 48);

      exitRequests = [
        { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      ];

      exitRequest = {
        dataFormat: DATA_FORMAT_LIST,
        data: encodeExitRequestsDataList(exitRequests),
      };

      exitRequestHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], [exitRequest.data, exitRequest.dataFormat]),
      );

      await oracle.connect(authorizedEntity).submitExitRequestsHash(exitRequestHash);
      const emitTx = await oracle.submitExitRequestsData(exitRequest);
      const timestamp = await oracle.getTime();

      for (const request of exitRequests) {
        await expect(emitTx)
          .to.emit(oracle, "ValidatorExitRequest")
          .withArgs(request.moduleId, request.nodeOpId, request.valIndex, request.valPubkey, timestamp);
      }
    });

    it("Should deliver part of request equal to remaining limit", async () => {
      exitRequests = [
        { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
        { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
        { moduleId: 2, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[3] },
        { moduleId: 3, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[4] },
      ];

      exitRequest = {
        dataFormat: DATA_FORMAT_LIST,
        data: encodeExitRequestsDataList(exitRequests),
      };

      exitRequestHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], [exitRequest.data, exitRequest.dataFormat]),
      );

      await oracle.connect(authorizedEntity).submitExitRequestsHash(exitRequestHash);
      const emitTx = await oracle.submitExitRequestsData(exitRequest);
      const timestamp = await oracle.getTime();

      for (let i = 0; i < 3; i++) {
        const request = exitRequests[i];
        await expect(emitTx)
          .to.emit(oracle, "ValidatorExitRequest")
          .withArgs(request.moduleId, request.nodeOpId, request.valIndex, request.valPubkey, timestamp);
      }
    });

    it("Should revert when limit exceeded for the frame", async () => {
      exitRequests = [
        { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
        { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
        { moduleId: 2, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[3] },
        { moduleId: 3, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[4] },
      ];

      exitRequest = {
        dataFormat: DATA_FORMAT_LIST,
        data: encodeExitRequestsDataList(exitRequests),
      };

      await expect(oracle.submitExitRequestsData(exitRequest))
        .to.be.revertedWithCustomError(oracle, "ExitRequestsLimit")
        .withArgs(2, 0);
    });

    it("Should process remaining requests after a day passes", async () => {
      await consensus.advanceTimeBy(2 * 4 * 12);

      exitRequests = [
        { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
        { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
        { moduleId: 2, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[3] },
        { moduleId: 3, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[4] },
      ];

      exitRequest = {
        dataFormat: DATA_FORMAT_LIST,
        data: encodeExitRequestsDataList(exitRequests),
      };

      const emitTx = await oracle.submitExitRequestsData(exitRequest);
      const timestamp = await oracle.getTime();

      for (let i = 3; i < 5; i++) {
        const request = exitRequests[i];
        await expect(emitTx)
          .to.emit(oracle, "ValidatorExitRequest")
          .withArgs(request.moduleId, request.nodeOpId, request.valIndex, request.valPubkey, timestamp);
      }
    });

    it("Should revert when no new requests to deliver", async () => {
      exitRequests = [
        { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
        { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
        { moduleId: 2, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[3] },
        { moduleId: 3, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[4] },
      ];

      await expect(oracle.submitExitRequestsData(exitRequest)).to.be.revertedWithCustomError(
        oracle,
        "RequestsAlreadyDelivered",
      );
    });

    it("Should revert if maxBatchSize exceeded", async () => {
      const role = await oracle.MAX_VALIDATORS_PER_BATCH_ROLE();
      await oracle.grantRole(role, authorizedEntity);

      const maxRequestsPerBatch = 4;

      await oracle.connect(authorizedEntity).setMaxRequestsPerBatch(maxRequestsPerBatch);

      exitRequests = [
        { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
        { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
        { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
        { moduleId: 2, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[3] },
        { moduleId: 3, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[4] },
      ];

      await expect(oracle.submitExitRequestsData(exitRequest))
        .to.be.revertedWithCustomError(oracle, "MaxRequestsBatchSizeExceeded")
        .withArgs(exitRequests.length, maxRequestsPerBatch);
    });
  });
});
