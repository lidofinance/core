import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  HashConsensus__Harness,
  OracleReportSanityChecker,
  StakingModule__MockForKeyVerification,
  ValidatorsExitBus__Harness,
} from "typechain-types";

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

// Constants from WithdrawalCredentials.sol
const LEGACY_MODULE_ID = 1; // Module with 0x01 withdrawal credentials (32 ETH)
const LEGACY_MODULE_MAX_BALANCE_ETH = 32n; // 32 ETH
const MAXEB_MODULE_MAX_BALANCE_ETH = 2048n; // 2048 ETH

describe("ValidatorsExitBusOracle.sol:balanceIntegration", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let oracleReportSanityChecker: OracleReportSanityChecker;
  let admin: HardhatEthersSigner;
  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;
  let mockModules: {
    module1: StakingModule__MockForKeyVerification;
    module2: StakingModule__MockForKeyVerification;
    module3: StakingModule__MockForKeyVerification;
    module5: StakingModule__MockForKeyVerification;
    module7: StakingModule__MockForKeyVerification;
  };

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
    mockModules = deployed.mockModules;

    // Configure signing keys for Format 2 testing (key verification)
    // Set up keys for all combinations used in tests
    for (let i = 0; i < PUBKEYS.length; i++) {
      // Module 1 (legacy): keys for nodeOpId 1, keyIndex 1-5
      await mockModules.module1.setSigningKey(1, i + 1, PUBKEYS[i]);

      // Module 3 (MaxEB): keys for nodeOpId 1, keyIndex 10-14
      await mockModules.module3.setSigningKey(1, 10 + i, PUBKEYS[i]);

      // Module 3 (MaxEB): keys for nodeOpId 2, keyIndex 20
      // Multiple PUBKEYS can map to the same keyIndex for different tests
      await mockModules.module3.setSigningKey(2, 20, PUBKEYS[0]); // Used in mixed validator test

      // Module 5 (MaxEB): keys for nodeOpId 2, keyIndex 20
      await mockModules.module5.setSigningKey(2, 20, PUBKEYS[1]); // Used in MaxEB validator test
    }

    // Additional keys for "same balance" comparison test
    await mockModules.module1.setSigningKey(1, 100, PUBKEYS[0]); // Format 1 vs Format 2 test
    await mockModules.module3.setSigningKey(2, 200, PUBKEYS[1]); // Format 1 vs Format 2 test

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
        .grantRole(await oracleReportSanityChecker.MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE(), admin.address);
    });

    beforeEach(async () => {
      originalState = await Snapshot.take();
    });

    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    it("should pass sanity check for legacy validators (Format 2)", async () => {
      // Set limit to allow 10 legacy validators (320 ETH)
      const limit = LEGACY_MODULE_MAX_BALANCE_ETH * 10n;
      await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInEth(limit);

      const requests: ExitRequest[] = [
        { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 1, valPubkey: PUBKEYS[0] },
        { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 11, keyIndex: 2, valPubkey: PUBKEYS[1] },
        { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 12, keyIndex: 3, valPubkey: PUBKEYS[2] },
      ];

      const { reportData } = await prepareReportAndSubmitHash(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

      // Should not revert - balance is within limit
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
    });

    it("should pass sanity check for MaxEB validators (Format 2)", async () => {
      // Set limit to allow 2 MaxEB validators (4096 ETH)
      const limit = MAXEB_MODULE_MAX_BALANCE_ETH * 2n;
      await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInEth(limit);

      const requests: ExitRequest[] = [
        { moduleId: 3, nodeOpId: 1, valIndex: 10, keyIndex: 10, valPubkey: PUBKEYS[0] },
        { moduleId: 5, nodeOpId: 2, valIndex: 20, keyIndex: 20, valPubkey: PUBKEYS[1] },
      ];

      const { reportData } = await prepareReportAndSubmitHash(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

      // Should not revert - balance is within limit
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
    });

    it("should pass sanity check for mixed validators (Format 2)", async () => {
      // Set limit to allow: 5 legacy (160 ETH) + 1 MaxEB (2048 ETH) = 2208 ETH
      const limit = LEGACY_MODULE_MAX_BALANCE_ETH * 5n + MAXEB_MODULE_MAX_BALANCE_ETH * 1n;
      await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInEth(limit);

      const requests: ExitRequest[] = [
        { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 10, keyIndex: 1, valPubkey: PUBKEYS[0] },
        { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 11, keyIndex: 2, valPubkey: PUBKEYS[1] },
        { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 12, keyIndex: 3, valPubkey: PUBKEYS[2] },
        { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 13, keyIndex: 4, valPubkey: PUBKEYS[3] },
        { moduleId: LEGACY_MODULE_ID, nodeOpId: 1, valIndex: 14, keyIndex: 5, valPubkey: PUBKEYS[4] },
        { moduleId: 3, nodeOpId: 2, valIndex: 20, keyIndex: 20, valPubkey: PUBKEYS[0] },
      ];

      const { reportData } = await prepareReportAndSubmitHash(requests, DATA_FORMAT_LIST_WITH_KEY_INDEX);

      // Should not revert - balance is within limit
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
    });
  });
});
