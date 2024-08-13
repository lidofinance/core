import { expect } from "chai";
import { keccakFromString } from "ethereumjs-util";
import { BigNumberish, getBigInt, ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracleTimeTravellable,
  HashConsensusTimeTravellable,
  LegacyOracle__MockForAccountingOracle,
  MockLidoForAccountingOracle,
  MockStakingRouterForAccountingOracle,
  MockWithdrawalQueueForAccountingOracle,
  OracleReportSanityChecker,
} from "typechain-types";

import {
  calcExtraDataListHash,
  calcReportDataHash,
  CONSENSUS_VERSION,
  encodeExtraDataItems,
  ether,
  EXTRA_DATA_FORMAT_EMPTY,
  EXTRA_DATA_FORMAT_LIST,
  ExtraDataType,
  GENESIS_TIME,
  getReportDataItems,
  ONE_GWEI,
  OracleReport,
  packExtraDataList,
  ReportAsArray,
  SECONDS_PER_SLOT,
  shareRate,
} from "lib";

import { deployAndConfigureAccountingOracle, HASH_1, SLOTS_PER_FRAME } from "test/deploy";
import { Snapshot } from "test/suite";

describe("AccountingOracle.sol:submitReport", () => {
  let consensus: HashConsensusTimeTravellable;
  let oracle: AccountingOracleTimeTravellable;
  let reportItems: ReportAsArray;
  let reportFields: OracleReport & { refSlot: bigint };
  let reportHash: string;
  let extraDataList: string;
  let extraDataHash: string;
  let extraDataItems: string[];
  let oracleVersion: bigint;
  let deadline: BigNumberish;
  let mockStakingRouter: MockStakingRouterForAccountingOracle;
  let extraData: ExtraDataType;
  let mockLido: MockLidoForAccountingOracle;
  let sanityChecker: OracleReportSanityChecker;
  let mockLegacyOracle: LegacyOracle__MockForAccountingOracle;
  let mockWithdrawalQueue: MockWithdrawalQueueForAccountingOracle;
  let snapshot: string;

  let admin: HardhatEthersSigner;
  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;

  const getReportFields = (override = {}) => ({
    consensusVersion: BigInt(CONSENSUS_VERSION),
    refSlot: 0n,
    numValidators: 10n,
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
    extraDataHash,
    extraDataItemsCount: extraDataItems.length,
    ...override,
  });

  const deploy = async () => {
    [admin, member1, member2] = await ethers.getSigners();
    const deployed = await deployAndConfigureAccountingOracle(admin.address);
    const { refSlot } = await deployed.consensus.getCurrentFrame();

    extraData = {
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

    extraDataItems = encodeExtraDataItems(extraData);
    extraDataList = packExtraDataList(extraDataItems);
    extraDataHash = calcExtraDataListHash(extraDataList);
    reportFields = getReportFields({ refSlot });
    reportItems = getReportDataItems(reportFields);
    reportHash = calcReportDataHash(reportItems);
    await deployed.consensus.connect(admin).addMember(member1, 1);
    await deployed.consensus.connect(member1).submitReport(refSlot, reportHash, CONSENSUS_VERSION);

    oracleVersion = await deployed.oracle.getContractVersion();
    deadline = (await deployed.oracle.getConsensusReport()).processingDeadlineTime;

    oracle = deployed.oracle;
    consensus = deployed.consensus;
    mockStakingRouter = deployed.stakingRouter;
    mockLido = deployed.lido;
    sanityChecker = deployed.oracleReportSanityChecker;
    mockLegacyOracle = deployed.legacyOracle;
    mockWithdrawalQueue = deployed.withdrawalQueue;
  };

  async function takeSnapshot() {
    snapshot = await Snapshot.take();
  }

  async function rollback() {
    await Snapshot.restore(snapshot);
  }

  async function prepareNextReport(newReportFields: OracleReport) {
    await consensus.setTime(deadline);

    const newReportItems = getReportDataItems(newReportFields);
    const nextReportHash = calcReportDataHash(newReportItems);

    await consensus.advanceTimeToNextFrameStart();
    await consensus.connect(member1).submitReport(newReportFields.refSlot, nextReportHash, CONSENSUS_VERSION);

    return {
      newReportFields,
      newReportItems,
      reportHash: nextReportHash,
    };
  }

  async function prepareNextReportInNextFrame(newReportFields: OracleReport) {
    const { refSlot } = await consensus.getCurrentFrame();
    const next = await prepareNextReport({
      ...newReportFields,
      refSlot: refSlot + SLOTS_PER_FRAME,
    });
    return next;
  }

  before(deploy);

  context("deploying", () => {
    before(takeSnapshot);
    after(rollback);

    it("deploying accounting oracle", async () => {
      expect(oracle).to.be.not.null;
      expect(consensus).to.be.not.null;
      expect(reportItems).to.be.not.null;
      expect(extraData).to.be.not.null;
      expect(extraDataList).to.be.not.null;
      expect(extraDataHash).to.be.not.null;
      expect(extraDataItems).to.be.not.null;
      expect(oracleVersion).to.be.not.null;
      expect(deadline).to.be.not.null;
      expect(mockStakingRouter).to.be.not.null;
      expect(mockLido).to.be.not.null;
    });
  });

  context("discarded report prevents data submit", () => {
    before(takeSnapshot);
    after(rollback);

    it("report is discarded", async () => {
      const { refSlot } = await consensus.getCurrentFrame();
      const tx = await consensus.connect(admin).addMember(member2, 2);
      await expect(tx).to.emit(oracle, "ReportDiscarded").withArgs(refSlot, reportHash);
    });

    it("processing state reverts to pre-report state ", async () => {
      const state = await oracle.getProcessingState();
      expect(state.mainDataHash).to.equal(ZeroHash);
      expect(state.extraDataHash).to.equal(ZeroHash);
      expect(state.extraDataFormat).to.equal(0);
      expect(state.mainDataSubmitted).to.be.false;
      expect(state.extraDataFormat).to.equal(0);
      expect(state.extraDataItemsCount).to.equal(0);
      expect(state.extraDataItemsSubmitted).to.equal(0);
    });

    it("reverts on trying to submit the discarded report", async () => {
      await expect(oracle.connect(member1).submitReportData(reportFields, oracleVersion)).to.be.revertedWithCustomError(
        oracle,
        "UnexpectedDataHash",
      );
    });
  });

  context("submitReportData", () => {
    beforeEach(takeSnapshot);
    afterEach(rollback);

    context("checks contract version", () => {
      it("should revert if incorrect contract version", async () => {
        await consensus.setTime(deadline);

        const incorrectNextVersion = oracleVersion + 1n;
        const incorrectPrevVersion = oracleVersion - 1n;

        await expect(oracle.connect(member1).submitReportData(reportFields, incorrectNextVersion))
          .to.be.revertedWithCustomError(oracle, "UnexpectedContractVersion")
          .withArgs(oracleVersion, incorrectNextVersion);

        await expect(oracle.connect(member1).submitReportData(reportFields, incorrectPrevVersion))
          .to.be.revertedWithCustomError(oracle, "UnexpectedContractVersion")
          .withArgs(oracleVersion, incorrectPrevVersion);
      });

      it("should should allow calling if correct contract version", async () => {
        await consensus.setTime(deadline);

        const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, anyValue);
      });
    });

    context("checks ref slot", () => {
      it("should revert if incorrect ref slot", async () => {
        await consensus.setTime(deadline);
        const { refSlot } = await consensus.getCurrentFrame();

        const incorrectRefSlot = refSlot + 1n;

        const newReportFields = {
          ...reportFields,
          refSlot: incorrectRefSlot,
        };

        await expect(oracle.connect(member1).submitReportData(newReportFields, oracleVersion))
          .to.be.revertedWithCustomError(oracle, "UnexpectedRefSlot")
          .withArgs(refSlot, incorrectRefSlot);
      });

      it("should should allow calling if correct ref slot", async () => {
        await consensus.setTime(deadline);
        const { newReportFields } = await prepareNextReportInNextFrame({ ...reportFields });
        const tx = await oracle.connect(member1).submitReportData(newReportFields, oracleVersion);
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(newReportFields.refSlot, anyValue);
      });
    });

    context("only allows submitting main data for the same ref. slot once", () => {
      it("reverts on trying to submit the second time", async () => {
        const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, anyValue);
        await expect(
          oracle.connect(member1).submitReportData(reportFields, oracleVersion),
        ).to.be.revertedWithCustomError(oracle, "RefSlotAlreadyProcessing");
      });
    });

    context("checks consensus version", () => {
      it("should revert if incorrect consensus version", async () => {
        await consensus.setTime(deadline);

        const incorrectNextVersion = CONSENSUS_VERSION + 1n;
        const incorrectPrevVersion = CONSENSUS_VERSION + 1n;

        const newReportFields = {
          ...reportFields,
          consensusVersion: incorrectNextVersion,
        };

        const reportFieldsPrevVersion = { ...reportFields, consensusVersion: incorrectPrevVersion };

        await expect(oracle.connect(member1).submitReportData(newReportFields, oracleVersion))
          .to.be.revertedWithCustomError(oracle, "UnexpectedConsensusVersion")
          .withArgs(oracleVersion, incorrectNextVersion);

        await expect(oracle.connect(member1).submitReportData(reportFieldsPrevVersion, oracleVersion))
          .to.be.revertedWithCustomError(oracle, "UnexpectedConsensusVersion")
          .withArgs(oracleVersion, incorrectPrevVersion);
      });

      it("should allow calling if correct consensus version", async () => {
        await consensus.setTime(deadline);
        const { refSlot } = await consensus.getCurrentFrame();

        const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(refSlot, anyValue);

        const newConsensusVersion = CONSENSUS_VERSION + 1n;
        const nextRefSlot = refSlot + SLOTS_PER_FRAME;
        const newReportFields = {
          ...reportFields,
          refSlot: nextRefSlot,
          consensusVersion: newConsensusVersion,
        };
        const newReportItems = getReportDataItems(newReportFields);
        const newReportHash = calcReportDataHash(newReportItems);

        await oracle.connect(admin).setConsensusVersion(newConsensusVersion);
        await consensus.advanceTimeToNextFrameStart();
        await consensus.connect(member1).submitReport(newReportFields.refSlot, newReportHash, newConsensusVersion);

        const txNewVersion = await oracle.connect(member1).submitReportData(newReportFields, oracleVersion);
        await expect(txNewVersion).to.emit(oracle, "ProcessingStarted").withArgs(newReportFields.refSlot, anyValue);
      });
    });

    context("enforces module ids sorting order", () => {
      it("should revert if incorrect stakingModuleIdsWithNewlyExitedValidators order (when next number in list is less than previous)", async () => {
        const { newReportFields } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [2, 1],
          numExitedValidatorsByStakingModule: [3, 4],
        });

        await expect(
          oracle.connect(member1).submitReportData(newReportFields, oracleVersion),
        ).to.be.revertedWithCustomError(oracle, "InvalidExitedValidatorsData");
      });

      it("should revert if incorrect stakingModuleIdsWithNewlyExitedValidators order (when next number in list equals to previous)", async () => {
        const { newReportFields } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [1, 1],
          numExitedValidatorsByStakingModule: [3, 4],
        });

        await expect(
          oracle.connect(member1).submitReportData(newReportFields, oracleVersion),
        ).to.be.revertedWithCustomError(oracle, "InvalidExitedValidatorsData");
      });

      it("should should allow calling if correct extra data list moduleId", async () => {
        const { newReportFields } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [1, 2],
          numExitedValidatorsByStakingModule: [3, 4],
        });

        const tx = await oracle.connect(member1).submitReportData(newReportFields, oracleVersion);
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(newReportFields.refSlot, anyValue);
      });
    });

    context("checks data hash", () => {
      it("reverts with UnexpectedDataHash", async () => {
        const incorrectReportFields = {
          ...reportFields,
          numValidators: Number(reportFields.numValidators) - 1,
        };
        const incorrectReportItems = getReportDataItems(incorrectReportFields);

        const correctDataHash = calcReportDataHash(reportItems);
        const incorrectDataHash = calcReportDataHash(incorrectReportItems);

        await expect(oracle.connect(member1).submitReportData(incorrectReportFields, oracleVersion))
          .to.be.revertedWithCustomError(oracle, "UnexpectedDataHash")
          .withArgs(correctDataHash, incorrectDataHash);
      });

      it("submits if data successfully pass hash validation", async () => {
        const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, anyValue);
      });
    });

    context("enforces data safety boundaries", () => {
      it("reverts with MaxAccountingExtraDataItemsCountExceeded if data limit exceeds", async () => {
        const MAX_ACCOUNTING_EXTRA_DATA_LIMIT = 1;
        await sanityChecker.connect(admin).setMaxAccountingExtraDataListItemsCount(MAX_ACCOUNTING_EXTRA_DATA_LIMIT);

        expect((await sanityChecker.getOracleReportLimits()).maxAccountingExtraDataListItemsCount).to.equal(
          MAX_ACCOUNTING_EXTRA_DATA_LIMIT,
        );

        await expect(oracle.connect(member1).submitReportData(reportFields, oracleVersion))
          .to.be.revertedWithCustomError(sanityChecker, "MaxAccountingExtraDataItemsCountExceeded")
          .withArgs(MAX_ACCOUNTING_EXTRA_DATA_LIMIT, reportFields.extraDataItemsCount);
      });

      it("passes fine on borderline data limit value — when it equals to count of passed items", async () => {
        const MAX_ACCOUNTING_EXTRA_DATA_LIMIT = reportFields.extraDataItemsCount;

        await sanityChecker.connect(admin).setMaxAccountingExtraDataListItemsCount(MAX_ACCOUNTING_EXTRA_DATA_LIMIT);

        expect((await sanityChecker.getOracleReportLimits()).maxAccountingExtraDataListItemsCount).to.equal(
          MAX_ACCOUNTING_EXTRA_DATA_LIMIT,
        );

        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
      });

      it("reverts with InvalidExitedValidatorsData if counts of stakingModuleIds and numExitedValidatorsByStakingModule does not match", async () => {
        const { newReportFields } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [1, 2],
          numExitedValidatorsByStakingModule: [3],
        });
        await expect(
          oracle.connect(member1).submitReportData(newReportFields, oracleVersion),
        ).to.be.revertedWithCustomError(oracle, "InvalidExitedValidatorsData");
      });

      it("reverts with InvalidExitedValidatorsData if any record for number of exited validators equals 0", async () => {
        const { newReportFields } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [1, 2],
          numExitedValidatorsByStakingModule: [3, 0],
        });
        await expect(
          oracle.connect(member1).submitReportData(newReportFields, oracleVersion),
        ).to.be.revertedWithCustomError(oracle, "InvalidExitedValidatorsData");
      });

      it("reverts with ExitedValidatorsLimitExceeded if exited validators rate limit will be reached", async () => {
        // Really simple test here for now
        // TODO: Come up with more tests for better coverage of edge-case scenarios that can be accrued
        //       during calculation `exitedValidatorsPerDay` rate in AccountingOracle:612
        const totalExitedValidators = reportFields.numExitedValidatorsByStakingModule.reduce(
          (sum: BigNumberish, curr: BigNumberish) => getBigInt(sum) + getBigInt(curr),
          0,
        );
        const exitingRateLimit = getBigInt(totalExitedValidators) - 1n;
        await sanityChecker.setChurnValidatorsPerDayLimit(exitingRateLimit);
        expect((await sanityChecker.getOracleReportLimits()).churnValidatorsPerDayLimit).to.equal(exitingRateLimit);
        await expect(oracle.connect(member1).submitReportData(reportFields, oracleVersion))
          .to.be.revertedWithCustomError(sanityChecker, "ExitedValidatorsLimitExceeded")
          .withArgs(exitingRateLimit, totalExitedValidators);
      });
    });

    context("delivers the data to corresponded contracts", () => {
      it("should call handleOracleReport on Lido", async () => {
        expect((await mockLido.getLastCall_handleOracleReport()).callCount).to.equal(0);
        await consensus.setTime(deadline);
        const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, anyValue);

        const lastOracleReportToLido = await mockLido.getLastCall_handleOracleReport();

        expect(lastOracleReportToLido.callCount).to.equal(1);
        expect(lastOracleReportToLido.currentReportTimestamp).to.equal(
          GENESIS_TIME + reportFields.refSlot * SECONDS_PER_SLOT,
        );
        expect(lastOracleReportToLido.callCount).to.equal(1);
        expect(lastOracleReportToLido.currentReportTimestamp).to.equal(
          GENESIS_TIME + reportFields.refSlot * SECONDS_PER_SLOT,
        );

        expect(lastOracleReportToLido.clBalance).to.equal(reportFields.clBalanceGwei + "000000000");
        expect(lastOracleReportToLido.withdrawalVaultBalance).to.equal(reportFields.withdrawalVaultBalance);
        expect(lastOracleReportToLido.elRewardsVaultBalance).to.equal(reportFields.elRewardsVaultBalance);
        expect(lastOracleReportToLido.withdrawalFinalizationBatches.map(Number)).to.have.ordered.members(
          reportFields.withdrawalFinalizationBatches.map(Number),
        );
        expect(lastOracleReportToLido.simulatedShareRate).to.equal(reportFields.simulatedShareRate);
      });

      it("should call updateExitedValidatorsCountByStakingModule on StakingRouter", async () => {
        expect((await mockStakingRouter.lastCall_updateExitedKeysByModule()).callCount).to.equal(0);
        await consensus.setTime(deadline);
        const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, anyValue);

        const lastOracleReportToStakingRouter = await mockStakingRouter.lastCall_updateExitedKeysByModule();

        expect(lastOracleReportToStakingRouter.callCount).to.equal(1);
        expect(lastOracleReportToStakingRouter.moduleIds.map(Number)).to.have.ordered.members(
          reportFields.stakingModuleIdsWithNewlyExitedValidators.map(Number),
        );
        expect(lastOracleReportToStakingRouter.exitedKeysCounts.map(Number)).to.have.ordered.members(
          reportFields.numExitedValidatorsByStakingModule.map(Number),
        );
      });

      it("does not calling StakingRouter.updateExitedKeysByModule if lists of exited validators is empty", async () => {
        const { newReportFields } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [],
          numExitedValidatorsByStakingModule: [],
        });
        const tx = await oracle.connect(member1).submitReportData(newReportFields, oracleVersion);
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(newReportFields.refSlot, anyValue);
        const lastOracleReportToStakingRouter = await mockStakingRouter.lastCall_updateExitedKeysByModule();
        expect(lastOracleReportToStakingRouter.callCount).to.equal(0);
      });

      it("should call handleConsensusLayerReport on legacyOracle", async () => {
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        const lastCall = await mockLegacyOracle.lastCall__handleConsensusLayerReport();
        expect(lastCall.totalCalls).to.equal(1);
        expect(lastCall.refSlot).to.equal(reportFields.refSlot);
        expect(lastCall.clBalance).to.equal(getBigInt(reportFields.clBalanceGwei) * ONE_GWEI);
        expect(lastCall.clValidators).to.equal(reportFields.numValidators);
      });

      it("should call onOracleReport on WithdrawalQueue", async () => {
        const prevProcessingRefSlot = await oracle.getLastProcessingRefSlot();
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        const currentProcessingRefSlot = await oracle.getLastProcessingRefSlot();
        const lastCall = await mockWithdrawalQueue.lastCall__onOracleReport();
        expect(lastCall.callCount).to.equal(1);
        expect(lastCall.isBunkerMode).to.equal(reportFields.isBunkerMode);
        expect(lastCall.prevReportTimestamp).to.equal(GENESIS_TIME + prevProcessingRefSlot * SECONDS_PER_SLOT);
        expect(lastCall.currentReportTimestamp).to.equal(GENESIS_TIME + currentProcessingRefSlot * SECONDS_PER_SLOT);
      });
    });

    context("warns when prev extra data has not been processed yet", () => {
      it("emits WarnExtraDataIncompleteProcessing", async () => {
        await consensus.setTime(deadline);
        const prevRefSlot = Number((await consensus.getCurrentFrame()).refSlot);
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        await consensus.advanceTimeToNextFrameStart();
        const nextRefSlot = Number((await consensus.getCurrentFrame()).refSlot);
        const tx = await consensus.connect(member1).submitReport(nextRefSlot, HASH_1, CONSENSUS_VERSION);
        await expect(tx)
          .to.emit(oracle, "WarnExtraDataIncompleteProcessing")
          .withArgs(prevRefSlot, 0, extraDataItems.length);
      });
    });

    context("enforces extra data format", () => {
      it("should revert on invalid extra data format", async () => {
        await consensus.setTime(deadline);
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);

        const nextRefSlot = reportFields.refSlot + SLOTS_PER_FRAME;
        const changedReportFields = {
          ...reportFields,
          refSlot: nextRefSlot,
          extraDataFormat: EXTRA_DATA_FORMAT_LIST + 1n,
        };
        const changedReportItems = getReportDataItems(changedReportFields);

        const changedReportHash = calcReportDataHash(changedReportItems);
        await consensus.advanceTimeToNextFrameStart();
        await consensus.connect(member1).submitReport(nextRefSlot, changedReportHash, CONSENSUS_VERSION);

        await expect(oracle.connect(member1).submitReportData(changedReportFields, oracleVersion))
          .to.be.revertedWithCustomError(oracle, "UnsupportedExtraDataFormat")
          .withArgs(EXTRA_DATA_FORMAT_LIST + 1n);
      });

      it("should revert on non-empty format but zero length", async () => {
        await consensus.setTime(deadline);
        const { refSlot } = await consensus.getCurrentFrame();
        const newReportFields = getReportFields({
          refSlot: refSlot,
          extraDataItemsCount: 0,
        });
        const newReportItems = getReportDataItems(newReportFields);
        const newReportHash = calcReportDataHash(newReportItems);
        await consensus.connect(member1).submitReport(refSlot, newReportHash, CONSENSUS_VERSION);
        await expect(
          oracle.connect(member1).submitReportData(newReportFields, oracleVersion),
        ).to.be.revertedWithCustomError(oracle, "ExtraDataItemsCountCannotBeZeroForNonEmptyData");
      });

      it("should revert on non-empty format but zero hash", async () => {
        await consensus.setTime(deadline);
        const { refSlot } = await consensus.getCurrentFrame();
        const newReportFields = getReportFields({
          refSlot: refSlot,
          extraDataHash: ZeroHash,
        });
        const newReportItems = getReportDataItems(newReportFields);
        const newReportHash = calcReportDataHash(newReportItems);
        await consensus.connect(member1).submitReport(refSlot, newReportHash, CONSENSUS_VERSION);
        await expect(
          oracle.connect(member1).submitReportData(newReportFields, oracleVersion),
        ).to.be.revertedWithCustomError(oracle, "ExtraDataHashCannotBeZeroForNonEmptyData");
      });
    });

    context("enforces zero extraData fields for the empty format", () => {
      it("should revert for non empty ExtraDataHash", async () => {
        await consensus.setTime(deadline);
        const { refSlot } = await consensus.getCurrentFrame();
        const nonZeroHash = keccakFromString("nonZeroHash");
        const newReportFields = getReportFields({
          refSlot: refSlot,
          isBunkerMode: false,
          extraDataFormat: EXTRA_DATA_FORMAT_EMPTY,
          extraDataHash: nonZeroHash,
          extraDataItemsCount: 0,
        });
        const newReportItems = getReportDataItems(newReportFields);
        const newReportHash = calcReportDataHash(newReportItems);
        await consensus.connect(member1).submitReport(refSlot, newReportHash, CONSENSUS_VERSION);
        await expect(oracle.connect(member1).submitReportData(newReportFields, oracleVersion))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataHash")
          .withArgs(ZeroHash, nonZeroHash);
      });

      it("should revert for non zero ExtraDataLength", async () => {
        await consensus.setTime(deadline);
        const { refSlot } = await consensus.getCurrentFrame();
        const newReportFields = getReportFields({
          refSlot: refSlot,
          isBunkerMode: false,
          extraDataFormat: EXTRA_DATA_FORMAT_EMPTY,
          extraDataHash: ZeroHash,
          extraDataItemsCount: 10,
        });
        const newReportItems = getReportDataItems(newReportFields);
        const newReportHash = calcReportDataHash(newReportItems);
        await consensus.connect(member1).submitReport(refSlot, newReportHash, CONSENSUS_VERSION);
        await expect(oracle.connect(member1).submitReportData(newReportFields, oracleVersion))
          .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataItemsCount")
          .withArgs(0, 10);
      });
    });

    context("ExtraDataProcessingState", () => {
      it("should be empty from start", async () => {
        const data = await oracle.getExtraDataProcessingState();
        expect(data.refSlot).to.equal(0);
        expect(data.dataFormat).to.equal(0);
        expect(data.itemsCount).to.equal(0);
        expect(data.itemsProcessed).to.equal(0);
        expect(data.lastSortingKey).to.equal(0);
        expect(data.dataHash).to.equal(ZeroHash);
      });

      it("should be filled with report data after submitting", async () => {
        await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        const data = await oracle.getExtraDataProcessingState();
        expect(data.refSlot).to.equal(reportFields.refSlot);
        expect(data.dataFormat).to.equal(reportFields.extraDataFormat);
        expect(data.itemsCount).to.equal(reportFields.extraDataItemsCount);
        expect(data.itemsProcessed).to.equal(0);
        expect(data.lastSortingKey).to.equal(0);
        expect(data.dataHash).to.equal(reportFields.extraDataHash);
      });
    });
  });
});
