import { expect } from "chai";
import { ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracleTimeTravellable,
  HashConsensusTimeTravellable,
  MockLegacyOracle,
  MockLidoForAccountingOracle,
  MockStakingRouterForAccountingOracle,
  MockWithdrawalQueueForAccountingOracle,
} from "typechain-types";

import { calcReportDataHash, ether, getReportDataItems, hex, OracleReport, ReportAsArray, shareRate } from "lib";
import { CONSENSUS_VERSION } from "lib";

import {
  calcExtraDataListHash,
  deployAndConfigureAccountingOracle,
  encodeExtraDataItems,
  EXTRA_DATA_FORMAT_EMPTY,
  EXTRA_DATA_FORMAT_LIST,
  ExtraDataType,
  ONE_GWEI,
  packExtraDataList,
  V1_ORACLE_LAST_REPORT_SLOT,
} from "./accountingOracleDeploy.test";
import {
  computeTimestampAtSlot,
  GENESIS_TIME,
  SECONDS_PER_EPOCH,
  SECONDS_PER_FRAME,
  SECONDS_PER_SLOT,
  SLOTS_PER_FRAME,
} from "./baseOracle";

describe("AccountingOracle.sol", () => {
  context("Happy path", () => {
    let consensus: HashConsensusTimeTravellable;
    let oracle: AccountingOracleTimeTravellable;
    let oracleVersion: number;
    let mockLido: MockLidoForAccountingOracle;
    let mockWithdrawalQueue: MockWithdrawalQueueForAccountingOracle;
    let mockStakingRouter: MockStakingRouterForAccountingOracle;
    let mockLegacyOracle: MockLegacyOracle;

    let extraData: ExtraDataType;
    let extraDataItems: string[];
    let extraDataList: string;
    let extraDataHash: string;
    let reportFields: OracleReport;
    let reportItems: ReportAsArray;
    let reportHash: string;

    let admin: HardhatEthersSigner;
    let member1: HardhatEthersSigner;
    let member2: HardhatEthersSigner;
    let member3: HardhatEthersSigner;
    let stranger: HardhatEthersSigner;

    before(async () => {
      [admin, member1, member2, member3, stranger] = await ethers.getSigners();

      const deployed = await deployAndConfigureAccountingOracle(admin.address);
      consensus = deployed.consensus;
      oracle = deployed.oracle;
      mockLido = deployed.lido;
      mockWithdrawalQueue = deployed.withdrawalQueue;
      mockStakingRouter = deployed.stakingRouter;
      mockLegacyOracle = deployed.legacyOracle;

      oracleVersion = Number(await oracle.getContractVersion());

      await consensus.connect(admin).addMember(member1, 1);
      await consensus.connect(admin).addMember(member2, 2);
      await consensus.connect(admin).addMember(member3, 2);

      await consensus.advanceTimeBySlots(SECONDS_PER_EPOCH + 1);
    });

    async function triggerConsensusOnHash(hash: string) {
      const { refSlot } = await consensus.getCurrentFrame();
      await consensus.connect(member1).submitReport(refSlot, hash, CONSENSUS_VERSION);
      await consensus.connect(member3).submitReport(refSlot, hash, CONSENSUS_VERSION);
      expect((await consensus.getConsensusState()).consensusReport).to.equal(hash);
    }

    it("initially, consensus report is empty and is not being processed", async () => {
      const report = await oracle.getConsensusReport();
      expect(report.hash).to.equal(ZeroHash);
      // see the next test for refSlot
      expect(report.processingDeadlineTime).to.equal(0);
      expect(report.processingStarted).to.be.false;

      const frame = await consensus.getCurrentFrame();
      const procState = await oracle.getProcessingState();

      expect(procState.currentFrameRefSlot).to.equal(frame.refSlot);
      expect(procState.processingDeadlineTime).to.equal(0);
      expect(procState.mainDataHash).to.equal(ZeroHash);
      expect(procState.mainDataSubmitted).to.be.false;
      expect(procState.extraDataHash).to.equal(ZeroHash);
      expect(procState.extraDataFormat).to.equal(0);
      expect(procState.extraDataSubmitted).to.be.false;
      expect(procState.extraDataItemsCount).to.equal(0);
      expect(procState.extraDataItemsSubmitted).to.equal(0);
    });

    it(`reference slot of the empty initial consensus report is set to the last processed slot of the legacy oracle`, async () => {
      const report = await oracle.getConsensusReport();
      expect(report.refSlot).to.equal(V1_ORACLE_LAST_REPORT_SLOT);
    });

    it("committee reaches consensus on a report hash", async () => {
      const { refSlot } = await consensus.getCurrentFrame();

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
        extraDataFormat: EXTRA_DATA_FORMAT_LIST,
        extraDataHash,
        extraDataItemsCount: extraDataItems.length,
      };

      reportItems = getReportDataItems(reportFields);
      reportHash = calcReportDataHash(reportItems);

      await triggerConsensusOnHash(reportHash);
    });

    it("oracle gets the report hash", async () => {
      const report = await oracle.getConsensusReport();
      expect(report.hash).to.equal(reportHash);
      expect(report.refSlot).to.equal(reportFields.refSlot);
      expect(report.processingDeadlineTime).to.equal(computeTimestampAtSlot(Number(report.refSlot) + SLOTS_PER_FRAME));
      expect(report.processingStarted).to.be.false;

      const frame = await consensus.getCurrentFrame();
      const procState = await oracle.getProcessingState();

      expect(procState.currentFrameRefSlot).to.equal(frame.refSlot);
      expect(procState.processingDeadlineTime).to.equal(
        computeTimestampAtSlot(Number(frame.reportProcessingDeadlineSlot)),
      );
      expect(procState.mainDataHash).to.equal(reportHash);
      expect(procState.mainDataSubmitted).to.be.false;
      expect(procState.extraDataHash).to.equal(ZeroHash);
      expect(procState.extraDataFormat).to.equal(0);
      expect(procState.extraDataSubmitted).to.be.false;
      expect(procState.extraDataItemsCount).to.equal(0);
      expect(procState.extraDataItemsSubmitted).to.equal(0);
    });

    it("some time passes", async () => {
      await consensus.advanceTimeBy(Math.floor(SECONDS_PER_FRAME / 3));
    });

    it("non-member cannot submit the data", async () => {
      await expect(
        oracle.connect(stranger).submitReportData(reportFields, oracleVersion),
      ).to.be.revertedWithCustomError(oracle, "SenderNotAllowed");
    });

    it("the data cannot be submitted passing a different contract version", async () => {
      await expect(oracle.connect(member1).submitReportData(reportFields, oracleVersion - 1))
        .to.be.revertedWithCustomError(oracle, "UnexpectedContractVersion")
        .withArgs(oracleVersion, oracleVersion - 1);
    });

    it(`a data not matching the consensus hash cannot be submitted`, async () => {
      const invalidReport = { ...reportFields, numValidators: Number(reportFields.numValidators) + 1 };
      const invalidReportItems = getReportDataItems(invalidReport);
      const invalidReportHash = calcReportDataHash(invalidReportItems);
      await expect(oracle.connect(member1).submitReportData(invalidReport, oracleVersion))
        .to.be.revertedWithCustomError(oracle, "UnexpectedDataHash")
        .withArgs(reportHash, invalidReportHash);
    });

    let prevProcessingRefSlot: bigint;

    it(`a committee member submits the rebase data`, async () => {
      prevProcessingRefSlot = await oracle.getLastProcessingRefSlot();
      const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
      await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, anyValue);
      // assert.emits(tx, 'ProcessingStarted', { refSlot: reportFields.refSlot })
      expect((await oracle.getConsensusReport()).processingStarted).to.be.true;
      expect(Number(await oracle.getLastProcessingRefSlot())).to.be.above(prevProcessingRefSlot);
    });

    it(`extra data processing is started`, async () => {
      const frame = await consensus.getCurrentFrame();
      const procState = await oracle.getProcessingState();

      expect(procState.currentFrameRefSlot).to.equal(frame.refSlot);
      expect(procState.processingDeadlineTime).to.equal(
        computeTimestampAtSlot(Number(frame.reportProcessingDeadlineSlot)),
      );
      expect(procState.mainDataHash).to.equal(reportHash);
      expect(procState.mainDataSubmitted).to.be.true;
      expect(procState.extraDataHash).to.equal(reportFields.extraDataHash);
      expect(procState.extraDataFormat).to.equal(reportFields.extraDataFormat);
      expect(procState.extraDataSubmitted).to.be.false;
      expect(procState.extraDataItemsCount).to.equal(reportFields.extraDataItemsCount);
      expect(procState.extraDataItemsSubmitted).to.equal(0);
    });

    it(`Lido got the oracle report`, async () => {
      const lastOracleReportCall = await mockLido.getLastCall_handleOracleReport();
      expect(lastOracleReportCall.callCount).to.equal(1);
      expect(lastOracleReportCall.secondsElapsedSinceLastReport).to.equal(
        (Number(reportFields.refSlot) - V1_ORACLE_LAST_REPORT_SLOT) * SECONDS_PER_SLOT,
      );
      expect(lastOracleReportCall.numValidators).to.equal(reportFields.numValidators);
      expect(lastOracleReportCall.clBalance).to.equal(BigInt(reportFields.clBalanceGwei) * ONE_GWEI);
      expect(lastOracleReportCall.withdrawalVaultBalance).to.equal(reportFields.withdrawalVaultBalance);
      expect(lastOracleReportCall.elRewardsVaultBalance).to.equal(reportFields.elRewardsVaultBalance);
      expect(lastOracleReportCall.withdrawalFinalizationBatches.map(Number)).to.have.ordered.members(
        reportFields.withdrawalFinalizationBatches.map(Number),
      );
      expect(lastOracleReportCall.simulatedShareRate).to.equal(reportFields.simulatedShareRate);
    });

    it(`withdrawal queue got bunker mode report`, async () => {
      const onOracleReportLastCall = await mockWithdrawalQueue.lastCall__onOracleReport();
      expect(onOracleReportLastCall.callCount).to.equal(1);
      expect(onOracleReportLastCall.isBunkerMode).to.be.equal(reportFields.isBunkerMode);
      expect(onOracleReportLastCall.prevReportTimestamp).to.be.equal(
        GENESIS_TIME + Number(prevProcessingRefSlot) * SECONDS_PER_SLOT,
      );
    });

    it(`Staking router got the exited keys report`, async () => {
      const lastExitedKeysByModuleCall = await mockStakingRouter.lastCall_updateExitedKeysByModule();
      expect(lastExitedKeysByModuleCall.callCount).to.equal(1);
      expect(lastExitedKeysByModuleCall.moduleIds.map(Number)).to.have.ordered.members(
        reportFields.stakingModuleIdsWithNewlyExitedValidators,
      );
      expect(lastExitedKeysByModuleCall.exitedKeysCounts.map(Number)).to.have.ordered.members(
        reportFields.numExitedValidatorsByStakingModule,
      );
    });

    it(`legacy oracle got CL data report`, async () => {
      const lastLegacyOracleCall = await mockLegacyOracle.lastCall__handleConsensusLayerReport();
      expect(lastLegacyOracleCall.totalCalls).to.equal(1);
      expect(lastLegacyOracleCall.refSlot).to.equal(reportFields.refSlot);
      expect(lastLegacyOracleCall.clBalance).to.equal(BigInt(reportFields.clBalanceGwei) * ONE_GWEI);
      expect(lastLegacyOracleCall.clValidators).to.equal(reportFields.numValidators);
    });

    it(`no data can be submitted for the same reference slot again`, async () => {
      await expect(oracle.connect(member2).submitReportData(reportFields, oracleVersion)).to.be.revertedWithCustomError(
        oracle,
        "RefSlotAlreadyProcessing",
      );
    });

    it("some time passes", async () => {
      const deadline = (await oracle.getConsensusReport()).processingDeadlineTime;
      await consensus.setTime(deadline);
    });

    it("a non-member cannot submit extra data", async () => {
      await expect(oracle.connect(stranger).submitReportExtraDataList(extraDataList)).to.be.revertedWithCustomError(
        oracle,
        "SenderNotAllowed",
      );
    });

    it(`an extra data not matching the consensus hash cannot be submitted`, async () => {
      const invalidExtraData = {
        stuckKeys: [...extraData.stuckKeys],
        exitedKeys: [...extraData.exitedKeys],
      };
      invalidExtraData.exitedKeys[0].keysCounts = [...invalidExtraData.exitedKeys[0].keysCounts];
      ++invalidExtraData.exitedKeys[0].keysCounts[0];
      const invalidExtraDataItems = encodeExtraDataItems(invalidExtraData);
      const invalidExtraDataList = packExtraDataList(invalidExtraDataItems);
      const invalidExtraDataHash = calcExtraDataListHash(invalidExtraDataList);
      await expect(oracle.connect(member2).submitReportExtraDataList(invalidExtraDataList))
        .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataHash")
        .withArgs(extraDataHash, invalidExtraDataHash);
    });

    it(`an empty extra data cannot be submitted`, async () => {
      await expect(oracle.connect(member2).submitReportExtraDataEmpty())
        .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataFormat")
        .withArgs(EXTRA_DATA_FORMAT_LIST, EXTRA_DATA_FORMAT_EMPTY);
    });

    it("a committee member submits extra data", async () => {
      const tx = await oracle.connect(member2).submitReportExtraDataList(extraDataList);

      await expect(tx)
        .to.emit(oracle, "ExtraDataSubmitted")
        .withArgs(reportFields.refSlot, extraDataItems.length, extraDataItems.length);

      const frame = await consensus.getCurrentFrame();
      const procState = await oracle.getProcessingState();

      expect(procState.currentFrameRefSlot).to.equal(frame.refSlot);
      expect(procState.processingDeadlineTime).to.equal(
        computeTimestampAtSlot(Number(frame.reportProcessingDeadlineSlot)),
      );
      expect(procState.mainDataHash).to.equal(reportHash);
      expect(procState.mainDataSubmitted).to.be.true;
      expect(procState.extraDataHash).to.equal(extraDataHash);
      expect(procState.extraDataFormat).to.equal(reportFields.extraDataFormat);
      expect(procState.extraDataSubmitted).to.be.true;
      expect(procState.extraDataItemsCount).to.equal(extraDataItems.length);
      expect(procState.extraDataItemsSubmitted).to.equal(extraDataItems.length);
    });

    it("Staking router got the exited keys by node op report", async () => {
      const totalReportCalls = await mockStakingRouter.totalCalls_reportExitedKeysByNodeOperator();
      expect(totalReportCalls).to.equal(2);

      const call1 = await mockStakingRouter.calls_reportExitedKeysByNodeOperator(0);
      expect(call1.stakingModuleId).to.equal(2);
      expect(call1.nodeOperatorIds).to.equal("0x" + [1, 2].map((i) => hex(i, 8)).join(""));
      expect(call1.keysCounts).to.equal("0x" + [1, 3].map((i) => hex(i, 16)).join(""));

      const call2 = await mockStakingRouter.calls_reportExitedKeysByNodeOperator(1);
      expect(call2.stakingModuleId).to.equal(3);
      expect(call2.nodeOperatorIds).to.equal("0x" + [1].map((i) => hex(i, 8)).join(""));
      expect(call2.keysCounts).to.equal("0x" + [2].map((i) => hex(i, 16)).join(""));
    });

    it("Staking router got the stuck keys by node op report", async () => {
      const totalReportCalls = await mockStakingRouter.totalCalls_reportStuckKeysByNodeOperator();
      expect(totalReportCalls).to.equal(3);

      const call1 = await mockStakingRouter.calls_reportStuckKeysByNodeOperator(0);
      expect(call1.stakingModuleId).to.equal(1);
      expect(call1.nodeOperatorIds).to.equal("0x" + [0].map((i) => hex(i, 8)).join(""));
      expect(call1.keysCounts).to.equal("0x" + [1].map((i) => hex(i, 16)).join(""));

      const call2 = await mockStakingRouter.calls_reportStuckKeysByNodeOperator(1);
      expect(call2.stakingModuleId).to.equal(2);
      expect(call2.nodeOperatorIds).to.equal("0x" + [0].map((i) => hex(i, 8)).join(""));
      expect(call2.keysCounts).to.equal("0x" + [2].map((i) => hex(i, 16)).join(""));

      const call3 = await mockStakingRouter.calls_reportStuckKeysByNodeOperator(2);
      expect(call3.stakingModuleId).to.equal(3);
      expect(call3.nodeOperatorIds).to.equal("0x" + [2].map((i) => hex(i, 8)).join(""));
      expect(call3.keysCounts).to.equal("0x" + [3].map((i) => hex(i, 16)).join(""));
    });

    it("Staking router was told that stuck and exited keys updating is finished", async () => {
      const totalFinishedCalls = await mockStakingRouter.totalCalls_onValidatorsCountsByNodeOperatorReportingFinished();
      expect(totalFinishedCalls).to.equal(1);
    });

    it(`extra data for the same reference slot cannot be re-submitted`, async () => {
      await expect(oracle.connect(member1).submitReportExtraDataList(extraDataList)).to.be.revertedWithCustomError(
        oracle,
        "ExtraDataAlreadyProcessed",
      );
    });

    it("some time passes, a new reporting frame starts", async () => {
      await consensus.advanceTimeToNextFrameStart();

      const frame = await consensus.getCurrentFrame();
      const procState = await oracle.getProcessingState();

      expect(procState.currentFrameRefSlot).to.equal(frame.refSlot);
      expect(procState.processingDeadlineTime).to.equal(0);
      expect(procState.mainDataHash).to.equal(ZeroHash);
      expect(procState.mainDataSubmitted).to.be.false;
      expect(procState.extraDataHash).to.equal(ZeroHash);
      expect(procState.extraDataFormat).to.equal(0);
      expect(procState.extraDataSubmitted).to.be.false;
      expect(procState.extraDataItemsCount).to.equal(0);
      expect(procState.extraDataItemsSubmitted).to.equal(0);
    });

    it("new data report with empty extra data is agreed upon and submitted", async () => {
      const { refSlot } = await consensus.getCurrentFrame();

      reportFields = {
        ...reportFields,
        refSlot: refSlot,
        extraDataFormat: EXTRA_DATA_FORMAT_EMPTY,
        extraDataHash: ZeroHash,
        extraDataItemsCount: 0,
      };
      reportItems = getReportDataItems(reportFields);
      reportHash = calcReportDataHash(reportItems);

      await triggerConsensusOnHash(reportHash);

      const tx = await oracle.connect(member2).submitReportData(reportFields, oracleVersion);
      await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, anyValue);
    });

    it(`Lido got the oracle report`, async () => {
      const lastOracleReportCall = await mockLido.getLastCall_handleOracleReport();
      expect(lastOracleReportCall.callCount).to.equal(2);
    });

    it(`withdrawal queue got their part of report`, async () => {
      const onOracleReportLastCall = await mockWithdrawalQueue.lastCall__onOracleReport();
      expect(onOracleReportLastCall.callCount).to.equal(2);
    });

    it(`Staking router got the exited keys report`, async () => {
      const lastExitedKeysByModuleCall = await mockStakingRouter.lastCall_updateExitedKeysByModule();
      expect(lastExitedKeysByModuleCall.callCount).to.equal(2);
    });

    it(`a non-empty extra data cannot be submitted`, async () => {
      await expect(oracle.connect(member2).submitReportExtraDataList(extraDataList))
        .to.be.revertedWithCustomError(oracle, "UnexpectedExtraDataFormat")
        .withArgs(EXTRA_DATA_FORMAT_EMPTY, EXTRA_DATA_FORMAT_LIST);
    });

    it("a committee member submits empty extra data", async () => {
      const tx = await oracle.connect(member3).submitReportExtraDataEmpty();

      await expect(tx).to.emit(oracle, "ExtraDataSubmitted").withArgs(reportFields.refSlot, 0, 0);

      const frame = await consensus.getCurrentFrame();
      const procState = await oracle.getProcessingState();

      expect(procState.currentFrameRefSlot).to.equal(frame.refSlot);
      expect(procState.processingDeadlineTime).to.equal(
        computeTimestampAtSlot(Number(frame.reportProcessingDeadlineSlot)),
      );
      expect(procState.mainDataHash).to.equal(reportHash);
      expect(procState.mainDataSubmitted).to.be.true;
      expect(procState.extraDataHash).to.equal(ZeroHash);
      expect(procState.extraDataFormat).to.equal(EXTRA_DATA_FORMAT_EMPTY);
      expect(procState.extraDataSubmitted).to.be.true;
      expect(procState.extraDataItemsCount).to.equal(0);
      expect(procState.extraDataItemsSubmitted).to.equal(0);
    });

    it(`Staking router didn't get the exited keys by node op report`, async () => {
      const totalReportCalls = await mockStakingRouter.totalCalls_reportExitedKeysByNodeOperator();
      expect(totalReportCalls).to.equal(2);
    });

    it(`Staking router didn't get the stuck keys by node op report`, async () => {
      const totalReportCalls = await mockStakingRouter.totalCalls_reportStuckKeysByNodeOperator();
      expect(totalReportCalls).to.equal(3);
    });

    it("Staking router was told that stuck and exited keys updating is finished", async () => {
      const totalFinishedCalls = await mockStakingRouter.totalCalls_onValidatorsCountsByNodeOperatorReportingFinished();
      expect(totalFinishedCalls).to.equal(2);
    });

    it(`extra data for the same reference slot cannot be re-submitted`, async () => {
      await expect(oracle.connect(member1).submitReportExtraDataEmpty()).to.be.revertedWithCustomError(
        oracle,
        "ExtraDataAlreadyProcessed",
      );
    });
  });
});
