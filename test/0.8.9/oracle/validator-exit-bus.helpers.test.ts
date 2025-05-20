import { expect } from "chai";
import { keccak256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ValidatorsExitBus__Harness } from "typechain-types";

import { de0x, numberToHex } from "lib";

import { deployVEBO, initVEBO } from "test/deploy";
import { Snapshot } from "test/suite";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
];

const DATA_FORMAT_LIST = 1;

describe("ValidatorsExitBusOracle.sol:helpers", () => {
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;

  interface ExitRequest {
    moduleId: number;
    nodeOpId: number;
    valIndex: number;
    valPubkey: string;
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
    const consensus = deployed.consensus;

    await initVEBO({
      admin: admin.address,
      oracle,
      consensus,
      resumeAfterDeploy: true,
      lastProcessingRefSlot: 1, //LAST_PROCESSING_REF_SLOT,
    });
  };

  before(async () => {
    [admin] = await ethers.getSigners();

    await deploy();
  });

  context("unpackExitRequest", () => {
    let originalState: string;

    before(async () => {
      originalState = await Snapshot.take();
    });

    after(async () => await Snapshot.restore(originalState));

    it("reports items unpacked correctly (happy path)", async () => {
      const exitRequests = [
        { moduleId: 1, nodeOpId: 1, valIndex: 1, valPubkey: PUBKEYS[0] },
        { moduleId: 2, nodeOpId: 2, valIndex: 2, valPubkey: PUBKEYS[1] },
        { moduleId: 3, nodeOpId: 3, valIndex: 3, valPubkey: PUBKEYS[2] },
        { moduleId: 4, nodeOpId: 4, valIndex: 4, valPubkey: PUBKEYS[3] },
      ];

      const data = encodeExitRequestsDataList(exitRequests);

      for (let i = 0; i < exitRequests.length; i++) {
        const { pubkey, nodeOpId, moduleId, valIndex } = await oracle.unpackExitRequest(data, DATA_FORMAT_LIST, i);
        const expectedRequest = exitRequests[i];

        expect(pubkey).to.equal(expectedRequest.valPubkey);
        expect(nodeOpId).to.equal(expectedRequest.nodeOpId);
        expect(moduleId).to.equal(expectedRequest.moduleId);
        expect(valIndex).to.equal(expectedRequest.valIndex);
      }
    });

    it("reverts if data format is not LIST (i.e., not 1)", async () => {
      const exitRequests = [{ moduleId: 1, nodeOpId: 1, valIndex: 1, valPubkey: PUBKEYS[0] }];
      const data = encodeExitRequestsDataList(exitRequests);
      const invalidDataFormat = 2;

      await expect(oracle.unpackExitRequest(data, invalidDataFormat, 0))
        .to.be.revertedWithCustomError(oracle, "UnsupportedRequestsDataFormat")
        .withArgs(invalidDataFormat);
    });

    it("reverts if exitRequests length is not multiple of PACKED_REQUEST_LENGTH", async () => {
      // PACKED_REQUEST_LENGTH is 64 bytes. Let's make the data 63 bytes instead.
      await expect(oracle.unpackExitRequest("0x" + "ff".repeat(63), DATA_FORMAT_LIST, 0)).to.be.revertedWithCustomError(
        oracle,
        "InvalidRequestsDataLength",
      );

      // PACKED_REQUEST_LENGTH is 64 bytes. Let's make the data 65 bytes instead.
      await expect(oracle.unpackExitRequest("0x" + "ff".repeat(65), DATA_FORMAT_LIST, 0)).to.be.revertedWithCustomError(
        oracle,
        "InvalidRequestsDataLength",
      );
    });

    it("reverts if the index is out of range (ExitDataIndexOutOfRange)", async () => {
      // We have only 1 request => 64 bytes
      const exitRequests = [{ moduleId: 1, nodeOpId: 1, valIndex: 1, valPubkey: PUBKEYS[0] }];
      const data = encodeExitRequestsDataList(exitRequests);

      // There is exactly 1 request, so index=1 is out of range (should be 0)
      await expect(oracle.unpackExitRequest(data, DATA_FORMAT_LIST, 1))
        .to.be.revertedWithCustomError(oracle, "ExitDataIndexOutOfRange")
        .withArgs(1, 1); // index=1, total=1
    });
  });

  context("getExitRequestsDeliveryHistory", () => {
    let originalState: string;

    before(async () => {
      originalState = await Snapshot.take();
    });

    after(async () => await Snapshot.restore(originalState));

    it("reverts if exitRequestsHash was never submitted (contractVersion = 0)", async () => {
      const fakeHash = keccak256("0x1111");

      await expect(oracle.getExitRequestsDeliveryHistory(fakeHash)).to.be.revertedWithCustomError(
        oracle,
        "ExitHashNotSubmitted",
      );
    });

    it("Returns empty history if deliveryHistoryLength is equal to 0", async () => {
      const MAX_UINT32 = 2 ** 32 - 1;
      const exitRequestsHash = keccak256("0x1111");
      const deliveryHistoryLength = 0;
      const contractVersion = 42;
      const lastDeliveredExitDataIndex = MAX_UINT32;
      const lastDeliveredExitDataTimestamp = MAX_UINT32;

      // Call the helper to store the hash
      await oracle.storeNewHashRequestStatus(
        exitRequestsHash,
        contractVersion,
        deliveryHistoryLength,
        lastDeliveredExitDataIndex,
        lastDeliveredExitDataTimestamp,
      );

      const returnedHistory = await oracle.getExitRequestsDeliveryHistory(exitRequestsHash);

      expect(returnedHistory.length).to.equal(0);
    });

    it("Returns array with single record if deliveryHistoryLength is equal to 1", async () => {
      const exitRequestsHash = keccak256("0x2222");
      const deliveryHistoryLength = 1;
      const timestamp = await oracle.getTime();
      const contractVersion = 42;
      const lastDeliveredExitDataIndex = 1;

      // Call the helper to store the hash
      await oracle.storeNewHashRequestStatus(
        exitRequestsHash,
        contractVersion,
        deliveryHistoryLength,
        lastDeliveredExitDataIndex,
        timestamp,
      );

      const returnedHistory = await oracle.getExitRequestsDeliveryHistory(exitRequestsHash);

      expect(returnedHistory.length).to.equal(1);
      const [firstDelivery] = returnedHistory;
      expect(firstDelivery.lastDeliveredExitDataIndex).to.equal(lastDeliveredExitDataIndex);
    });

    it("Returns array with multiple reconrds if deliveryHistoryLength is equal to ", async () => {
      const exitRequestsHash = keccak256("0x3333");
      const deliveryHistoryLength = 2;
      const timestamp = await oracle.getTime();
      const contractVersion = 42;
      // Call the helper to store the hash
      await oracle.storeNewHashRequestStatus(
        exitRequestsHash,
        contractVersion,
        deliveryHistoryLength,
        1,
        timestamp + 1n,
      );

      await oracle.storeDeliveryEntry(exitRequestsHash, 0, timestamp);

      await oracle.storeDeliveryEntry(exitRequestsHash, 1, timestamp + 1n);

      const returnedHistory = await oracle.getExitRequestsDeliveryHistory(exitRequestsHash);

      expect(returnedHistory.length).to.equal(2);
      const [firstDelivery, secondDelivery] = returnedHistory;
      expect(firstDelivery.lastDeliveredExitDataIndex).to.equal(0);
      expect(firstDelivery.timestamp).to.equal(timestamp);

      expect(secondDelivery.lastDeliveredExitDataIndex).to.equal(1);
      expect(secondDelivery.timestamp).to.equal(timestamp + 1n);
    });
  });
});
