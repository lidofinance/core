import { expect } from "chai";
import { ContractTransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, ValidatorsExitBus__Harness } from "typechain-types";

import { de0x, numberToHex, VEBO_CONSENSUS_VERSION } from "lib";

import { DATA_FORMAT_LIST, deployVEBO, initVEBO } from "test/deploy";
import { Snapshot } from "test/suite";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
];

describe("ValidatorsExitBusOracle.sol:accessControl", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;
  let originalState: string;

  let initTx: ContractTransactionResponse;
  let oracleVersion: bigint;
  let exitRequests: ExitRequest[];
  let reportFields: ReportFields;
  let reportHash: string;

  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let account1: HardhatEthersSigner;

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

  const deploy = async () => {
    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;

    initTx = await initVEBO({ admin: admin.address, oracle, consensus, resumeAfterDeploy: true });

    oracleVersion = await oracle.getContractVersion();

    await consensus.addMember(member1, 1);
    await consensus.addMember(member2, 2);
    await consensus.addMember(member3, 2);

    const { refSlot } = await consensus.getCurrentFrame();
    exitRequests = [
      { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
      { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
    ];

    reportFields = {
      consensusVersion: VEBO_CONSENSUS_VERSION,
      refSlot: refSlot,
      dataFormat: DATA_FORMAT_LIST,
      requestsCount: exitRequests.length,
      data: encodeExitRequestsDataList(exitRequests),
    };

    reportHash = calcValidatorsExitBusReportDataHash(reportFields);
    await consensus.connect(member1).submitReport(refSlot, reportHash, VEBO_CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, reportHash, VEBO_CONSENSUS_VERSION);
  };

  before(async () => {
    [admin, member1, member2, member3, stranger, account1] = await ethers.getSigners();

    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;

    initTx = await initVEBO({ admin: admin.address, oracle, consensus, resumeAfterDeploy: true });

    oracleVersion = await oracle.getContractVersion();

    await consensus.addMember(member1, 1);
    await consensus.addMember(member2, 2);
    await consensus.addMember(member3, 2);

    const { refSlot } = await consensus.getCurrentFrame();
    exitRequests = [
      { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
      { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
    ];

    reportFields = {
      consensusVersion: VEBO_CONSENSUS_VERSION,
      dataFormat: DATA_FORMAT_LIST,
      // consensusVersion: CONSENSUS_VERSION,
      refSlot: refSlot,
      requestsCount: exitRequests.length,
      data: encodeExitRequestsDataList(exitRequests),
    };

    reportHash = calcValidatorsExitBusReportDataHash(reportFields);

    await consensus.connect(member1).submitReport(refSlot, reportHash, VEBO_CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, reportHash, VEBO_CONSENSUS_VERSION);

    await deploy();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("deploying", () => {
    it("deploying accounting oracle", async () => {
      expect(oracle).to.be.not.null;
      expect(consensus).to.be.not.null;
      expect(initTx).to.be.not.null;
      expect(oracleVersion).to.be.not.null;
      expect(exitRequests).to.be.not.null;
      expect(reportFields).to.be.not.null;
      expect(reportHash).to.be.not.null;
    });
  });

  context("DEFAULT_ADMIN_ROLE", () => {
    context("Admin is set at initialize", () => {
      it("should set admin at initialize", async () => {
        const DEFAULT_ADMIN_ROLE = await oracle.DEFAULT_ADMIN_ROLE();
        await expect(initTx).to.emit(oracle, "RoleGranted").withArgs(DEFAULT_ADMIN_ROLE, admin, admin);
      });
      it("should revert without admin address", async () => {
        await expect(
          oracle.initialize(ZeroAddress, await consensus.getAddress(), VEBO_CONSENSUS_VERSION, 0, 600, 13000, 1, 48),
        ).to.be.revertedWithCustomError(oracle, "AdminCannotBeZero");
      });
    });
  });

  context("PAUSE_ROLE", () => {
    it("should revert without PAUSE_ROLE role", async () => {
      await expect(oracle.connect(stranger).pauseFor(0)).to.be.revertedWithOZAccessControlError(
        await stranger.getAddress(),
        await oracle.PAUSE_ROLE(),
      );
    });

    it("should allow calling from a possessor of PAUSE_ROLE role", async () => {
      await oracle.grantRole(await oracle.PAUSE_ROLE(), account1);

      const tx = await oracle.connect(account1).pauseFor(9999);
      await expect(tx).to.emit(oracle, "Paused").withArgs(9999);
    });
  });

  context("RESUME_ROLE", () => {
    it("should revert without RESUME_ROLE role", async () => {
      await oracle.connect(admin).pauseFor(9999);

      await expect(oracle.connect(stranger).resume()).to.be.revertedWithOZAccessControlError(
        await stranger.getAddress(),
        await oracle.RESUME_ROLE(),
      );
    });

    it("should allow calling from a possessor of RESUME_ROLE role", async () => {
      await oracle.pauseFor(9999, { from: admin });
      await oracle.grantRole(await oracle.RESUME_ROLE(), account1);

      const tx = await oracle.connect(account1).resume();
      await expect(tx).to.emit(oracle, "Resumed").withArgs();
    });
  });

  context("SUBMIT_DATA_ROLE", () => {
    context("_checkMsgSenderIsAllowedToSubmitData", () => {
      it("should revert from not consensus member without SUBMIT_DATA_ROLE role", async () => {
        await expect(
          oracle.connect(stranger).submitReportData(reportFields, oracleVersion),
        ).to.be.revertedWithCustomError(oracle, "SenderNotAllowed");
      });

      it("should allow calling from a possessor of SUBMIT_DATA_ROLE role", async () => {
        await oracle.grantRole(await oracle.SUBMIT_DATA_ROLE(), account1);
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);

        const tx = await oracle.connect(account1).submitReportData(reportFields, oracleVersion);

        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, reportHash);
      });

      it("should allow calling from a member", async () => {
        const tx = await oracle.connect(member2).submitReportData(reportFields, oracleVersion);

        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, reportHash);
      });
    });
  });
});
