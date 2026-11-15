import { expect } from "chai";
import { ContractTransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, WithdrawalsOracle__Harness } from "typechain-types";

import { WITHDRAWALS_ORACLE_CONSENSUS_VERSION } from "lib";

import {
  calcWithdrawalsOracleReportDataHash,
  deployWithdrawalsOracle,
  encodeWithdrawalRequests,
  initWithdrawalsOracle,
  WithdrawalRequest,
  WithdrawalsOracleReportFields,
} from "test/deploy";
import { Snapshot } from "test/suite";

describe("WithdrawalsOracle.sol:accessControl", () => {
  let consensus: HashConsensus__Harness;
  let oracle: WithdrawalsOracle__Harness;
  let admin: HardhatEthersSigner;
  let originalState: string;

  let initTx: ContractTransactionResponse;
  let oracleVersion: bigint;
  let requests: WithdrawalRequest[];
  let reportFields: WithdrawalsOracleReportFields;
  let reportHash: string;

  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let account1: HardhatEthersSigner;

  const deploy = async () => {
    const deployed = await deployWithdrawalsOracle(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;

    initTx = await initWithdrawalsOracle({ admin: admin.address, oracle, consensus, resumeAfterDeploy: true });

    oracleVersion = await oracle.getContractVersion();

    await consensus.addMember(member1, 1);
    await consensus.addMember(member2, 2);
    await consensus.addMember(member3, 2);

    const { refSlot } = await consensus.getCurrentFrame();
    requests = [
      { moduleId: 1, nodeOpId: 0, keyIndex: 0, amount: 0n },
      { moduleId: 1, nodeOpId: 0, keyIndex: 1, amount: 0n },
      { moduleId: 2, nodeOpId: 0, keyIndex: 2, amount: 0n },
    ];

    reportFields = {
      consensusVersion: WITHDRAWALS_ORACLE_CONSENSUS_VERSION,
      refSlot: refSlot,
      requestsCount: requests.length,
      data: encodeWithdrawalRequests(requests),
    };

    reportHash = calcWithdrawalsOracleReportDataHash(reportFields);
    await consensus.connect(member1).submitReport(refSlot, reportHash, WITHDRAWALS_ORACLE_CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, reportHash, WITHDRAWALS_ORACLE_CONSENSUS_VERSION);
  };

  before(async () => {
    [admin, member1, member2, member3, stranger, account1] = await ethers.getSigners();

    await deploy();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("deploying", () => {
    it("deploying withdrawals oracle", async () => {
      expect(oracle).to.be.not.null;
      expect(consensus).to.be.not.null;
      expect(initTx).to.be.not.null;
      expect(oracleVersion).to.be.not.null;
      expect(requests).to.be.not.null;
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
          oracle.initialize(ZeroAddress, await consensus.getAddress(), WITHDRAWALS_ORACLE_CONSENSUS_VERSION, 0),
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
