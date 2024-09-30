import { expect } from "chai";
import { ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { AccountingOracle__Harness, HashConsensus__Harness, Lido__MockForAccountingOracle } from "typechain-types";

import {
  calcExtraDataListHash,
  calcReportDataHash,
  CONSENSUS_VERSION,
  encodeExtraDataItems,
  ether,
  EXTRA_DATA_FORMAT_EMPTY,
  EXTRA_DATA_FORMAT_LIST,
  getReportDataItems,
  ONE_GWEI,
  OracleReport,
  packExtraDataList,
  ReportAsArray,
  shareRate,
} from "lib";

import { deployAndConfigureAccountingOracle } from "test/deploy";
import { Snapshot } from "test/suite";

describe("AccountingOracle.sol:accessControl", () => {
  let consensus: HashConsensus__Harness;
  let oracle: AccountingOracle__Harness;
  let mockLido: Lido__MockForAccountingOracle;
  let reportItems: ReportAsArray;
  let reportFields: OracleReport;
  let extraDataList: string;

  let admin: HardhatEthersSigner;
  let account: HardhatEthersSigner;
  let member: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalState: string;

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
      consensusVersion: CONSENSUS_VERSION,
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
    await deployed.consensus.connect(admin).addMember(member, 1);
    await deployed.consensus.connect(member).submitReport(refSlot, reportHash, CONSENSUS_VERSION);

    oracle = deployed.oracle;
    consensus = deployed.consensus;
    mockLido = deployed.lido;
  };

  before(async () => {
    [admin, account, member, stranger] = await ethers.getSigners();

    await deploy();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("deploying", () => {
    it("deploying accounting oracle", async () => {
      expect(oracle).to.be.not.null;
      expect(consensus).to.be.not.null;
      expect(mockLido).to.be.not.null;
      expect(reportItems).to.be.not.null;
      expect(extraDataList).to.be.not.null;
    });
  });

  context("SUBMIT_DATA_ROLE", () => {
    context("submitReportData", () => {
      it("reverts when sender is not allowed", async () => {
        await expect(
          oracle.connect(stranger).submitReportData(reportFields, CONSENSUS_VERSION),
        ).to.be.revertedWithCustomError(oracle, "SenderNotAllowed");
      });

      it("should allow calling from a possessor of SUBMIT_DATA_ROLE role", async () => {
        const submitDataRole = await oracle.SUBMIT_DATA_ROLE();
        await oracle.grantRole(submitDataRole, account);
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);

        const tx = await oracle.connect(account).submitReportData(reportFields, CONSENSUS_VERSION);
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, anyValue);
      });

      it("should allow calling from a member", async () => {
        const tx = await oracle.connect(member).submitReportData(reportFields, CONSENSUS_VERSION);
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, anyValue);
      });
    });

    context("extraDataItems", () => {
      it("reverts when sender is not allowed", async () => {
        await expect(oracle.connect(account).submitReportExtraDataList(extraDataList)).to.be.revertedWithCustomError(
          oracle,
          "SenderNotAllowed",
        );
      });

      it("should allow calling from a possessor of SUBMIT_DATA_ROLE role", async () => {
        const submitDataRole = await oracle.SUBMIT_DATA_ROLE();
        await oracle.grantRole(submitDataRole, account);
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);

        await oracle.connect(account).submitReportData(reportFields, CONSENSUS_VERSION);
        const tx = await oracle.connect(account).submitReportExtraDataList(extraDataList);

        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
      });

      it("should allow calling from a member", async () => {
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);

        await oracle.connect(member).submitReportData(reportFields, CONSENSUS_VERSION);
        const tx = await oracle.connect(member).submitReportExtraDataList(extraDataList);

        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
      });
    });

    context("submitReportExtraDataEmpty", () => {
      before(async () => await deploy({ emptyExtraData: true }));

      it("reverts when sender is not allowed", async () => {
        await expect(oracle.connect(account).submitReportExtraDataEmpty()).to.be.revertedWithCustomError(
          oracle,
          "SenderNotAllowed",
        );
      });

      it("should allow calling from a possessor of SUBMIT_DATA_ROLE role", async () => {
        const submitDataRole = await oracle.SUBMIT_DATA_ROLE();
        await oracle.grantRole(submitDataRole, account);
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);

        await oracle.connect(account).submitReportData(reportFields, CONSENSUS_VERSION);
        const tx = await oracle.connect(account).submitReportExtraDataEmpty();

        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
      });

      it("should allow calling from a member", async () => {
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);

        await oracle.connect(member).submitReportData(reportFields, CONSENSUS_VERSION);
        const tx = await oracle.connect(member).submitReportExtraDataEmpty();

        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
      });
    });
  });
});
