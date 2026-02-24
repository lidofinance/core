import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StakingRouter__MockForValidatorsExitBus,ValidatorsExitBus__Harness } from "typechain-types";

import { de0x, numberToHex } from "lib";

import { DATA_FORMAT_LIST, DATA_FORMAT_LIST_WITH_KEY_INDEX, deployVEBO } from "test/deploy";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
];

// Module IDs used in tests
const LEGACY_MODULE_ID = 1; // Module with 0x01 withdrawal credentials (32 ETH)
const MAXEB_MODULE_ID_1 = 3; // Module with 0x02 withdrawal credentials (2048 ETH)
const MAXEB_MODULE_ID_2 = 5; // Another module with 0x02 withdrawal credentials
const MAXEB_MODULE_ID_3 = 7; // Another module with 0x02 withdrawal credentials

// Balance constants from WithdrawalCredentials.sol
const LEGACY_MODULE_MAX_BALANCE_ETH = 32n; // 32 ETH
const MAXEB_MODULE_MAX_BALANCE_ETH = 2048n; // 2048 ETH

describe("ValidatorsExitBusOracle.sol:balanceCalculation", () => {
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;
  let stakingRouter: StakingRouter__MockForValidatorsExitBus;

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
    stakingRouter = deployed.stakingRouter as StakingRouter__MockForValidatorsExitBus;
  });

  describe("_calculateTotalExitBalanceEth", () => {
    describe("Format 1 (DATA_FORMAT_LIST)", () => {
      it("should calculate balance for single legacy validator (32 ETH)", async () => {
        const requests: ExitRequest[] = [
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST);

        expect(totalBalance).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH);
      });

      it("should calculate balance for single MaxEB validator (2048 ETH)", async () => {
        const requests: ExitRequest[] = [
          { moduleId: MAXEB_MODULE_ID_1, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST);

        expect(totalBalance).to.equal(MAXEB_MODULE_MAX_BALANCE_ETH);
      });

      it("should calculate balance for multiple legacy validators", async () => {
        const requests: ExitRequest[] = [
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 11, valPubkey: PUBKEYS[1] },
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 12, valPubkey: PUBKEYS[2] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST);

        expect(totalBalance).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH * 3n);
      });

      it("should calculate balance for multiple MaxEB validators", async () => {
        const requests: ExitRequest[] = [
          { moduleId: MAXEB_MODULE_ID_1, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
          { moduleId: MAXEB_MODULE_ID_2, nodeOpId: 2, valIndex: 20, valPubkey: PUBKEYS[1] },
          { moduleId: MAXEB_MODULE_ID_3, nodeOpId: 3, valIndex: 30, valPubkey: PUBKEYS[2] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST);

        expect(totalBalance).to.equal(MAXEB_MODULE_MAX_BALANCE_ETH * 3n);
      });

      it("should calculate balance for mixed module types", async () => {
        const requests: ExitRequest[] = [
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
          { moduleId: MAXEB_MODULE_ID_1, nodeOpId: 2, valIndex: 20, valPubkey: PUBKEYS[1] },
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 11, valPubkey: PUBKEYS[2] },
          { moduleId: MAXEB_MODULE_ID_2, nodeOpId: 3, valIndex: 30, valPubkey: PUBKEYS[3] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST);

        const expected =
          LEGACY_MODULE_MAX_BALANCE_ETH * 2n + // 2 legacy validators
          MAXEB_MODULE_MAX_BALANCE_ETH * 2n; // 2 MaxEB validators
        expect(totalBalance).to.equal(expected);
      });

      it("should return zero for empty data", async () => {
        const data = "0x";

        const totalBalance = await oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST);

        expect(totalBalance).to.equal(0n);
      });
    });

    describe("Format 2 (DATA_FORMAT_LIST_WITH_KEY_INDEX)", () => {
      it("should calculate balance for single legacy validator (32 ETH)", async () => {
        const requests: ExitRequest[] = [
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 5, valPubkey: PUBKEYS[0] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const totalBalance = await oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        expect(totalBalance).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH);
      });

      it("should calculate balance for single MaxEB validator (2048 ETH)", async () => {
        const requests: ExitRequest[] = [
          { moduleId: MAXEB_MODULE_ID_1, nodeOpId: 1, valIndex: 10, keyIndex: 7, valPubkey: PUBKEYS[0] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const totalBalance = await oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        expect(totalBalance).to.equal(MAXEB_MODULE_MAX_BALANCE_ETH);
      });

      it("should calculate balance for multiple legacy validators", async () => {
        const requests: ExitRequest[] = [
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 1, valPubkey: PUBKEYS[0] },
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 11, keyIndex: 2, valPubkey: PUBKEYS[1] },
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 12, keyIndex: 3, valPubkey: PUBKEYS[2] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const totalBalance = await oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        expect(totalBalance).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH * 3n);
      });

      it("should calculate balance for multiple MaxEB validators", async () => {
        const requests: ExitRequest[] = [
          { moduleId: MAXEB_MODULE_ID_1, nodeOpId: 1, valIndex: 10, keyIndex: 10, valPubkey: PUBKEYS[0] },
          { moduleId: MAXEB_MODULE_ID_2, nodeOpId: 2, valIndex: 20, keyIndex: 20, valPubkey: PUBKEYS[1] },
          { moduleId: MAXEB_MODULE_ID_3, nodeOpId: 3, valIndex: 30, keyIndex: 30, valPubkey: PUBKEYS[2] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const totalBalance = await oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        expect(totalBalance).to.equal(MAXEB_MODULE_MAX_BALANCE_ETH * 3n);
      });

      it("should calculate balance for mixed module types", async () => {
        const requests: ExitRequest[] = [
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 1, valPubkey: PUBKEYS[0] },
          { moduleId: MAXEB_MODULE_ID_1, nodeOpId: 2, valIndex: 20, keyIndex: 2, valPubkey: PUBKEYS[1] },
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 11, keyIndex: 3, valPubkey: PUBKEYS[2] },
          { moduleId: MAXEB_MODULE_ID_2, nodeOpId: 3, valIndex: 30, keyIndex: 4, valPubkey: PUBKEYS[3] },
        ];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const totalBalance = await oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const expected =
          LEGACY_MODULE_MAX_BALANCE_ETH * 2n + // 2 legacy validators
          MAXEB_MODULE_MAX_BALANCE_ETH * 2n; // 2 MaxEB validators
        expect(totalBalance).to.equal(expected);
      });

      it("should return zero for empty data", async () => {
        const data = "0x";

        const totalBalance = await oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        expect(totalBalance).to.equal(0n);
      });

      it("should ignore keyIndex when calculating balance", async () => {
        // Same module, different keyIndexes should result in same total balance
        const requests1: ExitRequest[] = [
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 1, valPubkey: PUBKEYS[0] },
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 11, keyIndex: 2, valPubkey: PUBKEYS[1] },
        ];
        const requests2: ExitRequest[] = [
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 100, valPubkey: PUBKEYS[0] },
          { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 11, keyIndex: 200, valPubkey: PUBKEYS[1] },
        ];

        const data1 = encodeExitRequestsDataList(requests1, DATA_FORMAT_LIST_WITH_KEY_INDEX);
        const data2 = encodeExitRequestsDataList(requests2, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        const totalBalance1 = await oracle.calculateTotalExitBalanceEth(data1, DATA_FORMAT_LIST_WITH_KEY_INDEX);
        const totalBalance2 = await oracle.calculateTotalExitBalanceEth(data2, DATA_FORMAT_LIST_WITH_KEY_INDEX);

        expect(totalBalance1).to.equal(totalBalance2);
        expect(totalBalance1).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH * 2n);
      });
    });

    describe("Edge cases", () => {
      it("should handle large number of validators", async () => {
        const requests: ExitRequest[] = [];
        for (let i = 0; i < 100; i++) {
          requests.push({
            moduleId: LEGACY_MODULE_ID,
            nodeOpId: 1,
            valIndex: i,
            valPubkey: PUBKEYS[i % PUBKEYS.length],
          });
        }
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST);

        expect(totalBalance).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH * 100n);
      });

      it("should handle module with 0x02 withdrawal credentials (MaxEB)", async () => {
        const { oracle: newOracle, stakingRouter: localRouter } = await deployVEBO(await admin.getAddress());

        // Configure module 999 as MaxEB (0x02)
        await localRouter.setStakingModuleWithdrawalCredentialsType(999, 0x02);

        const requests: ExitRequest[] = [{ moduleId: 999, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] }];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await newOracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST);
        expect(totalBalance).to.equal(MAXEB_MODULE_MAX_BALANCE_ETH);
      });

      it("should handle module with 0x01 withdrawal credentials (Legacy)", async () => {
        const { oracle: newOracle, stakingRouter: localRouter } = await deployVEBO(await admin.getAddress());

        // Configure module 888 as Legacy (0x01)
        await localRouter.setStakingModuleWithdrawalCredentialsType(888, 0x01);

        const requests: ExitRequest[] = [{ moduleId: 888, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] }];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        const totalBalance = await newOracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST);
        expect(totalBalance).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH);
      });

      it("reverts for unconfigured modules", async () => {
        // Module 777 is not configured in the router
        const requests: ExitRequest[] = [{ moduleId: 777, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] }];
        const data = encodeExitRequestsDataList(requests, DATA_FORMAT_LIST);

        await expect(oracle.calculateTotalExitBalanceEth(data, DATA_FORMAT_LIST)).to.be.revertedWithCustomError(
          stakingRouter,
          "StakingModuleUnregistered",
        );
      });
    });
  });
});
