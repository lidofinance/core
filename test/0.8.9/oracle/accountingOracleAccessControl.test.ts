import { expect } from "chai";
import { ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracleTimeTravellable,
  HashConsensusTimeTravellable,
  MockLidoForAccountingOracle,
} from "typechain-types";

import { calcReportDataHash, ether, getReportDataItems, OracleReport, ReportAsArray, shareRate } from "lib";
import { CONSENSUS_VERSION } from "lib";

import {
  calcExtraDataListHash,
  deployAndConfigureAccountingOracle,
  encodeExtraDataItems,
  EXTRA_DATA_FORMAT_EMPTY,
  EXTRA_DATA_FORMAT_LIST,
  ONE_GWEI,
  packExtraDataList,
} from "./accountingOracleDeploy.test";

describe("AccountingOracle.sol", () => {
  let consensus: HashConsensusTimeTravellable;
  let oracle: AccountingOracleTimeTravellable;
  let mockLido: MockLidoForAccountingOracle;
  let reportItems: ReportAsArray;
  let reportFields: OracleReport;
  let extraDataList: string;

  let admin: HardhatEthersSigner;
  let account1: HardhatEthersSigner;
  let account2: HardhatEthersSigner;
  let member1: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  before(async () => {
    [admin, account1, account2, member1, stranger] = await ethers.getSigners();
    await deploy();
  });

  const deploy = async ({ emptyExtraData = false } = {}) => {
    const deployed = await deployAndConfigureAccountingOracle(admin.address);
    const { refSlot } = await deployed.consensus.getCurrentFrame();

    const extraData = {
      stuckKeys: [
        { moduleId: 1, nodeOpIds: [0], keysCounts: [1] },
        { moduleId: 2, nodeOpIds: [0], keysCounts: [2] },
        { moduleId: 3, nodeOpIds: [2], keysCounts: [3] },
      ],
      exitedKeys: [
        { moduleId: 2, nodeOpIds: [1, 2], keysCounts: [1, 3] },
        { moduleId: 3, nodeOpIds: [1], keysCounts: [2] },
      ],
    };

    const extraDataItems = encodeExtraDataItems(extraData);
    extraDataList = packExtraDataList(extraDataItems);
    const extraDataHash = calcExtraDataListHash(extraDataList);
    reportFields = {
      consensusVersion: BigInt(CONSENSUS_VERSION),
      refSlot: refSlot,
      numValidators: 10,
      clBalanceGwei: 320n * ONE_GWEI,
      stakingModuleIdsWithNewlyExitedValidators: [1],
      numExitedValidatorsByStakingModule: [3],
      withdrawalVaultBalance: ether("1"),
      elRewardsVaultBalance: ether("2"),
      sharesRequestedToBurn: ether("3"),
      withdrawalFinalizationBatches: [1],
      simulatedShareRate: shareRate(1n),
      isBunkerMode: true,
      extraDataFormat: emptyExtraData ? EXTRA_DATA_FORMAT_EMPTY : EXTRA_DATA_FORMAT_LIST,
      extraDataHash: emptyExtraData ? ZeroHash : extraDataHash,
      extraDataItemsCount: emptyExtraData ? 0 : extraDataItems.length,
    };
    reportItems = getReportDataItems(reportFields);
    const reportHash = calcReportDataHash(reportItems);
    await deployed.consensus.connect(admin).addMember(member1, 1);
    await deployed.consensus.connect(member1).submitReport(refSlot, reportHash, CONSENSUS_VERSION);

    oracle = deployed.oracle;
    consensus = deployed.consensus;
    mockLido = deployed.lido;
  };

  context("deploying", () => {
    before(deploy);

    it("deploying accounting oracle", async () => {
      expect(oracle).to.be.not.null;
      expect(consensus).to.be.not.null;
      expect(mockLido).to.be.not.null;
      expect(reportItems).to.be.not.null;
      expect(extraDataList).to.be.not.null;
    });
  });

  context("SUBMIT_DATA_ROLE", () => {
    beforeEach(deploy);

    context("submitReportData", () => {
      it("should revert from not consensus member without SUBMIT_DATA_ROLE role", async () => {
        await expect(
          oracle.connect(stranger).submitReportData(reportFields, CONSENSUS_VERSION),
        ).to.be.revertedWithCustomError(oracle, "SenderNotAllowed");
      });

      it("should allow calling from a possessor of SUBMIT_DATA_ROLE role", async () => {
        const submitDataRole = await oracle.SUBMIT_DATA_ROLE();
        await oracle.grantRole(submitDataRole, account2);
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);

        const tx = await oracle.connect(account2).submitReportData(reportFields, CONSENSUS_VERSION);
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, anyValue);
      });

      it("should allow calling from a member", async () => {
        const tx = await oracle.connect(member1).submitReportData(reportFields, CONSENSUS_VERSION);
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, anyValue);
      });
    });

    context("extraDataItems", () => {
      beforeEach(deploy);

      it("should revert from not consensus member without SUBMIT_DATA_ROLE role ", async () => {
        await expect(oracle.connect(account1).submitReportExtraDataList(extraDataList)).to.be.revertedWithCustomError(
          oracle,
          "SenderNotAllowed",
        );
      });

      it("should allow calling from a possessor of SUBMIT_DATA_ROLE role", async () => {
        const submitDataRole = await oracle.SUBMIT_DATA_ROLE();
        await oracle.grantRole(submitDataRole, account2);
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);

        await oracle.connect(account2).submitReportData(reportFields, CONSENSUS_VERSION);
        const tx = await oracle.connect(account2).submitReportExtraDataList(extraDataList);

        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
      });

      it("should allow calling from a member", async () => {
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);

        await oracle.connect(member1).submitReportData(reportFields, CONSENSUS_VERSION);
        const tx = await oracle.connect(member1).submitReportExtraDataList(extraDataList);

        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
      });
    });

    context("submitReportExtraDataEmpty", () => {
      beforeEach(() => deploy({ emptyExtraData: true }));

      it("should revert from not consensus member without SUBMIT_DATA_ROLE role ", async () => {
        await expect(oracle.connect(account1).submitReportExtraDataEmpty()).to.be.revertedWithCustomError(
          oracle,
          "SenderNotAllowed",
        );
      });

      it("should allow calling from a possessor of SUBMIT_DATA_ROLE role", async () => {
        const submitDataRole = await oracle.SUBMIT_DATA_ROLE();
        await oracle.grantRole(submitDataRole, account2);
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);

        await oracle.connect(account2).submitReportData(reportFields, CONSENSUS_VERSION);
        const tx = await oracle.connect(account2).submitReportExtraDataEmpty();

        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
      });

      it("should allow calling from a member", async () => {
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);

        await oracle.connect(member1).submitReportData(reportFields, CONSENSUS_VERSION);
        const tx = await oracle.connect(member1).submitReportExtraDataEmpty();

        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
      });
    });
  });
});
