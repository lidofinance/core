import { expect } from "chai";
import { BigNumberish, ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracleTimeTravellable,
  HashConsensusTimeTravellable,
  MockStakingRouterForAccountingOracle,
  OracleReportSanityChecker,
} from "typechain-types";

import {
  calcExtraDataListHash,
  calcReportDataHash,
  CONSENSUS_VERSION,
  constructOracleReport,
  encodeExtraDataItem,
  encodeExtraDataItems,
  ether,
  EXTRA_DATA_FORMAT_EMPTY,
  EXTRA_DATA_FORMAT_LIST,
  EXTRA_DATA_TYPE_EXITED_VALIDATORS,
  EXTRA_DATA_TYPE_STUCK_VALIDATORS,
  ExtraData,
  ExtraDataType,
  getReportDataItems,
  numberToHex,
  ONE_GWEI,
  OracleReport,
  OracleReportProps,
  packExtraDataList,
  ReportFieldsWithoutExtraData,
  shareRate,
} from "lib";

import { deployAndConfigureAccountingOracle } from "test/deploy";
import { Snapshot } from "test/suite";

const getDefaultExtraData = (): ExtraDataType => ({
  stuckKeys: [
    { moduleId: 1, nodeOpIds: [0], keysCounts: [1] },
    { moduleId: 2, nodeOpIds: [0], keysCounts: [2] },
    { moduleId: 3, nodeOpIds: [2], keysCounts: [3] },
  ],
  exitedKeys: [
    { moduleId: 2, nodeOpIds: [1, 2], keysCounts: [1, 3] },
    { moduleId: 3, nodeOpIds: [1], keysCounts: [2] },
  ],
});

const getDefaultReportFields = (override = {}) => ({
  consensusVersion: BigInt(CONSENSUS_VERSION),
  refSlot: 0,
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
  extraDataFormat: EXTRA_DATA_FORMAT_LIST,
  extraDataHash: ZeroHash,
  extraDataItemsCount: 0,
  ...override,
});

describe("AccountingOracle.sol:submitReportExtraData", () => {
  let consensus: HashConsensusTimeTravellable;
  let oracle: AccountingOracleTimeTravellable;
  let oracleVersion: bigint;
  let stakingRouter: MockStakingRouterForAccountingOracle;
  let sanityChecker: OracleReportSanityChecker;
  let snapshot: string;

  let admin: HardhatEthersSigner;
  let member1: HardhatEthersSigner;

  before(async () => {
    [admin, member1] = await ethers.getSigners();
    const deployed = await deployAndConfigureAccountingOracle(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;
    stakingRouter = deployed.stakingRouter;
    sanityChecker = deployed.oracleReportSanityChecker;
    oracleVersion = await oracle.getContractVersion();
    await consensus.connect(admin).addMember(member1, 1);
  });

  async function takeSnapshot() {
    snapshot = await Snapshot.take();
  }

  async function rollback() {
    await Snapshot.restore(snapshot);
  }

  type ConstructOracleReportWithDefaultValuesProps = Pick<Partial<OracleReportProps>, "config" | "extraData"> & {
    reportFields?: Partial<Omit<ReportFieldsWithoutExtraData, "refSlot">>;
  };

  async function constructOracleReportWithDefaultValuesForCurrentRefSlot({
    reportFields,
    extraData,
    config,
  }: ConstructOracleReportWithDefaultValuesProps) {
    const { refSlot } = await consensus.getCurrentFrame();

    const reportFieldsValue = getDefaultReportFields({
      ...reportFields,
      refSlot,
    });

    const extraDataValue = extraData || getDefaultExtraData();

    const report = constructOracleReport({
      reportFieldsWithoutExtraData: reportFieldsValue,
      extraData: extraDataValue,
      config,
    });

    return {
      ...report,
      reportInput: {
        reportFieldsValue,
        extraDataValue,
      },
    };
  }

  interface ReportDataArgs {
    extraData?: ExtraData;
    reportFields?: Partial<ReportFieldsWithoutExtraData>;
  }

  async function constructOracleReportWithSingeExtraDataTransactionForCurrentRefSlot({
    extraData,
    reportFields,
  }: ReportDataArgs = {}) {
    const extraDataValue = extraData || getDefaultExtraData();

    const { extraDataChunks, extraDataChunkHashes, extraDataItemsCount, report, reportHash, reportInput } =
      await constructOracleReportWithDefaultValuesForCurrentRefSlot({
        reportFields: reportFields,
        extraData: extraDataValue,
      });

    return {
      extraDataItemsCount,
      extraDataList: extraDataChunks[0],
      extraDataHash: extraDataChunkHashes[0],
      reportFields: report,
      reportHash,
      reportInput,
    };
  }

  async function oracleMemberSubmitReportHash(refSlot: BigNumberish, reportHash: string) {
    return await consensus.connect(member1).submitReport(refSlot, reportHash, CONSENSUS_VERSION);
  }

  async function oracleMemberSubmitReportData(report: OracleReport) {
    return await oracle.connect(member1).submitReportData(report, oracleVersion);
  }

  async function oracleMemberSubmitExtraData(extraDataList: string) {
    return await oracle.connect(member1).submitReportExtraDataList(extraDataList);
  }

  async function oracleMemberSubmitExtraDataEmpty() {
    return await oracle.connect(member1).submitReportExtraDataEmpty();
  }

  async function constructOracleReportForCurrentFrameAndSubmitReportHash({
    extraData,
    reportFields,
    config,
  }: ConstructOracleReportWithDefaultValuesProps) {
    const data = await constructOracleReportWithDefaultValuesForCurrentRefSlot({
      extraData,
      reportFields,
      config,
    });
    await oracleMemberSubmitReportHash(data.report.refSlot, data.reportHash);
    return data;
  }

  async function submitOracleReport({ extraData, reportFields, config }: ConstructOracleReportWithDefaultValuesProps) {
    const data = await constructOracleReportForCurrentFrameAndSubmitReportHash({
      extraData,
      reportFields,
      config,
    });

    await oracleMemberSubmitReportData(data.report);
    return data;
  }

  async function submitReportHash({ extraData, reportFields }: ReportDataArgs = {}) {
    const data = await constructOracleReportWithSingeExtraDataTransactionForCurrentRefSlot({ extraData, reportFields });
    await oracleMemberSubmitReportHash(data.reportFields.refSlot, data.reportHash);
    return data;
  }

  context("deploying", () => {
    before(takeSnapshot);
    after(rollback);

    it("deploying accounting oracle", async () => {
      expect(oracle).to.be.not.null;
      expect(consensus).to.be.not.null;
      expect(oracleVersion).to.be.not.null;
    });
  });

  context("submitReportExtraDataList", () => {
    beforeEach(takeSnapshot);
    afterEach(rollback);

    context("submit third phase transactions successfully", () => {
      it("submit extra data report within single transaction", async () => {
        const { report, extraDataChunks } = await constructOracleReportForCurrentFrameAndSubmitReportHash({});
        expect(extraDataChunks.length).to.be.equal(1);
        await oracleMemberSubmitReportData(report);
        const tx = await oracleMemberSubmitExtraData(extraDataChunks[0]);
        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(report.refSlot, 5, 5);
      });

      it("submit extra data report within two transaction", async () => {
        const defaultExtraData = getDefaultExtraData();

        const { report, extraDataChunks, extraDataChunkHashes } =
          await constructOracleReportForCurrentFrameAndSubmitReportHash({
            config: { maxItemsPerChunk: 3 },
          });

        expect(extraDataChunks.length).to.be.equal(2);
        await oracleMemberSubmitReportData(report);

        const calcSortingKey = (itemType: bigint, moduleId: number, firstNodeOpId: number) =>
          (BigInt(itemType) << 240n) | (BigInt(moduleId) << 64n) | BigInt(firstNodeOpId);

        const stateBeforeProcessingStart = await oracle.getExtraDataProcessingState();
        expect(stateBeforeProcessingStart.itemsCount).to.be.equal(5);
        expect(stateBeforeProcessingStart.itemsProcessed).to.be.equal(0);
        expect(stateBeforeProcessingStart.submitted).to.be.equal(false);
        expect(stateBeforeProcessingStart.lastSortingKey).to.be.equal(0);
        expect(stateBeforeProcessingStart.dataHash).to.be.equal(extraDataChunkHashes[0]);

        const tx1 = await oracleMemberSubmitExtraData(extraDataChunks[0]);
        await expect(tx1).to.emit(oracle, "ExtraDataSubmitted").withArgs(report.refSlot, 3, 5);
        const state1 = await oracle.getExtraDataProcessingState();
        expect(state1.itemsCount).to.be.equal(5);
        expect(state1.itemsProcessed).to.be.equal(3);
        expect(state1.submitted).to.be.equal(false);
        expect(state1.lastSortingKey).to.be.equal(
          calcSortingKey(
            EXTRA_DATA_TYPE_STUCK_VALIDATORS,
            defaultExtraData.stuckKeys[2].moduleId,
            defaultExtraData.stuckKeys[2].nodeOpIds[0],
          ),
        );
        expect(state1.dataHash).to.be.equal(extraDataChunkHashes[1]);

        const tx2 = await oracleMemberSubmitExtraData(extraDataChunks[1]);
        await expect(tx2).to.emit(oracle, "ExtraDataSubmitted").withArgs(report.refSlot, 5, 5);
        const state2 = await oracle.getExtraDataProcessingState();
        expect(state2.itemsCount).to.be.equal(5);
        expect(state2.itemsProcessed).to.be.equal(5);
        expect(state2.submitted).to.be.equal(true);
        expect(state2.lastSortingKey).to.be.equal(
          calcSortingKey(
            EXTRA_DATA_TYPE_EXITED_VALIDATORS,
            defaultExtraData.exitedKeys[1].moduleId,
            defaultExtraData.exitedKeys[1].nodeOpIds[0],
          ),
        );
        expect(state2.dataHash).to.be.equal(extraDataChunkHashes[1]);
      });

      it("submit extra data with multiple items per module splitted on many transactions", async () => {
        const validExtraDataForLargeReport = {
          stuckKeys: [
            { moduleId: 1, nodeOpIds: [0, 1, 2], keysCounts: [1, 2, 3] },
            { moduleId: 1, nodeOpIds: [3, 4, 5], keysCounts: [4, 5, 6] },
            { moduleId: 2, nodeOpIds: [0], keysCounts: [1] },
          ],
          exitedKeys: [
            { moduleId: 1, nodeOpIds: [0, 1, 2, 3], keysCounts: [1, 2, 3, 4] },
            { moduleId: 1, nodeOpIds: [4, 5], keysCounts: [4, 5] },
            { moduleId: 2, nodeOpIds: [0], keysCounts: [1] },
          ],
        };

        // Submit report with extra data splitted on many transactions
        // It does not matter on how many transactions we will split extra data
        for (let i = 1; i <= 6; i++) {
          await consensus.advanceTimeToNextFrameStart();

          const { extraDataChunks } = await submitOracleReport({
            extraData: validExtraDataForLargeReport,
            config: { maxItemsPerChunk: i },
          });

          for (let j = 0; j < extraDataChunks.length; j++) {
            await oracleMemberSubmitExtraData(extraDataChunks[j]);
          }
        }
      });
    });

    context("enforces the deadline", () => {
      it("reverts with ProcessingDeadlineMissed if deadline missed for the single transaction of extra data report", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { report, extraDataChunks } = await constructOracleReportForCurrentFrameAndSubmitReportHash({});
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await oracleMemberSubmitReportData(report);
        await consensus.advanceTimeToNextFrameStart();
        await expect(oracle.connect(member1).submitReportExtraDataList(extraDataChunks[0]))
          .to.be.revertedWithCustomError(oracle, "ProcessingDeadlineMissed")
          .withArgs(deadline);
      });

      it("reverts with ProcessingDeadlineMissed if deadline missed for the first transaction of extra data report", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { report, extraDataChunks } = await constructOracleReportForCurrentFrameAndSubmitReportHash({
          config: { maxItemsPerChunk: 3 },
        });
        expect(extraDataChunks.length).to.be.equal(2);
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await oracleMemberSubmitReportData(report);
        await consensus.advanceTimeToNextFrameStart();
        await expect(oracle.connect(member1).submitReportExtraDataList(extraDataChunks[0]))
          .to.be.revertedWithCustomError(oracle, "ProcessingDeadlineMissed")
          .withArgs(deadline);
      });

      it("reverts with ProcessingDeadlineMissed if deadline missed for the second transaction of extra data report", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { report, extraDataChunks } = await constructOracleReportForCurrentFrameAndSubmitReportHash({
          config: { maxItemsPerChunk: 3 },
        });
        expect(extraDataChunks.length).to.be.equal(2);
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await oracleMemberSubmitReportData(report);
        await oracleMemberSubmitExtraData(extraDataChunks[0]);
        await consensus.advanceTimeToNextFrameStart();
        await expect(oracleMemberSubmitExtraData(extraDataChunks[1]))
          .to.be.revertedWithCustomError(oracle, "ProcessingDeadlineMissed")
          .withArgs(deadline);
      });

      it("pass successfully if time is equals exactly to deadline value", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { report, extraDataChunks } = await constructOracleReportForCurrentFrameAndSubmitReportHash({});
        expect(extraDataChunks.length).to.be.equal(1);
        await oracleMemberSubmitReportData(report);
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);
        const tx = await oracleMemberSubmitExtraData(extraDataChunks[0]);
        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(report.refSlot, anyValue, anyValue);
      });

      it("pass successfully if the last transaction time is equals exactly to deadline value", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { report, extraDataChunks } = await constructOracleReportForCurrentFrameAndSubmitReportHash({
          config: { maxItemsPerChunk: 3 },
        });
        expect(extraDataChunks.length).to.be.equal(2);
        await oracleMemberSubmitReportData(report);
        await oracleMemberSubmitExtraData(extraDataChunks[0]);
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);
        const tx = await oracleMemberSubmitExtraData(extraDataChunks[1]);
        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(report.refSlot, anyValue, anyValue);
      });
    });

    context("checks ref slot", () => {
      it("reverts with CannotSubmitExtraDataBeforeMainData in attempt of try to pass extra data ahead of submitReportData", async () => {
        const { report, reportHash, extraDataChunks } = await constructOracleReportWithDefaultValuesForCurrentRefSlot(
          {},
        );
        await consensus.connect(member1).submitReport(report.refSlot, reportHash, CONSENSUS_VERSION);
        // No submitReportData here — trying to send extra data ahead of it
        await expect(
          oracle.connect(member1).submitReportExtraDataList(extraDataChunks[0]),
        ).to.be.revertedWithCustomError(oracle, "CannotSubmitExtraDataBeforeMainData");
      });

      it("pass successfully ", async () => {
        const { report, reportHash, extraDataChunks } = await constructOracleReportWithDefaultValuesForCurrentRefSlot(
          {},
        );

        await consensus.connect(member1).submitReport(report.refSlot, reportHash, CONSENSUS_VERSION);
        // Now submitReportData on it's place
        await oracle.connect(member1).submitReportData(report, oracleVersion);
        const tx = await oracle.connect(member1).submitReportExtraDataList(extraDataChunks[0]);
        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(report.refSlot, anyValue, anyValue);
      });
    });

    context("checks extra data hash", () => {
      it("reverts with UnexpectedDataHash if hash did not match", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { reportFields, extraDataHash } = await submitReportHash();
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        const incorrectExtraData = getDefaultExtraData();
        ++incorrectExtraData.stuckKeys[0].nodeOpIds[0];
        const incorrectExtraDataItems = encodeExtraDataItems(incorrectExtraData);
        const incorrectExtraDataList = packExtraDataList(incorrectExtraDataItems);
        const incorrectExtraDataHash = calcExtraDataListHash(incorrectExtraDataList);
        await expect(oracle.connect(member1).submitReportExtraDataList(incorrectExtraDataList))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataHash")
          .withArgs(extraDataHash, incorrectExtraDataHash);
      });

      it("reverts with UnexpectedDataHash if second transaction hash did not match", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { report, extraDataChunks, extraDataChunkHashes } =
          await constructOracleReportForCurrentFrameAndSubmitReportHash({
            config: { maxItemsPerChunk: 3 },
          });
        expect(extraDataChunks.length).to.be.equal(2);
        await oracleMemberSubmitReportData(report);
        const tx1 = await oracleMemberSubmitExtraData(extraDataChunks[0]);
        await expect(tx1).to.emit(oracle, "ExtraDataSubmitted").withArgs(report.refSlot, anyValue, anyValue);

        const incorrectExtraData = getDefaultExtraData();
        ++incorrectExtraData.exitedKeys[0].nodeOpIds[0];

        const { extraDataChunks: incorrectExtraDataChunks, extraDataChunkHashes: incorrectExtraDataChunkHashes } =
          await constructOracleReportWithDefaultValuesForCurrentRefSlot({
            extraData: incorrectExtraData,
            config: { maxItemsPerChunk: 3 },
          });

        expect(extraDataChunkHashes[0]).to.be.not.equal(incorrectExtraDataChunkHashes[0]);
        expect(extraDataChunkHashes[1]).to.be.not.equal(incorrectExtraDataChunkHashes[1]);

        await expect(oracleMemberSubmitExtraData(incorrectExtraDataChunks[1]))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataHash")
          .withArgs(extraDataChunkHashes[1], incorrectExtraDataChunkHashes[1]);
      });

      it("reverts with UnexpectedDataHash if second transaction send before the first one", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { report, extraDataChunks, extraDataChunkHashes } =
          await constructOracleReportForCurrentFrameAndSubmitReportHash({
            config: { maxItemsPerChunk: 3 },
          });
        expect(extraDataChunks.length).to.be.equal(2);
        await oracleMemberSubmitReportData(report);
        await expect(oracleMemberSubmitExtraData(extraDataChunks[1]))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataHash")
          .withArgs(extraDataChunkHashes[0], extraDataChunkHashes[1]);

        const tx1 = await oracleMemberSubmitExtraData(extraDataChunks[0]);
        await expect(tx1).to.emit(oracle, "ExtraDataSubmitted").withArgs(report.refSlot, anyValue, anyValue);

        const tx2 = await oracleMemberSubmitExtraData(extraDataChunks[1]);
        await expect(tx2).to.emit(oracle, "ExtraDataSubmitted").withArgs(report.refSlot, anyValue, anyValue);
      });

      it("reverts with UnexpectedDataHash if the first transaction sended twice", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { report, extraDataChunks, extraDataChunkHashes } =
          await constructOracleReportForCurrentFrameAndSubmitReportHash({
            config: { maxItemsPerChunk: 3 },
          });
        expect(extraDataChunks.length).to.be.equal(2);
        await oracleMemberSubmitReportData(report);
        await expect(oracleMemberSubmitExtraData(extraDataChunks[1]))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataHash")
          .withArgs(extraDataChunkHashes[0], extraDataChunkHashes[1]);

        const tx1 = await oracleMemberSubmitExtraData(extraDataChunks[0]);
        await expect(tx1).to.emit(oracle, "ExtraDataSubmitted").withArgs(report.refSlot, anyValue, anyValue);

        await expect(oracleMemberSubmitExtraData(extraDataChunks[0]))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataHash")
          .withArgs(extraDataChunkHashes[1], extraDataChunkHashes[0]);

        const tx2 = await oracleMemberSubmitExtraData(extraDataChunks[1]);
        await expect(tx2).to.emit(oracle, "ExtraDataSubmitted").withArgs(report.refSlot, anyValue, anyValue);
      });

      it("pass successfully if data hash matches", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { extraDataList, reportFields, extraDataItemsCount } = await submitReportHash();
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        const tx = await oracle.connect(member1).submitReportExtraDataList(extraDataList);
        await expect(tx)
          .to.emit(oracle, "ExtraDataSubmitted")
          .withArgs(reportFields.refSlot, extraDataItemsCount, extraDataItemsCount);
      });
    });

    context("checks items count", () => {
      it("reverts with UnexpectedExtraDataItemsCount if there was wrong amount of items", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { extraDataList, extraDataItemsCount, reportFields } =
          await constructOracleReportWithSingeExtraDataTransactionForCurrentRefSlot();

        const wrongItemsCount = 1;
        const reportWithWrongItemsCount = { ...reportFields, extraDataItemsCount: wrongItemsCount };
        const hashOfReportWithWrongItemsCount = calcReportDataHash(getReportDataItems(reportWithWrongItemsCount));

        await oracleMemberSubmitReportHash(reportWithWrongItemsCount.refSlot, hashOfReportWithWrongItemsCount);
        await oracleMemberSubmitReportData(reportWithWrongItemsCount);
        await expect(oracleMemberSubmitExtraData(extraDataList))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataItemsCount")
          .withArgs(reportWithWrongItemsCount.extraDataItemsCount, extraDataItemsCount);
      });

      it("reverts with UnexpectedExtraDataItemsCount if there was wrong amount of items in the first transaction", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { report, extraDataChunks } = await constructOracleReportWithDefaultValuesForCurrentRefSlot({
          config: { maxItemsPerChunk: 3 },
        });
        expect(extraDataChunks.length).to.be.equal(2);

        const wrongItemsCount = 1;
        const reportWithWrongItemsCount = { ...report, extraDataItemsCount: wrongItemsCount };
        const hashOfReportWithWrongItemsCount = calcReportDataHash(getReportDataItems(reportWithWrongItemsCount));

        await oracleMemberSubmitReportHash(reportWithWrongItemsCount.refSlot, hashOfReportWithWrongItemsCount);
        await oracleMemberSubmitReportData(reportWithWrongItemsCount);
        await expect(oracleMemberSubmitExtraData(extraDataChunks[0]))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataItemsCount")
          .withArgs(reportWithWrongItemsCount.extraDataItemsCount, 3);
      });

      it("reverts with UnexpectedExtraDataItemsCount if there was wrong amount of items in the second transaction", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { report, extraDataChunks } = await constructOracleReportWithDefaultValuesForCurrentRefSlot({
          config: { maxItemsPerChunk: 3 },
        });
        expect(extraDataChunks.length).to.be.equal(2);

        const wrongItemsCount = 4;
        const reportWithWrongItemsCount = { ...report, extraDataItemsCount: wrongItemsCount };
        const hashOfReportWithWrongItemsCount = calcReportDataHash(getReportDataItems(reportWithWrongItemsCount));

        await oracleMemberSubmitReportHash(reportWithWrongItemsCount.refSlot, hashOfReportWithWrongItemsCount);
        await oracleMemberSubmitReportData(reportWithWrongItemsCount);
        await oracleMemberSubmitExtraData(extraDataChunks[0]);
        await expect(oracleMemberSubmitExtraData(extraDataChunks[1]))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataItemsCount")
          .withArgs(reportWithWrongItemsCount.extraDataItemsCount, 5);
      });
    });

    context("enforces data format", () => {
      it("reverts with UnexpectedExtraDataFormat if there was empty format submitted on first phase", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { reportFields: emptyReport, reportHash: emptyReportHash } =
          await constructOracleReportWithSingeExtraDataTransactionForCurrentRefSlot({
            extraData: { stuckKeys: [], exitedKeys: [] },
          });
        const { extraDataList } = await constructOracleReportWithSingeExtraDataTransactionForCurrentRefSlot();

        await oracleMemberSubmitReportHash(emptyReport.refSlot, emptyReportHash);
        await oracleMemberSubmitReportData(emptyReport);
        await expect(oracleMemberSubmitExtraData(extraDataList))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataFormat")
          .withArgs(EXTRA_DATA_FORMAT_EMPTY, EXTRA_DATA_FORMAT_LIST);
      });

      it("reverts with UnexpectedExtraDataFormat if there was list format submitted on first phase", async () => {
        const { report, extraDataChunks, extraDataItemsCount } =
          await constructOracleReportForCurrentFrameAndSubmitReportHash({
            config: { maxItemsPerChunk: 3 },
          });

        await oracleMemberSubmitReportData(report);

        await expect(oracleMemberSubmitExtraDataEmpty())
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataFormat")
          .withArgs(EXTRA_DATA_FORMAT_LIST, EXTRA_DATA_FORMAT_EMPTY);

        const tx1 = await oracleMemberSubmitExtraData(extraDataChunks[0]);
        await expect(tx1).to.emit(oracle, "ExtraDataSubmitted").withArgs(report.refSlot, anyValue, anyValue);

        await expect(oracleMemberSubmitExtraDataEmpty())
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataFormat")
          .withArgs(EXTRA_DATA_FORMAT_LIST, EXTRA_DATA_FORMAT_EMPTY);

        const tx2 = await oracleMemberSubmitExtraData(extraDataChunks[1]);
        await expect(tx2)
          .to.emit(oracle, "ExtraDataSubmitted")
          .withArgs(report.refSlot, extraDataItemsCount, extraDataItemsCount);
      });
    });

    context("enforces protection from double extra data submit", () => {
      it("reverts with ExtraDataAlreadyProcessed if extraData has already been processed", async () => {
        const { report, extraDataChunks, extraDataItemsCount } =
          await constructOracleReportForCurrentFrameAndSubmitReportHash({});
        await oracleMemberSubmitReportData(report);
        await oracleMemberSubmitExtraData(extraDataChunks[0]);
        const state = await oracle.getExtraDataProcessingState();
        expect(state.itemsCount).to.be.equal(extraDataItemsCount);
        expect(state.itemsCount).to.be.equal(state.itemsProcessed);
        await expect(oracleMemberSubmitExtraData(extraDataChunks[0])).to.be.revertedWithCustomError(
          oracle,
          "ExtraDataAlreadyProcessed",
        );
      });

      it("reverts with ExtraDataAlreadyProcessed if empty extraData has already been processed", async () => {
        const { report: emptyReport } = await constructOracleReportForCurrentFrameAndSubmitReportHash({
          extraData: { stuckKeys: [], exitedKeys: [] },
        });

        await oracleMemberSubmitReportData(emptyReport);
        await oracleMemberSubmitExtraDataEmpty();
        const state = await oracle.getExtraDataProcessingState();
        expect(state.itemsCount).to.be.equal(0);
        expect(state.itemsProcessed).to.be.equal(0);
        await expect(oracleMemberSubmitExtraDataEmpty()).to.be.revertedWithCustomError(
          oracle,
          "ExtraDataAlreadyProcessed",
        );
      });
    });

    context("enforces extra data sorting order", () => {
      /*
        Extra data report sorted by composite key which is calculated as:
          - item type (stuck = 1 or exited = 2 validators)
          - module id
          - node operator id
      */
      async function extraDataSubmitShouldRevertWithSortOrderError(
        incorrectlySortedExtraData: ExtraData,
        invalidItemIndex: number,
      ) {
        await consensus.advanceTimeToNextFrameStart();

        const { extraDataChunks } = await submitOracleReport({ extraData: incorrectlySortedExtraData });

        await expect(oracleMemberSubmitExtraData(extraDataChunks[0]))
          .to.be.revertedWithCustomError(oracle, "InvalidExtraDataSortOrder")
          .withArgs(invalidItemIndex);
      }

      it("should revert if stuckKeys processed after exitedKeys", async () => {
        const invalidExtraDataItemsArray = [
          { type: EXTRA_DATA_TYPE_EXITED_VALIDATORS, moduleId: 1, nodeOpIds: [0], keysCounts: [1] },
          { type: EXTRA_DATA_TYPE_EXITED_VALIDATORS, moduleId: 2, nodeOpIds: [0], keysCounts: [1] },
          { type: EXTRA_DATA_TYPE_STUCK_VALIDATORS, moduleId: 1, nodeOpIds: [0], keysCounts: [1] },
        ];

        await extraDataSubmitShouldRevertWithSortOrderError(invalidExtraDataItemsArray, 2);
      });

      it("should revert if modules items not sorted by module id", async () => {
        const invalidStuckKeysItemsOrder = [
          { type: EXTRA_DATA_TYPE_STUCK_VALIDATORS, moduleId: 2, nodeOpIds: [0], keysCounts: [1] },
          { type: EXTRA_DATA_TYPE_STUCK_VALIDATORS, moduleId: 1, nodeOpIds: [0], keysCounts: [1] },
        ];

        await extraDataSubmitShouldRevertWithSortOrderError(invalidStuckKeysItemsOrder, 1);

        const invalidExitedKeysItemsOrder = [
          { type: EXTRA_DATA_TYPE_EXITED_VALIDATORS, moduleId: 2, nodeOpIds: [0], keysCounts: [1] },
          { type: EXTRA_DATA_TYPE_EXITED_VALIDATORS, moduleId: 1, nodeOpIds: [0], keysCounts: [1] },
        ];

        await extraDataSubmitShouldRevertWithSortOrderError(invalidExitedKeysItemsOrder, 1);
      });

      it("should revert if node operators not sorted", async () => {
        async function check(nodeOpIds: number[]) {
          function data(type: bigint) {
            return [{ type, moduleId: 1, nodeOpIds, keysCounts: Array(nodeOpIds.length).fill(1) }];
          }

          await extraDataSubmitShouldRevertWithSortOrderError(data(EXTRA_DATA_TYPE_STUCK_VALIDATORS), 0);
          await extraDataSubmitShouldRevertWithSortOrderError(data(EXTRA_DATA_TYPE_EXITED_VALIDATORS), 0);
        }

        // operator id duplicated in item
        await check([1, 2, 2, 3]);

        // operator id not sorted
        await check([1, 3, 2]);
      });

      it("should revert if module node operators not sorted within multiple items", async () => {
        const invalidStuckKeysItemsOrder = [
          { type: EXTRA_DATA_TYPE_STUCK_VALIDATORS, moduleId: 1, nodeOpIds: [1, 2, 3], keysCounts: [1, 2, 3] },
          { type: EXTRA_DATA_TYPE_STUCK_VALIDATORS, moduleId: 1, nodeOpIds: [3, 4, 5], keysCounts: [1, 2, 3] },
        ];

        await extraDataSubmitShouldRevertWithSortOrderError(invalidStuckKeysItemsOrder, 1);

        const invalidExitedKeysItemsOrder = [
          { type: EXTRA_DATA_TYPE_EXITED_VALIDATORS, moduleId: 1, nodeOpIds: [1, 2, 3], keysCounts: [1, 2, 3] },
          { type: EXTRA_DATA_TYPE_EXITED_VALIDATORS, moduleId: 1, nodeOpIds: [3, 4, 5], keysCounts: [1, 2, 3] },
        ];

        await extraDataSubmitShouldRevertWithSortOrderError(invalidExitedKeysItemsOrder, 1);
      });

      it("should revert if second transaction extra data not sorted", async () => {
        const invalidExtraData = {
          stuckKeys: [
            { moduleId: 1, nodeOpIds: [0], keysCounts: [1] },
            { moduleId: 2, nodeOpIds: [3], keysCounts: [2] },
            // Items for second transaction.
            // Break report data sorting order, nodeOpId 3 already processed.
            { moduleId: 2, nodeOpIds: [3], keysCounts: [4] },
          ],
          exitedKeys: [{ moduleId: 2, nodeOpIds: [1, 2], keysCounts: [1, 3] }],
        };

        const { extraDataChunks } = await submitOracleReport({
          extraData: invalidExtraData,
          config: { maxItemsPerChunk: 2 },
        });
        await oracleMemberSubmitExtraData(extraDataChunks[0]);

        await expect(oracleMemberSubmitExtraData(extraDataChunks[1]))
          .to.be.revertedWithCustomError(oracle, "InvalidExtraDataSortOrder")
          .withArgs(2);
      });
    });

    context("enforces data safety boundaries", () => {
      context("checks encoded data indexes for UnexpectedExtraDataIndex reverts", () => {
        // contextual helper to prepeare wrong indexed data
        const getExtraWithCustomLastIndex = (itemsCount: number, lastIndexCustom: number) => {
          const dummyArr = Array.from(Array(itemsCount));
          const stuckKeys = dummyArr.map((_, i) => ({ moduleId: i + 1, nodeOpIds: [0], keysCounts: [i + 1] }));
          const extraData = { stuckKeys, exitedKeys: [] };
          const extraDataItems: string[] = [];
          const type = EXTRA_DATA_TYPE_STUCK_VALIDATORS;
          dummyArr.forEach((_, i) => {
            const item = extraData.stuckKeys[i];
            const index = i < itemsCount - 1 ? i : lastIndexCustom;
            extraDataItems.push(encodeExtraDataItem(index, type, item.moduleId, item.nodeOpIds, item.keysCounts));
          });
          return {
            extraData,
            extraDataItems,
            lastIndexDefault: itemsCount - 1,
            lastIndexCustom,
          };
        };

        it("if first item index is not zero", async () => {
          const { extraDataItems, lastIndexDefault, lastIndexCustom } = getExtraWithCustomLastIndex(1, 1);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData: extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataIndex")
            .withArgs(lastIndexDefault, lastIndexCustom);
        });

        it("if next index is greater than previous for more than +1", async () => {
          const { extraDataItems, lastIndexDefault, lastIndexCustom } = getExtraWithCustomLastIndex(2, 2);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData: extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataIndex")
            .withArgs(lastIndexDefault, lastIndexCustom);
        });

        it("if next index equals to previous", async () => {
          const { extraDataItems, lastIndexDefault, lastIndexCustom } = getExtraWithCustomLastIndex(3, 1);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData: extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataIndex")
            .withArgs(lastIndexDefault, lastIndexCustom);
        });

        it("if next index less than previous", async () => {
          const { extraDataItems, lastIndexDefault, lastIndexCustom } = getExtraWithCustomLastIndex(3, 0);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData: extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataIndex")
            .withArgs(lastIndexDefault, lastIndexCustom);
        });

        it("succeeds if indexes were passed sequentially", async () => {
          const { extraDataItems } = getExtraWithCustomLastIndex(3, 2);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData: extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          const tx = await oracle.connect(member1).submitReportExtraDataList(extraDataList);
          await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
        });
      });

      context("checks data type for UnsupportedExtraDataType reverts (only supported types are `1` and `2`)", () => {
        // contextual helper to prepeare wrong typed data
        const getExtraWithCustomType = (typeCustom: bigint) => {
          const extraData = {
            stuckKeys: [{ moduleId: 1, nodeOpIds: [1], keysCounts: [2] }],
            exitedKeys: [],
          };
          const item = extraData.stuckKeys[0];
          const extraDataItems = [];
          extraDataItems.push(encodeExtraDataItem(0, typeCustom, item.moduleId, item.nodeOpIds, item.keysCounts));
          return {
            extraData,
            extraDataItems,
            wrongTypedIndex: 0,
            typeCustom,
          };
        };

        it("if type `0` was passed", async () => {
          const { extraDataItems, wrongTypedIndex, typeCustom } = getExtraWithCustomType(0n);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData: extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "UnsupportedExtraDataType")
            .withArgs(wrongTypedIndex, typeCustom);
        });

        it("if type `3` was passed", async () => {
          const { extraDataItems, wrongTypedIndex, typeCustom } = getExtraWithCustomType(3n);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData: extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "UnsupportedExtraDataType")
            .withArgs(wrongTypedIndex, typeCustom);
        });

        it("succeeds if `1` was passed", async () => {
          const { extraDataItems } = getExtraWithCustomType(1n);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData: extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          const tx = await oracle.connect(member1).submitReportExtraDataList(extraDataList);
          await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
        });

        it("succeeds if `2` was passed", async () => {
          const { extraDataItems } = getExtraWithCustomType(2n);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData: extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          const tx = await oracle.connect(member1).submitReportExtraDataList(extraDataList);
          await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
        });
      });

      context("should check node operators processing limits with OracleReportSanityChecker", () => {
        it("by reverting TooManyNodeOpsPerExtraDataItem if there was too much node operators", async () => {
          const problematicItemIdx = 0;
          const extraData = {
            stuckKeys: [{ moduleId: 1, nodeOpIds: [1, 2], keysCounts: [2, 3] }],
            exitedKeys: [],
          };
          const problematicItemsCount = extraData.stuckKeys[problematicItemIdx].nodeOpIds.length;
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await sanityChecker.grantRole(
            await sanityChecker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE(),
            admin.address,
          );
          await sanityChecker.setMaxNodeOperatorsPerExtraDataItem(problematicItemsCount - 1);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(sanityChecker, "TooManyNodeOpsPerExtraDataItem")
            .withArgs(problematicItemIdx, problematicItemsCount);
        });

        it("should not revert in case when items count exactly equals limit", async () => {
          const problematicItemIdx = 0;
          const extraData = {
            stuckKeys: [{ moduleId: 1, nodeOpIds: [1, 2], keysCounts: [2, 3] }],
            exitedKeys: [],
          };
          const problematicItemsCount = extraData.stuckKeys[problematicItemIdx].nodeOpIds.length;
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await sanityChecker.grantRole(await sanityChecker.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE(), admin.address);
          await sanityChecker.setMaxItemsPerExtraDataTransaction(problematicItemsCount);
          const tx = await oracle.connect(member1).submitReportExtraDataList(extraDataList);
          await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
        });

        it("should revert in case when items count exceed limit", async () => {
          const maxItemsPerChunk = 3;
          const extraData = getDefaultExtraData();
          const itemsCount = extraData.exitedKeys.length + extraData.stuckKeys.length;
          const { report, extraDataChunks } = await constructOracleReportForCurrentFrameAndSubmitReportHash({
            extraData,
            config: { maxItemsPerChunk },
          });

          expect(itemsCount).to.be.equal(5);
          expect(extraDataChunks.length).to.be.equal(2);

          await oracleMemberSubmitReportData(report);

          await sanityChecker.grantRole(await sanityChecker.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE(), admin);
          await sanityChecker.setMaxItemsPerExtraDataTransaction(maxItemsPerChunk - 1);
          await expect(oracleMemberSubmitExtraData(extraDataChunks[0]))
            .to.be.revertedWithCustomError(sanityChecker, "TooManyItemsPerExtraDataTransaction")
            .withArgs(maxItemsPerChunk - 1, maxItemsPerChunk);

          await sanityChecker.setMaxItemsPerExtraDataTransaction(maxItemsPerChunk);

          const tx0 = await oracleMemberSubmitExtraData(extraDataChunks[0]);
          await expect(tx0)
            .to.emit(oracle, "ExtraDataSubmitted")
            .withArgs(report.refSlot, maxItemsPerChunk, itemsCount);

          const tx1 = await oracleMemberSubmitExtraData(extraDataChunks[1]);
          await expect(tx1).to.emit(oracle, "ExtraDataSubmitted").withArgs(report.refSlot, itemsCount, itemsCount);
        });
      });

      context("checks for InvalidExtraDataItem reverts", () => {
        it("reverts if some item not long enough to contain all necessary data — early cut", async () => {
          const invalidItemIndex = 1;
          const extraData = {
            stuckKeys: [
              { moduleId: 1, nodeOpIds: [1], keysCounts: [2] },
              { moduleId: 2, nodeOpIds: [1], keysCounts: [2] },
            ],
            exitedKeys: [],
          };
          const extraDataItems = encodeExtraDataItems(extraData);
          // Cutting item to provoke error on early stage
          // of `_processExtraDataItem` function, check on 776 line in AccountingOracle
          const cutStop = 36;
          extraDataItems[invalidItemIndex] = extraDataItems[invalidItemIndex].slice(0, cutStop);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData: extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "InvalidExtraDataItem")
            .withArgs(invalidItemIndex);
        });

        it("reverts if some item not long enough to contain all necessary data — late cut", async () => {
          const invalidItemIndex = 1;
          const extraData = {
            stuckKeys: [
              { moduleId: 1, nodeOpIds: [1], keysCounts: [2] },
              { moduleId: 2, nodeOpIds: [1, 2, 3, 4], keysCounts: [2] },
            ],
            exitedKeys: [],
          };
          const extraDataItems = encodeExtraDataItems(extraData);
          // Providing long items and cutting them from end to provoke error on late stage
          // of `_processExtraDataItem` function, check on 812 line in AccountingOracle, first condition
          const cutStop = extraDataItems[invalidItemIndex].length - 2;
          extraDataItems[invalidItemIndex] = extraDataItems[invalidItemIndex].slice(0, cutStop);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData: extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "InvalidExtraDataItem")
            .withArgs(invalidItemIndex);
        });

        it("moduleId cannot be zero", async () => {
          const invalidItemIndex = 1;
          const extraData = {
            stuckKeys: [
              { moduleId: 1, nodeOpIds: [1], keysCounts: [2] },
              { moduleId: 0, nodeOpIds: [1], keysCounts: [2] },
            ],
            exitedKeys: [],
          };
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "InvalidExtraDataItem")
            .withArgs(invalidItemIndex);
        });

        it("checks node ops count to be non-zero", async () => {
          const invalidItemIndex = 0;
          // Empty nodeOpIds list should provoke check fail
          //  in `_processExtraDataItem` function, 812 line in AccountingOracle, second condition
          const extraData = {
            stuckKeys: [
              { moduleId: 1, nodeOpIds: [], keysCounts: [2] },
              { moduleId: 2, nodeOpIds: [1], keysCounts: [2] },
            ],
            exitedKeys: [],
          };
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "InvalidExtraDataItem")
            .withArgs(invalidItemIndex);
        });
      });

      it("reverts on extra bytes in data", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { refSlot } = await consensus.getCurrentFrame();

        const extraDataItems = encodeExtraDataItems(getDefaultExtraData());
        const extraDataList = packExtraDataList(extraDataItems) + "ffff";
        const extraDataHash = calcExtraDataListHash(extraDataList);

        const reportFields = getDefaultReportFields({
          extraDataHash,
          extraDataItemsCount: extraDataItems.length,
          refSlot,
        });

        const reportItems = getReportDataItems(reportFields);
        const reportHash = calcReportDataHash(reportItems);

        await consensus.connect(member1).submitReport(reportFields.refSlot, reportHash, CONSENSUS_VERSION);
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);

        await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataIndex")
          .withArgs(extraDataItems.length, 16776960);
      });
    });

    context("delivers the data to staking router", () => {
      it("calls reportStakingModuleStuckValidatorsCountByNodeOperator on StakingRouter", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { reportFields, reportInput, extraDataList } = await submitReportHash();
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);

        await oracle.connect(member1).submitReportExtraDataList(extraDataList);

        const callsCount = await stakingRouter.totalCalls_reportStuckKeysByNodeOperator();

        const extraDataValue = reportInput.extraDataValue as ExtraDataType;
        expect(callsCount).to.be.equal(extraDataValue.stuckKeys.length);

        for (let i = 0; i < callsCount; i++) {
          const call = await stakingRouter.calls_reportStuckKeysByNodeOperator(i);
          const item = extraDataValue.stuckKeys[i];
          expect(call.stakingModuleId).to.be.equal(item.moduleId);
          expect(call.nodeOperatorIds).to.be.equal("0x" + item.nodeOpIds.map((id) => numberToHex(id, 8)).join(""));
          expect(call.keysCounts).to.be.equal("0x" + item.keysCounts.map((count) => numberToHex(count, 16)).join(""));
        }
      });

      it("calls reportStakingModuleExitedValidatorsCountByNodeOperator on StakingRouter", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { reportFields, reportInput, extraDataList } = await submitReportHash();
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);

        await oracle.connect(member1).submitReportExtraDataList(extraDataList);

        const callsCount = await stakingRouter.totalCalls_reportExitedKeysByNodeOperator();

        const extraDataValue = reportInput.extraDataValue as ExtraDataType;
        expect(callsCount).to.be.equal(extraDataValue.exitedKeys.length);

        for (let i = 0; i < callsCount; i++) {
          const call = await stakingRouter.calls_reportExitedKeysByNodeOperator(i);
          const item = extraDataValue.exitedKeys[i];
          expect(call.stakingModuleId).to.be.equal(item.moduleId);
          expect(call.nodeOperatorIds).to.be.equal("0x" + item.nodeOpIds.map((id) => numberToHex(id, 8)).join(""));
          expect(call.keysCounts).to.be.equal("0x" + item.keysCounts.map((count) => numberToHex(count, 16)).join(""));
        }
      });

      it("calls onValidatorsCountsByNodeOperatorReportingFinished on StakingRouter", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { report, extraDataChunks } = await constructOracleReportForCurrentFrameAndSubmitReportHash({
          config: { maxItemsPerChunk: 3 },
        });
        expect(extraDataChunks.length).to.be.equal(2);

        await oracleMemberSubmitReportData(report);
        await oracleMemberSubmitExtraData(extraDataChunks[0]);
        const callsCountAfterFirstChunk =
          await stakingRouter.totalCalls_onValidatorsCountsByNodeOperatorReportingFinished();
        expect(callsCountAfterFirstChunk).to.be.equal(0);

        await oracleMemberSubmitExtraData(extraDataChunks[1]);
        const callsCount = await stakingRouter.totalCalls_onValidatorsCountsByNodeOperatorReportingFinished();
        expect(callsCount).to.be.equal(1);
      });
    });

    it("reverts if main data has not been processed yet", async () => {
      await consensus.advanceTimeToNextFrameStart();
      const report1 = await constructOracleReportWithSingeExtraDataTransactionForCurrentRefSlot();

      await expect(
        oracle.connect(member1).submitReportExtraDataList(report1.extraDataList),
      ).to.be.revertedWithCustomError(oracle, "CannotSubmitExtraDataBeforeMainData");

      await consensus
        .connect(member1)
        .submitReport(report1.reportFields.refSlot, report1.reportHash, CONSENSUS_VERSION);

      await expect(
        oracle.connect(member1).submitReportExtraDataList(report1.extraDataList),
      ).to.be.revertedWithCustomError(oracle, "CannotSubmitExtraDataBeforeMainData");

      await oracle.connect(member1).submitReportData(report1.reportFields, oracleVersion);

      await consensus.advanceTimeToNextFrameStart();
      const report2 = await submitReportHash();

      await expect(
        oracle.connect(member1).submitReportExtraDataList(report2.extraDataList),
      ).to.be.revertedWithCustomError(oracle, "CannotSubmitExtraDataBeforeMainData");
      await expect(
        oracle.connect(member1).submitReportExtraDataList(report2.extraDataList),
      ).to.be.revertedWithCustomError(oracle, "CannotSubmitExtraDataBeforeMainData");
    });

    it("updates extra data processing state", async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportFields, extraDataItemsCount, extraDataHash, extraDataList } = await submitReportHash();
      await oracle.connect(member1).submitReportData(reportFields, oracleVersion);

      const stateBefore = await oracle.getExtraDataProcessingState();

      expect(stateBefore.refSlot).to.be.equal(reportFields.refSlot);
      expect(stateBefore.dataFormat).to.be.equal(EXTRA_DATA_FORMAT_LIST);
      expect(stateBefore.submitted).to.be.false;
      expect(stateBefore.itemsCount).to.be.equal(extraDataItemsCount);
      expect(stateBefore.itemsProcessed).to.be.equal(0);
      expect(stateBefore.lastSortingKey).to.be.equal("0");
      expect(stateBefore.dataHash).to.be.equal(extraDataHash);

      await oracle.connect(member1).submitReportExtraDataList(extraDataList);

      const stateAfter = await oracle.getExtraDataProcessingState();

      expect(stateAfter.refSlot).to.be.equal(reportFields.refSlot);
      expect(stateAfter.dataFormat).to.be.equal(EXTRA_DATA_FORMAT_LIST);
      expect(stateAfter.submitted).to.be.true;
      expect(stateAfter.itemsCount).to.be.equal(extraDataItemsCount);
      expect(stateAfter.itemsProcessed).to.be.equal(extraDataItemsCount);
      // TODO: figure out how to build this value and test it properly
      expect(stateAfter.lastSortingKey).to.be.equal(
        "3533694129556768659166595001485837031654967793751237971583444623713894401",
      );
      expect(stateAfter.dataHash).to.be.equal(extraDataHash);
    });

    it("updates extra data state after previous day report fail", async () => {
      await consensus.advanceTimeToNextFrameStart();

      const extraDataDay1 = {
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

      const { report: reportDay1, extraDataChunks: extraDataChunksDay1 } =
        await constructOracleReportWithDefaultValuesForCurrentRefSlot({
          extraData: extraDataDay1,
          config: { maxItemsPerChunk: 4 },
        });

      expect(extraDataChunksDay1.length).to.be.equal(2);

      const validExtraDataItemsCount = 5;
      const invalidExtraDataItemsCount = 7;
      const reportDay1WithInvalidItemsCount = { ...reportDay1, extraDataItemsCount: invalidExtraDataItemsCount };

      const hashOfReportWithInvalidItemsCount = calcReportDataHash(getReportDataItems(reportDay1WithInvalidItemsCount));
      await oracleMemberSubmitReportHash(reportDay1.refSlot, hashOfReportWithInvalidItemsCount);
      await oracleMemberSubmitReportData(reportDay1WithInvalidItemsCount);
      await oracleMemberSubmitExtraData(extraDataChunksDay1[0]);

      await expect(oracleMemberSubmitExtraData(extraDataChunksDay1[1]))
        .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataItemsCount")
        .withArgs(invalidExtraDataItemsCount, validExtraDataItemsCount);

      const callsCountAfterDay1 = await stakingRouter.totalCalls_onValidatorsCountsByNodeOperatorReportingFinished();
      expect(callsCountAfterDay1).to.be.equal(0);

      await consensus.advanceTimeToNextFrameStart();

      const extraDataDay2 = JSON.parse(JSON.stringify(extraDataDay1));
      extraDataDay2.stuckKeys[0].keysCounts = [2];
      extraDataDay2.exitedKeys[0].keysCounts = [1, 4];

      const { report: reportDay2, extraDataChunks: extraDataChunksDay2 } =
        await constructOracleReportForCurrentFrameAndSubmitReportHash({
          extraData: extraDataDay2,
          config: { maxItemsPerChunk: 4 },
        });

      await oracleMemberSubmitReportData(reportDay2);
      await oracleMemberSubmitExtraData(extraDataChunksDay2[0]);
      await oracleMemberSubmitExtraData(extraDataChunksDay2[1]);

      const callsCountAfterDay2 = await stakingRouter.totalCalls_onValidatorsCountsByNodeOperatorReportingFinished();
      expect(callsCountAfterDay2).to.be.equal(1);
    });
  });
});
