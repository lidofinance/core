import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ValidatorsExitBus__Harness } from "typechain-types";

import { de0x, numberToHex } from "lib";

import { DATA_FORMAT_LIST, DATA_FORMAT_LIST_WITH_KEY_INDEX, deployVEBO } from "test/deploy";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
];

// Constants from ValidatorsExitBus.sol
const CURATED_MODULE_ID = 1;
const CURATED_MODULE_MAX_BALANCE_GWEI = 32_000_000_000n; // 32 ETH
const MAXEB_MODULE_MAX_BALANCE_GWEI = 2_048_000_000_000n; // 2048 ETH

describe("ValidatorsExitBusOracle.sol:balanceCalculation", () => {
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;

  interface ExitRequest {
    moduleId: number;
    nodeOpId: number;
    valIndex: number;
    valPubkey: string;
    keyIndex?: number; // Optional for format 2
  }

  const encodeExitRequestHexV1 = ({ moduleId, nodeOpId, valIndex, valPubkey }: ExitRequest) => {
    const pubkeyHex = de0x(valPubkey);
    expect(pubkeyHex.length).to.equal(48 * 2);
    return numberToHex(moduleId, 3) + numberToHex(nodeOpId, 5) + numberToHex(valIndex, 8) + pubkeyHex;
  };

  const encodeExitRequestHexV2 = ({ moduleId, nodeOpId, valIndex, keyIndex, valPubkey }: ExitRequest) => {
    const pubkeyHex = de0x(valPubkey);
    expect(pubkeyHex.length).to.equal(48 * 2);
    return (
      numberToHex(moduleId, 3) +
      numberToHex(nodeOpId, 5) +
      numberToHex(valIndex, 8) +
      numberToHex(keyIndex || 0, 8) +
      pubkeyHex
    );
  };

  const encodeExitRequestsDataList = (requests: ExitRequest[], dataFormat: number) => {
    const encoder = dataFormat === DATA_FORMAT_LIST ? encodeExitRequestHexV1 : encodeExitRequestHexV2;
    return "0x" + requests.map(encoder).join("");
  };

  before(async () => {
    const signers = await ethers.getSigners();
    admin = signers[0];

    const deployed = await deployVEBO(await admin.getAddress());
    oracle = deployed.oracle;
  });

  describe("_calculateTotalExitBalanceGwei", () => {
    describe("Format 1 (DATA_FORMAT_LIST)", () => {
      it("should calculate balance for single curated validator (32 ETH)", async () => {
        const requests: ExitRequest[] = [
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST);

        expect(totalBalance).to.equal(CURATED_MODULE_MAX_BALANCE_GWEI);
      });

      it("should calculate balance for single non-curated validator (2048 ETH)", async () => {
        const requests: ExitRequest[] = [{ moduleId: 3, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] }];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST);

        expect(totalBalance).to.equal(MAXEB_MODULE_MAX_BALANCE_GWEI);
      });

      it("should calculate balance for multiple curated validators", async () => {
        const requests: ExitRequest[] = [
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 11, valPubkey: PUBKEYS[1] },
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 12, valPubkey: PUBKEYS[2] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST);

        expect(totalBalance).to.equal(CURATED_MODULE_MAX_BALANCE_GWEI * 3n);
      });

      it("should calculate balance for multiple non-curated validators", async () => {
        const requests: ExitRequest[] = [
          { moduleId: 3, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
          { moduleId: 5, nodeOpId: 2, valIndex: 20, valPubkey: PUBKEYS[1] },
          { moduleId: 7, nodeOpId: 3, valIndex: 30, valPubkey: PUBKEYS[2] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST);

        expect(totalBalance).to.equal(MAXEB_MODULE_MAX_BALANCE_GWEI * 3n);
      });

      it("should calculate balance for mixed module types", async () => {
        const requests: ExitRequest[] = [
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
          { moduleId: 3, nodeOpId: 2, valIndex: 20, valPubkey: PUBKEYS[1] },
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 11, valPubkey: PUBKEYS[2] },
          { moduleId: 5, nodeOpId: 3, valIndex: 30, valPubkey: PUBKEYS[3] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST);

        const expected =
          CURATED_MODULE_MAX_BALANCE_GWEI * 2n + // 2 curated validators
          MAXEB_MODULE_MAX_BALANCE_GWEI * 2n; // 2 non-curated validators
        expect(totalBalance).to.equal(expected);
      });

      it("should return zero for empty data", async () => {
        const data = "0x";

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST);

        expect(totalBalance).to.equal(0n);
      });
    });

    describe("Format 2 (DATA_FORMAT_LIST_WITH_KEY_INDEX)", () => {
      it("should calculate balance for single curated validator (32 ETH)", async () => {
        const requests: ExitRequest[] = [
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 5, valPubkey: PUBKEYS[0] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        expect(totalBalance).to.equal(CURATED_MODULE_MAX_BALANCE_GWEI);
      });

      it("should calculate balance for single non-curated validator (2048 ETH)", async () => {
        const requests: ExitRequest[] = [
          { moduleId: 3, nodeOpId: 1, valIndex: 10, keyIndex: 7, valPubkey: PUBKEYS[0] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        expect(totalBalance).to.equal(MAXEB_MODULE_MAX_BALANCE_GWEI);
      });

      it("should calculate balance for multiple curated validators", async () => {
        const requests: ExitRequest[] = [
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 1, valPubkey: PUBKEYS[0] },
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 11, keyIndex: 2, valPubkey: PUBKEYS[1] },
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 12, keyIndex: 3, valPubkey: PUBKEYS[2] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        expect(totalBalance).to.equal(CURATED_MODULE_MAX_BALANCE_GWEI * 3n);
      });

      it("should calculate balance for multiple non-curated validators", async () => {
        const requests: ExitRequest[] = [
          { moduleId: 3, nodeOpId: 1, valIndex: 10, keyIndex: 10, valPubkey: PUBKEYS[0] },
          { moduleId: 5, nodeOpId: 2, valIndex: 20, keyIndex: 20, valPubkey: PUBKEYS[1] },
          { moduleId: 7, nodeOpId: 3, valIndex: 30, keyIndex: 30, valPubkey: PUBKEYS[2] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        expect(totalBalance).to.equal(MAXEB_MODULE_MAX_BALANCE_GWEI * 3n);
      });

      it("should calculate balance for mixed module types", async () => {
        const requests: ExitRequest[] = [
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 1, valPubkey: PUBKEYS[0] },
          { moduleId: 3, nodeOpId: 2, valIndex: 20, keyIndex: 2, valPubkey: PUBKEYS[1] },
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 11, keyIndex: 3, valPubkey: PUBKEYS[2] },
          { moduleId: 5, nodeOpId: 3, valIndex: 30, keyIndex: 4, valPubkey: PUBKEYS[3] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const expected =
          CURATED_MODULE_MAX_BALANCE_GWEI * 2n + // 2 curated validators
          MAXEB_MODULE_MAX_BALANCE_GWEI * 2n; // 2 non-curated validators
        expect(totalBalance).to.equal(expected);
      });

      it("should return zero for empty data", async () => {
        const data = "0x";

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        expect(totalBalance).to.equal(0n);
      });

      it("should ignore keyIndex when calculating balance", async () => {
        // Same module, different keyIndexes should result in same total balance
        const requests1: ExitRequest[] = [
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 1, valPubkey: PUBKEYS[0] },
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 11, keyIndex: 2, valPubkey: PUBKEYS[1] },
        ];
        const requests2: ExitRequest[] = [
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 100, valPubkey: PUBKEYS[0] },
          { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 11, keyIndex: 200, valPubkey: PUBKEYS[1] },
        ];

        const data1 = encodeExitRequestsDataList(requests1, DATA_FORMAT_LIST_WITH_KEY_INDEX);
        const data2 = encodeExitRequestsDataList(requests2, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const totalBalance1 = await oracle.calculateTotalExitBalanceGwei(data1, DATA_FORMAT_LIST_WITH_KEY_INDEX);
        const totalBalance2 = await oracle.calculateTotalExitBalanceGwei(data2, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        expect(totalBalance1).to.equal(totalBalance2);
        expect(totalBalance1).to.equal(CURATED_MODULE_MAX_BALANCE_GWEI * 2n);
      });
    });

    describe("Edge cases", () => {
      it("should handle large number of validators", async () => {
        const requests: ExitRequest[] = [];
        for (let i = 0; i < 100; i++) {
          requests.push({
            moduleId: CURATED_MODULE_ID,
            nodeOpId: 1,
            valIndex: i,
            valPubkey: PUBKEYS[i % PUBKEYS.length],
          });
        }
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST);

        expect(totalBalance).to.equal(CURATED_MODULE_MAX_BALANCE_GWEI * 100n);
      });

      it("should handle module ID 0 (treated as non-curated)", async () => {
        const requests: ExitRequest[] = [{ moduleId: 0, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] }];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST);

        // Module 0 is not curated, so should use MAXEB balance
        expect(totalBalance).to.equal(MAXEB_MODULE_MAX_BALANCE_GWEI);
      });

      it("should handle very large module IDs (treated as non-curated)", async () => {
        const requests: ExitRequest[] = [{ moduleId: 999, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] }];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceGwei(data, DATA_FORMAT_LIST);

        // Module 999 is not curated, so should use MAXEB balance
        expect(totalBalance).to.equal(MAXEB_MODULE_MAX_BALANCE_GWEI);
      });
    });
  });
});
