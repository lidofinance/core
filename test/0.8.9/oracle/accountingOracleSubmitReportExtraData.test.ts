import { expect } from "chai";
import { ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracleTimeTravellable,
  HashConsensusTimeTravellable,
  MockStakingRouterForAccountingOracle,
  OracleReportSanityChecker,
} from "typechain-types";

import { calcReportDataHash, ether, getReportDataItems, hex, OracleReport, shareRate, Snapshot } from "lib";
import { CONSENSUS_VERSION } from "lib";

import {
  calcExtraDataListHash,
  deployAndConfigureAccountingOracle,
  encodeExtraDataItem,
  encodeExtraDataItems,
  EXTRA_DATA_FORMAT_EMPTY,
  EXTRA_DATA_FORMAT_LIST,
  EXTRA_DATA_TYPE_STUCK_VALIDATORS,
  ExtraDataType,
  ONE_GWEI,
  packExtraDataList,
} from "./accountingOracleDeploy.test";

const getDefaultExtraData = () => ({
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

describe("AccountingOracle.sol", () => {
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

  interface ReportDataArgs {
    extraData?: ExtraDataType;
    extraDataItems?: string[];
    reportFields?: object;
  }

  async function takeSnapshot() {
    snapshot = await Snapshot.take();
  }

  async function rollback() {
    await Snapshot.restore(snapshot);
  }

  function getReportData({ extraData, extraDataItems, reportFields }: ReportDataArgs = {}) {
    const extraDataValue = extraData || getDefaultExtraData();
    const extraDataItemsValue = extraDataItems || encodeExtraDataItems(extraDataValue);
    const extraDataList = packExtraDataList(extraDataItemsValue);
    const extraDataHash = calcExtraDataListHash(extraDataList);

    const reportFieldsArg = getDefaultReportFields({
      extraDataHash,
      extraDataItemsCount: extraDataItemsValue.length,
      ...reportFields,
    });

    const reportItems = getReportDataItems(reportFieldsArg);
    const reportHash = calcReportDataHash(reportItems);

    return {
      extraData: extraDataValue,
      extraDataItems: extraDataItemsValue,
      extraDataList,
      extraDataHash,
      reportFields: reportFieldsArg,
      reportItems,
      reportHash,
    };
  }

  async function prepareReport({ extraData, extraDataItems, reportFields }: ReportDataArgs = {}) {
    const { refSlot } = await consensus.getCurrentFrame();
    return getReportData({ extraData, extraDataItems, reportFields: { ...reportFields, refSlot } as OracleReport });
  }

  async function submitReportHash({ extraData, extraDataItems, reportFields }: ReportDataArgs = {}) {
    const data = await prepareReport({ extraData, extraDataItems, reportFields });
    await consensus.connect(member1).submitReport(data.reportFields.refSlot, data.reportHash, CONSENSUS_VERSION);
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

    context("enforces the deadline", () => {
      it("reverts with ProcessingDeadlineMissed if deadline missed", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { reportFields, extraDataList } = await submitReportHash();
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        await consensus.advanceTimeToNextFrameStart();
        await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
          .to.be.revertedWithCustomError(oracle, "ProcessingDeadlineMissed")
          .withArgs(deadline);
      });

      it("pass successfully if time is equals exactly to deadline value", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { extraDataList, reportFields } = await submitReportHash();
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
        await consensus.setTime(deadline);
        const tx = await oracle.connect(member1).submitReportExtraDataList(extraDataList);
        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
      });
    });

    context("checks ref slot", () => {
      it("reverts with CannotSubmitExtraDataBeforeMainData in attempt of try to pass extra data ahead of submitReportData", async () => {
        const { refSlot } = await consensus.getCurrentFrame();
        const { reportHash, extraDataList } = getReportData({ reportFields: { refSlot } });
        await consensus.connect(member1).submitReport(refSlot, reportHash, CONSENSUS_VERSION);
        // No submitReportData here — trying to send extra data ahead of it
        await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList)).to.be.revertedWithCustomError(
          oracle,
          "CannotSubmitExtraDataBeforeMainData",
        );
      });

      it("pass successfully ", async () => {
        const { refSlot } = await consensus.getCurrentFrame();
        const { reportFields, reportHash, extraDataList } = getReportData({ reportFields: { refSlot } });
        await consensus.connect(member1).submitReport(refSlot, reportHash, CONSENSUS_VERSION);
        // Now submitReportData on it's place
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        const tx = await oracle.connect(member1).submitReportExtraDataList(extraDataList);
        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
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

      it("pass successfully if data hash matches", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { extraDataList, reportFields } = await submitReportHash();
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        const tx = await oracle.connect(member1).submitReportExtraDataList(extraDataList);
        await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
      });
    });

    context("checks items count", () => {
      it("reverts with UnexpectedExtraDataItemsCount if there was wrong amount of items", async () => {
        const wrongItemsCount = 1;
        await consensus.advanceTimeToNextFrameStart();
        const { extraDataList, extraDataItems, reportFields } = await submitReportHash({
          reportFields: { extraDataItemsCount: wrongItemsCount },
        });
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataItemsCount")
          .withArgs(reportFields.extraDataItemsCount, extraDataItems.length);
      });
    });

    context("enforces data format", () => {
      it("reverts with UnexpectedExtraDataFormat if there was empty format submitted on first phase", async () => {
        const reportFieldsConsts = {
          extraDataHash: ZeroHash,
          extraDataFormat: EXTRA_DATA_FORMAT_EMPTY,
          extraDataItemsCount: 0,
        };
        await consensus.advanceTimeToNextFrameStart();
        const { reportFields, extraDataList } = await submitReportHash({ reportFields: reportFieldsConsts });
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataFormat")
          .withArgs(EXTRA_DATA_FORMAT_EMPTY, EXTRA_DATA_FORMAT_LIST);
      });
    });

    context("enforces module ids sorting order", () => {
      it("should revert if incorrect extra data list stuckKeys moduleId", async () => {
        const extraDataDefault = getDefaultExtraData();
        const invalidExtraData = {
          ...extraDataDefault,
          stuckKeys: [
            ...extraDataDefault.stuckKeys,
            { moduleId: 4, nodeOpIds: [1], keysCounts: [2] },
            { moduleId: 4, nodeOpIds: [1], keysCounts: [2] },
          ],
        };

        await consensus.advanceTimeToNextFrameStart();
        const { reportFields, extraDataList } = await submitReportHash({ extraData: invalidExtraData });
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);

        await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
          .to.be.revertedWithCustomError(oracle, "InvalidExtraDataSortOrder")
          .withArgs(4);
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
          const { extraData, extraDataItems, lastIndexDefault, lastIndexCustom } = getExtraWithCustomLastIndex(1, 1);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData, extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataIndex")
            .withArgs(lastIndexDefault, lastIndexCustom);
        });

        it("if next index is greater than previous for more than +1", async () => {
          const { extraData, extraDataItems, lastIndexDefault, lastIndexCustom } = getExtraWithCustomLastIndex(2, 2);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData, extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataIndex")
            .withArgs(lastIndexDefault, lastIndexCustom);
        });

        it("if next index equals to previous", async () => {
          const { extraData, extraDataItems, lastIndexDefault, lastIndexCustom } = getExtraWithCustomLastIndex(3, 1);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData, extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataIndex")
            .withArgs(lastIndexDefault, lastIndexCustom);
        });

        it("if next index less than previous", async () => {
          const { extraData, extraDataItems, lastIndexDefault, lastIndexCustom } = getExtraWithCustomLastIndex(3, 0);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData, extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataIndex")
            .withArgs(lastIndexDefault, lastIndexCustom);
        });

        it("succeeds if indexes were passed sequentially", async () => {
          const { extraData, extraDataItems } = getExtraWithCustomLastIndex(3, 2);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData, extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          const tx = await oracle.connect(member1).submitReportExtraDataList(extraDataList);
          await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
        });
      });

      context("checks data type for UnsupportedExtraDataType reverts (only supported types are `1` and `2`)", () => {
        // contextual helper to prepeare wrong typed data
        const getExtraWithCustomType = (typeCustom: number) => {
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
          const { extraData, extraDataItems, wrongTypedIndex, typeCustom } = getExtraWithCustomType(0);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData, extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "UnsupportedExtraDataType")
            .withArgs(wrongTypedIndex, typeCustom);
        });

        it("if type `3` was passed", async () => {
          const { extraData, extraDataItems, wrongTypedIndex, typeCustom } = getExtraWithCustomType(3);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData, extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList))
            .to.be.revertedWithCustomError(oracle, "UnsupportedExtraDataType")
            .withArgs(wrongTypedIndex, typeCustom);
        });

        it("succeeds if `1` was passed", async () => {
          const { extraData, extraDataItems } = getExtraWithCustomType(1);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData, extraDataItems });
          await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
          const tx = await oracle.connect(member1).submitReportExtraDataList(extraDataList);
          await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
        });

        it("succeeds if `2` was passed", async () => {
          const { extraData, extraDataItems } = getExtraWithCustomType(2);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData, extraDataItems });
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
          await sanityChecker.setMaxNodeOperatorsPerExtraDataItemCount(problematicItemsCount - 1);
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
          await sanityChecker.setMaxAccountingExtraDataListItemsCount(problematicItemsCount);
          const tx = await oracle.connect(member1).submitReportExtraDataList(extraDataList);
          await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, anyValue, anyValue);
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
          const { reportFields, extraDataList } = await submitReportHash({ extraData, extraDataItems });
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
          const { reportFields, extraDataList } = await submitReportHash({ extraData, extraDataItems });
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
          const extraDataItems = encodeExtraDataItems(extraData);
          await consensus.advanceTimeToNextFrameStart();
          const { reportFields, extraDataList } = await submitReportHash({ extraData, extraDataItems });
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
        const { reportFields, extraData, extraDataList } = await submitReportHash();
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);

        await oracle.connect(member1).submitReportExtraDataList(extraDataList);

        const callsCount = await stakingRouter.totalCalls_reportStuckKeysByNodeOperator();
        expect(callsCount).to.be.equal(extraData.stuckKeys.length);

        for (let i = 0; i < callsCount; i++) {
          const call = await stakingRouter.calls_reportStuckKeysByNodeOperator(i);
          const item = extraData.stuckKeys[i];
          expect(call.stakingModuleId).to.be.equal(item.moduleId);
          expect(call.nodeOperatorIds).to.be.equal("0x" + item.nodeOpIds.map((id) => hex(id, 8)).join(""));
          expect(call.keysCounts).to.be.equal("0x" + item.keysCounts.map((count) => hex(count, 16)).join(""));
        }
      });

      it("calls reportStakingModuleExitedValidatorsCountByNodeOperator on StakingRouter", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { reportFields, extraData, extraDataList } = await submitReportHash();
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);

        await oracle.connect(member1).submitReportExtraDataList(extraDataList);

        const callsCount = await stakingRouter.totalCalls_reportExitedKeysByNodeOperator();
        expect(callsCount).to.be.equal(extraData.exitedKeys.length);

        for (let i = 0; i < callsCount; i++) {
          const call = await stakingRouter.calls_reportExitedKeysByNodeOperator(i);
          const item = extraData.exitedKeys[i];
          expect(call.stakingModuleId).to.be.equal(item.moduleId);
          expect(call.nodeOperatorIds).to.be.equal("0x" + item.nodeOpIds.map((id) => hex(id, 8)).join(""));
          expect(call.keysCounts).to.be.equal("0x" + item.keysCounts.map((count) => hex(count, 16)).join(""));
        }
      });

      it("calls onValidatorsCountsByNodeOperatorReportingFinished on StakingRouter", async () => {
        await consensus.advanceTimeToNextFrameStart();
        const { reportFields, extraDataList } = await submitReportHash();
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);

        await oracle.connect(member1).submitReportExtraDataList(extraDataList);
        const callsCount = await stakingRouter.totalCalls_onValidatorsCountsByNodeOperatorReportingFinished();
        expect(callsCount).to.be.equal(1);
      });
    });

    it("reverts if extraData has already been already processed", async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportFields, extraDataItems, extraDataList } = await submitReportHash();
      await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
      await oracle.connect(member1).submitReportExtraDataList(extraDataList);
      const state = await oracle.getExtraDataProcessingState();
      expect(state.itemsCount).to.be.equal(extraDataItems.length);
      expect(state.itemsCount).to.be.equal(state.itemsProcessed);
      await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList)).to.be.revertedWithCustomError(
        oracle,
        "ExtraDataAlreadyProcessed",
      );
    });

    it("reverts if main data has not been processed yet", async () => {
      await consensus.advanceTimeToNextFrameStart();
      const report1 = await prepareReport();

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
      const { reportFields, extraDataItems, extraDataHash, extraDataList } = await submitReportHash();
      await oracle.connect(member1).submitReportData(reportFields, oracleVersion);

      const stateBefore = await oracle.getExtraDataProcessingState();

      expect(stateBefore.refSlot).to.be.equal(reportFields.refSlot);
      expect(stateBefore.dataFormat).to.be.equal(EXTRA_DATA_FORMAT_LIST);
      expect(stateBefore.submitted).to.be.false;
      expect(stateBefore.itemsCount).to.be.equal(extraDataItems.length);
      expect(stateBefore.itemsProcessed).to.be.equal(0);
      expect(stateBefore.lastSortingKey).to.be.equal("0");
      expect(stateBefore.dataHash).to.be.equal(extraDataHash);

      await oracle.connect(member1).submitReportExtraDataList(extraDataList);

      const stateAfter = await oracle.getExtraDataProcessingState();

      expect(stateAfter.refSlot).to.be.equal(reportFields.refSlot);
      expect(stateAfter.dataFormat).to.be.equal(EXTRA_DATA_FORMAT_LIST);
      expect(stateAfter.submitted).to.be.true;
      expect(stateAfter.itemsCount).to.be.equal(extraDataItems.length);
      expect(stateAfter.itemsProcessed).to.be.equal(extraDataItems.length);
      // TODO: figure out how to build this value and test it properly
      expect(stateAfter.lastSortingKey).to.be.equal(
        "3533694129556768659166595001485837031654967793751237971583444623713894401",
      );
      expect(stateAfter.dataHash).to.be.equal(extraDataHash);
    });
  });
});
