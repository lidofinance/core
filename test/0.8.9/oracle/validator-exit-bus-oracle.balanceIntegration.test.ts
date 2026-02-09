import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, OracleReportSanityChecker, ValidatorsExitBus__Harness } from "typechain-types";

import { de0x, numberToHex, VEBO_CONSENSUS_VERSION } from "lib";

import { DATA_FORMAT_LIST, DATA_FORMAT_LIST_WITH_KEY_INDEX, deployVEBO, initVEBO } from "test/deploy";
import { Snapshot } from "test/suite";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
];

// Constants
const CURATED_MODULE_ID = 1;
const CURATED_MODULE_MAX_BALANCE_GWEI = 32_000_000_000n; // 32 ETH
const MAXEB_MODULE_MAX_BALANCE_GWEI = 2_048_000_000_000n; // 2048 ETH

describe("ValidatorsExitBusOracle.sol:balanceIntegration", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let oracleReportSanityChecker: OracleReportSanityChecker;
  let admin: HardhatEthersSigner;
  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;

  let oracleVersion: bigint;

  interface ExitRequest {
    moduleId: number;
    nodeOpId: number;
    valIndex: number;
    valPubkey: string;
    keyIndex?: number; // Optional for format 2
  }

  const encodeExitRequestHexV1 = ({ moduleId, nodeOpId, valIndex, valPubkey }: ExitRequest) => {
    const pubkeyHex = de0x(valPubkey);
    return numberToHex(moduleId, 3) + numberToHex(nodeOpId, 5) + numberToHex(valIndex, 8) + pubkeyHex;
  };

  const encodeExitRequestHexV2 = ({ moduleId, nodeOpId, valIndex, keyIndex, valPubkey }: ExitRequest) => {
    const pubkeyHex = de0x(valPubkey);
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

  const calcValidatorsExitBusReportDataHash = (items: {
    consensusVersion: bigint;
    refSlot: bigint;
    requestsCount: number;
    dataFormat: number;
    data: string;
  }) => {
    const reportData = [items.consensusVersion, items.refSlot, items.requestsCount, items.dataFormat, items.data];
    const reportDataHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["(uint256,uint256,uint256,uint256,bytes)"], [reportData]),
    );
    return reportDataHash;
  };

  const triggerConsensusOnHash = async (hash: string) => {
    const { refSlot } = await consensus.getCurrentFrame();
    await consensus.connect(member1).submitReport(refSlot, hash, VEBO_CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, hash, VEBO_CONSENSUS_VERSION);
    expect((await consensus.getConsensusState()).consensusReport).to.equal(hash);
  };

  const prepareReportAndSubmitHash = async (
    requests: ExitRequest[],
    dataFormat: number = DATA_FORMAT_LIST,
    options = { reportFields: {} },
  ) => {
    const { refSlot } = await consensus.getCurrentFrame();
    const reportData = {
      consensusVersion: VEBO_CONSENSUS_VERSION,
      dataFormat,
      refSlot,
      requestsCount: requests.length,
      data: encodeExitRequestsDataList(requests, dataFormat),
      ...options.reportFields,
    };

    const reportHash = calcValidatorsExitBusReportDataHash(reportData);

    await triggerConsensusOnHash(reportHash);

    return { reportData, reportHash };
  };

  before(async () => {
    const signers = await ethers.getSigners();
    admin = signers[0];
    member1 = signers[1];
    member2 = signers[2];
    member3 = signers[3];

    const deployed = await deployVEBO(await admin.getAddress());
    consensus = deployed.consensus;
    oracle = deployed.oracle;
    oracleReportSanityChecker = deployed.oracleReportSanityChecker;

    await initVEBO({
      admin: admin.address,
      oracle,
      consensus,
      resumeAfterDeploy: true,
    });

    await consensus.addMember(member1, 1);
    await consensus.addMember(member2, 2);
    await consensus.addMember(member3, 2);

    oracleVersion = await oracle.getContractVersion();
  });

  describe("Balance calculation integration with sanity checker", () => {
    let originalState: string;

    before(async () => {
      // Grant the role to admin for setting limits
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(await oracleReportSanityChecker.MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_GWEI_ROLE(), admin.address);
    });

    beforeEach(async () => {
      originalState = await Snapshot.take();
    });

    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    it("should pass sanity check for curated validators (Format 1)", async () => {
      // Set limit to allow 10 curated validators (320 ETH)
      const limit = CURATED_MODULE_MAX_BALANCE_GWEI * 10n;
      await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInGwei(limit);

      const requests: ExitRequest[] = [
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 11, valPubkey: PUBKEYS[1] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 12, valPubkey: PUBKEYS[2] },
      ];

      const { reportData } = await prepareReportAndSubmitHash(requests, DATA_FORMAT_LIST);

      // Should not revert - balance is within limit
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
    });

    it("should pass sanity check for MaxEB validators (Format 1)", async () => {
      // Set limit to allow 2 MaxEB validators (4096 ETH)
      const limit = MAXEB_MODULE_MAX_BALANCE_GWEI * 2n;
      await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInGwei(limit);

      const requests: ExitRequest[] = [
        { moduleId: 3, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
        { moduleId: 5, nodeOpId: 2, valIndex: 20, valPubkey: PUBKEYS[1] },
      ];

      const { reportData } = await prepareReportAndSubmitHash(requests, DATA_FORMAT_LIST);

      // Should not revert - balance is within limit
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
    });

    it("should pass sanity check for mixed validators (Format 1)", async () => {
      // Set limit to allow: 5 curated (160 ETH) + 1 MaxEB (2048 ETH) = 2208 ETH
      const limit = CURATED_MODULE_MAX_BALANCE_GWEI * 5n + MAXEB_MODULE_MAX_BALANCE_GWEI * 1n;
      await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInGwei(limit);

      const requests: ExitRequest[] = [
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 11, valPubkey: PUBKEYS[1] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 12, valPubkey: PUBKEYS[2] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 13, valPubkey: PUBKEYS[3] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 14, valPubkey: PUBKEYS[4] },
        { moduleId: 3, nodeOpId: 2, valIndex: 20, valPubkey: PUBKEYS[0] },
      ];

      const { reportData } = await prepareReportAndSubmitHash(requests, DATA_FORMAT_LIST);

      // Should not revert - balance is within limit
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
    });

    it("should revert when curated validators exceed limit (Format 1)", async () => {
      // Set limit to allow only 2 curated validators (64 ETH)
      const limit = CURATED_MODULE_MAX_BALANCE_GWEI * 2n;
      await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInGwei(limit);

      const requests: ExitRequest[] = [
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 11, valPubkey: PUBKEYS[1] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 12, valPubkey: PUBKEYS[2] }, // Exceeds limit
      ];

      const { reportData } = await prepareReportAndSubmitHash(requests, DATA_FORMAT_LIST);

      // Should revert - 3 validators = 96 ETH > 64 ETH limit
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectSumOfExitBalancePerReport")
        .withArgs(limit);
    });

    it("should revert when MaxEB validators exceed limit (Format 1)", async () => {
      // Set limit to allow only 1 MaxEB validator (2048 ETH)
      const limit = MAXEB_MODULE_MAX_BALANCE_GWEI * 1n;
      await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInGwei(limit);

      const requests: ExitRequest[] = [
        { moduleId: 3, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
        { moduleId: 5, nodeOpId: 2, valIndex: 20, valPubkey: PUBKEYS[1] }, // Exceeds limit
      ];

      const { reportData } = await prepareReportAndSubmitHash(requests, DATA_FORMAT_LIST);

      // Should revert - 2 validators = 4096 ETH > 2048 ETH limit
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectSumOfExitBalancePerReport")
        .withArgs(limit);
    });

    it("should pass sanity check for curated validators (Format 2)", async () => {
      // Set limit to allow 10 curated validators (320 ETH)
      const limit = CURATED_MODULE_MAX_BALANCE_GWEI * 10n;
      await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInGwei(limit);

      const requests: ExitRequest[] = [
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 1, valPubkey: PUBKEYS[0] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 11, keyIndex: 2, valPubkey: PUBKEYS[1] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 12, keyIndex: 3, valPubkey: PUBKEYS[2] },
      ];

      const { reportData } = await prepareReportAndSubmitHash(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

      // Should not revert - balance is within limit
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
    });

    it("should pass sanity check for MaxEB validators (Format 2)", async () => {
      // Set limit to allow 2 MaxEB validators (4096 ETH)
      const limit = MAXEB_MODULE_MAX_BALANCE_GWEI * 2n;
      await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInGwei(limit);

      const requests: ExitRequest[] = [
        { moduleId: 3, nodeOpId: 1, valIndex: 10, keyIndex: 10, valPubkey: PUBKEYS[0] },
        { moduleId: 5, nodeOpId: 2, valIndex: 20, keyIndex: 20, valPubkey: PUBKEYS[1] },
      ];

      const { reportData } = await prepareReportAndSubmitHash(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

      // Should not revert - balance is within limit
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
    });

    it("should pass sanity check for mixed validators (Format 2)", async () => {
      // Set limit to allow: 5 curated (160 ETH) + 1 MaxEB (2048 ETH) = 2208 ETH
      const limit = CURATED_MODULE_MAX_BALANCE_GWEI * 5n + MAXEB_MODULE_MAX_BALANCE_GWEI * 1n;
      await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInGwei(limit);

      const requests: ExitRequest[] = [
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 1, valPubkey: PUBKEYS[0] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 11, keyIndex: 2, valPubkey: PUBKEYS[1] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 12, keyIndex: 3, valPubkey: PUBKEYS[2] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 13, keyIndex: 4, valPubkey: PUBKEYS[3] },
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 14, keyIndex: 5, valPubkey: PUBKEYS[4] },
        { moduleId: 3, nodeOpId: 2, valIndex: 20, keyIndex: 20, valPubkey: PUBKEYS[0] },
      ];

      const { reportData } = await prepareReportAndSubmitHash(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

      // Should not revert - balance is within limit
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
    });

    it("should calculate same balance for Format 1 and Format 2 with same validators", async () => {
      const requestsV1: ExitRequest[] = [
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, valPubkey: PUBKEYS[0] },
        { moduleId: 3, nodeOpId: 2, valIndex: 20, valPubkey: PUBKEYS[1] },
      ];

      const requestsV2: ExitRequest[] = [
        { moduleId: CURATED_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 100, valPubkey: PUBKEYS[0] },
        { moduleId: 3, nodeOpId: 2, valIndex: 20, keyIndex: 200, valPubkey: PUBKEYS[1] },
      ];

      const dataV1 = encodeExitRequestsDataList(requestsV1, DATA_FORMAT_LIST);
      const dataV2 = encodeExitRequestsDataList(requestsV2, DATA_FORMAT_LIST_WITH_KEY_INDEX);

      // Verify both formats calculate the same balance
      const balanceV1 = await oracle.calculateTotalExitBalanceGwei(dataV1, DATA_FORMAT_LIST);
      const balanceV2 = await oracle.calculateTotalExitBalanceGwei(dataV2, DATA_FORMAT_LIST_WITH_KEY_INDEX);

      expect(balanceV1).to.equal(balanceV2, "Format 1 and Format 2 should calculate the same balance");

      // Set limit based on calculated balance and verify both formats pass sanity check
      const limit = balanceV1 + CURATED_MODULE_MAX_BALANCE_GWEI; // Add some headroom
      await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInGwei(limit);

      // Both should pass - same validators, same balance calculation
      const { reportData: reportDataV1 } = await prepareReportAndSubmitHash(requestsV1, DATA_FORMAT_LIST);
      await expect(oracle.connect(member1).submitReportData(reportDataV1, oracleVersion)).not.to.be.reverted;

      // Format 2 should also pass with the same limit
      const { reportData: reportDataV2 } = await prepareReportAndSubmitHash(requestsV2, DATA_FORMAT_LIST_WITH_KEY_INDEX);
      await expect(oracle.connect(member1).submitReportData(reportDataV2, oracleVersion)).not.to.be.reverted;
    });
  });
});
