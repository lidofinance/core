import { expect } from "chai";
import { BigNumberish, ZeroHash } from "ethers";
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

import { calcReportDataHash, ether, getReportDataItems, hex, OracleReport, ReportAsArray, shareRate, Snapshot } from "lib";
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

describe('AccountingOracle.sol', () => {
  let consensus: HashConsensusTimeTravellable;
  let oracle: AccountingOracleTimeTravellable;
  let reportItems: ReportAsArray;
  let reportFields: OracleReport;
  let reportHash: string;
  let extraDataList: string;
  let extraDataHash: string;
  let extraDataItems: string[];
  let oracleVersion: bigint;
  let deadline: BigNumberish;
  let mockStakingRouter: MockStakingRouterForAccountingOracle;
  let extraData: ExtraDataType;
  let mockLido: MockLidoForAccountingOracle;
  let oracleReportSanityChecker: OracleReportSanityChecker;
  let mockLegacyOracle: MockLegacyOracle;
  let mockWithdrawalQueue: MockWithdrawalQueueForAccountingOracle;
  let snapshot: string;

  let admin: HardhatEthersSigner;
  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;

  const getReportFields = (override = {}) => ({
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
    extraDataHash,
    extraDataItemsCount: extraDataItems.length,
    ...override,
  })

  const deploy = async (options = undefined) => {
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
    }

    extraDataItems = encodeExtraDataItems(extraData)
    extraDataList = packExtraDataList(extraDataItems)
    extraDataHash = calcExtraDataListHash(extraDataList)
    reportFields = getReportFields({
      refSlot: refSlot,
    })
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
    oracleReportSanityChecker = deployed.oracleReportSanityChecker;
    mockLegacyOracle = deployed.legacyOracle;
    mockWithdrawalQueue = deployed.withdrawalQueue;
  }

  async function takeSnapshot() {
    snapshot = await Snapshot.take();
  }

  async function rollback() {
    await Snapshot.restore(snapshot);
  }

  async function prepareNextReport(newReportFields: OracleReport) {
    await consensus.setTime(deadline);

    const newReportItems = getReportDataItems(newReportFields);
    const reportHash = calcReportDataHash(newReportItems);

    await consensus.advanceTimeToNextFrameStart();
    await consensus.connect(member1).submitReport(newReportFields.refSlot, reportHash, CONSENSUS_VERSION);

    return {
      newReportFields,
      newReportItems,
      reportHash,
    }
  }

  async function prepareNextReportInNextFrame(newReportFields: OracleReport) {
    const { refSlot } = await consensus.getCurrentFrame();
    const next = await prepareNextReport({
      ...newReportFields,
      refSlot: Number(refSlot) + SLOTS_PER_FRAME,
    })
    return next;
  }
  before(deploy);

  context('deploying', () => {
    before(takeSnapshot);
    after(rollback)

    it('deploying accounting oracle', async () => {
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
    })
  })

  context('discarded report prevents data submit', () => {
    before(takeSnapshot);
    after(rollback)

    it('report is discarded', async () => {
      const { refSlot } = await consensus.getCurrentFrame();
      const tx = await consensus.connect(admin).addMember(member2, 2);
      await expect(tx).to.emit(oracle, 'ReportDiscarded').withArgs(refSlot, reportHash);
    })

    it('processing state reverts to pre-report state ', async () => {
      const state = await oracle.getProcessingState();
      expect(state.mainDataHash).to.be.equal(ZeroHash);
      expect(state.extraDataHash).to.be.equal(ZeroHash);
      expect(state.extraDataFormat).to.be.equal(0);
      expect(state.mainDataSubmitted).to.be.false;
      expect(state.extraDataFormat).to.be.equal(0);
      expect(state.extraDataItemsCount).to.be.equal(0);
      expect(state.extraDataItemsSubmitted).to.be.equal(0);
    })

    it('reverts on trying to submit the discarded report', async () => {
      await expect(oracle.connect(member1).submitReportData(
        reportFields, oracleVersion
      )).to.be.revertedWithCustomError(oracle, 'UnexpectedDataHash');
    })
  })

  context('submitReportData', () => {
    beforeEach(takeSnapshot);
    afterEach(rollback);

    context('checks contract version', () => {
      it('should revert if incorrect contract version', async () => {
        await consensus.setTime(deadline);

        const incorrectNextVersion = oracleVersion + 1n;
        const incorrectPrevVersion = oracleVersion - 1n;

        await expect(oracle.connect(member1).submitReportData(
          reportFields, incorrectNextVersion
        )).to.be.revertedWithCustomError(oracle, 'UnexpectedContractVersion').withArgs(oracleVersion, incorrectNextVersion);

        await expect(oracle.connect(member1).submitReportData(
          reportFields, incorrectPrevVersion
        )).to.be.revertedWithCustomError(oracle, 'UnexpectedContractVersion').withArgs(oracleVersion, incorrectPrevVersion);
      })

      it('should should allow calling if correct contract version', async () => {
        await consensus.setTime(deadline);

        const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        await expect(tx).to.emit(oracle, 'ProcessingStarted').withArgs(reportFields.refSlot, anyValue);
      })
    })

    context('checks ref slot', () => {
      it('should revert if incorrect ref slot', async () => {
        await consensus.setTime(deadline);
        const { refSlot } = await consensus.getCurrentFrame();

        const incorrectRefSlot = refSlot + 1n;

        const newReportFields = {
          ...reportFields,
          refSlot: incorrectRefSlot,
        }

        await expect(oracle.connect(member1).submitReportData(
          newReportFields, oracleVersion
        )).to.be.revertedWithCustomError(oracle, 'UnexpectedRefSlot').withArgs(refSlot, incorrectRefSlot);
      })

      it('should should allow calling if correct ref slot', async () => {
        await consensus.setTime(deadline);
        const { newReportFields } = await prepareNextReportInNextFrame({ ...reportFields });
        const tx = await oracle.connect(member1).submitReportData(newReportFields, oracleVersion);
        await expect(tx).to.emit(oracle, 'ProcessingStarted').withArgs(newReportFields.refSlot, anyValue);
      })
    })

    context('only allows submitting main data for the same ref. slot once', () => {
      it('reverts on trying to submit the second time', async () => {
        const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        await expect(tx).to.emit(oracle, 'ProcessingStarted').withArgs(reportFields.refSlot, anyValue);
        await expect(oracle.connect(member1).submitReportData(
          reportFields, oracleVersion
        )).to.be.revertedWithCustomError(oracle, 'RefSlotAlreadyProcessing');
      })
    })

    context('checks consensus version', () => {
      it('should revert if incorrect consensus version', async () => {
        await consensus.setTime(deadline);

        const incorrectNextVersion = CONSENSUS_VERSION + 1;
        const incorrectPrevVersion = CONSENSUS_VERSION + 1;

        const newReportFields = {
          ...reportFields,
          consensusVersion: incorrectNextVersion,
        }

        const reportFieldsPrevVersion = { ...reportFields, consensusVersion: incorrectPrevVersion }

        await expect(oracle.connect(member1).submitReportData(
          newReportFields, oracleVersion
        )).to.be.revertedWithCustomError(oracle, 'UnexpectedConsensusVersion').withArgs(oracleVersion, incorrectNextVersion);

        await expect(oracle.connect(member1).submitReportData(
          reportFieldsPrevVersion, oracleVersion
        )).to.be.revertedWithCustomError(oracle, 'UnexpectedConsensusVersion').withArgs(oracleVersion, incorrectPrevVersion);
      })

      it('should allow calling if correct consensus version', async () => {
        await consensus.setTime(deadline);
        const { refSlot } = await consensus.getCurrentFrame();

        const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        await expect(tx).to.emit(oracle, 'ProcessingStarted').withArgs(refSlot, anyValue);

        const newConsensusVersion = CONSENSUS_VERSION + 1;
        const nextRefSlot = Number(refSlot) + SLOTS_PER_FRAME;
        const newReportFields = {
          ...reportFields,
          refSlot: nextRefSlot,
          consensusVersion: newConsensusVersion,
        };
        const newReportItems = getReportDataItems(newReportFields)
        const newReportHash = calcReportDataHash(newReportItems)

        await oracle.connect(admin).setConsensusVersion(newConsensusVersion);
        await consensus.advanceTimeToNextFrameStart();
        await consensus.connect(member1).submitReport(newReportFields.refSlot, newReportHash, newConsensusVersion);

        const txNewVersion = await oracle.connect(member1).submitReportData(newReportFields, oracleVersion);
        await expect(txNewVersion).to.emit(oracle, 'ProcessingStarted').withArgs(newReportFields.refSlot, anyValue);
      })
    })

    context('enforces module ids sorting order', () => {
      beforeEach(deploy);

      it('should revert if incorrect stakingModuleIdsWithNewlyExitedValidators order (when next number in list is less than previous)', async () => {
        const { newReportFields } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [2, 1],
          numExitedValidatorsByStakingModule: [3, 4],
        });

        await expect(oracle.connect(member1).submitReportData(
          newReportFields, oracleVersion
        )).to.be.revertedWithCustomError(oracle, 'InvalidExitedValidatorsData');
      })

      it('should revert if incorrect stakingModuleIdsWithNewlyExitedValidators order (when next number in list equals to previous)', async () => {
        const { newReportFields } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [1, 1],
          numExitedValidatorsByStakingModule: [3, 4],
        })

        await expect(oracle.connect(member1).submitReportData(
          newReportFields, oracleVersion
        )).to.be.revertedWithCustomError(oracle, 'InvalidExitedValidatorsData');
      })

      it('should should allow calling if correct extra data list moduleId', async () => {
        const { newReportFields } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [1, 2],
          numExitedValidatorsByStakingModule: [3, 4],
        })

        const tx = await oracle.connect(member1).submitReportData(newReportFields, oracleVersion);
        await expect(tx).to.emit(oracle, 'ProcessingStarted').withArgs(newReportFields.refSlot, anyValue);
      })
    })

    context('checks data hash', () => {
      it('reverts with UnexpectedDataHash', async () => {
        const incorrectReportFields = {
          ...reportFields,
          numValidators: Number(reportFields.numValidators) - 1,
        };
        const incorrectReportItems = getReportDataItems(incorrectReportFields);

        const correctDataHash = calcReportDataHash(reportItems);
        const incorrectDataHash = calcReportDataHash(incorrectReportItems);
        console.log('dataHash', correctDataHash, incorrectDataHash);

        await oracle.connect(member1).submitReportData(
          incorrectReportFields, oracleVersion
        );
        // await expect(oracle.connect(member1).submitReportData(
        //   incorrectReportFields, oracleVersion
        // )).to.be.revertedWithCustomError(oracle, 'UnexpectedDataHash').withArgs(correctDataHash, incorrectDataHash);
        // await assert.reverts(
        //   oracle.submitReportData(incorrectReportItems, oracleVersion, { from: member1 }),
        //   `UnexpectedDataHash("${correctDataHash}", "${incorrectDataHash}")`
        // )
      })

      // it('submits if data successfully pass hash validation', async () => {
      //   const tx = await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
      //   assert.emits(tx, 'ProcessingStarted', { refSlot: reportFields.refSlot })
      // })
    })

  //   context('enforces data safety boundaries', () => {
  //     it('reverts with MaxAccountingExtraDataItemsCountExceeded if data limit exceeds', async () => {
  //       const MAX_ACCOUNTING_EXTRA_DATA_LIMIT = 1
  //       await oracleReportSanityChecker.setMaxAccountingExtraDataListItemsCount(MAX_ACCOUNTING_EXTRA_DATA_LIMIT, {
  //         from: admin,
  //       })

  //       assert.equals(
  //         (await oracleReportSanityChecker.getOracleReportLimits()).maxAccountingExtraDataListItemsCount,
  //         MAX_ACCOUNTING_EXTRA_DATA_LIMIT
  //       )

  //       await assert.reverts(
  //         oracle.submitReportData(reportItems, oracleVersion, { from: member1 }),
  //         `MaxAccountingExtraDataItemsCountExceeded(${MAX_ACCOUNTING_EXTRA_DATA_LIMIT}, ${reportFields.extraDataItemsCount})`
  //       )
  //     })

  //     it('passes fine on borderline data limit value — when it equals to count of passed items', async () => {
  //       const MAX_ACCOUNTING_EXTRA_DATA_LIMIT = reportFields.extraDataItemsCount

  //       await oracleReportSanityChecker.setMaxAccountingExtraDataListItemsCount(MAX_ACCOUNTING_EXTRA_DATA_LIMIT, {
  //         from: admin,
  //       })

  //       assert.equals(
  //         (await oracleReportSanityChecker.getOracleReportLimits()).maxAccountingExtraDataListItemsCount,
  //         MAX_ACCOUNTING_EXTRA_DATA_LIMIT
  //       )

  //       await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
  //     })

  //     it('reverts with InvalidExitedValidatorsData if counts of stakingModuleIds and numExitedValidatorsByStakingModule does not match', async () => {
  //       const { newReportItems } = await prepareNextReportInNextFrame({
  //         ...reportFields,
  //         stakingModuleIdsWithNewlyExitedValidators: [1, 2],
  //         numExitedValidatorsByStakingModule: [3],
  //       })
  //       await assert.reverts(
  //         oracle.submitReportData(newReportItems, oracleVersion, { from: member1 }),
  //         'InvalidExitedValidatorsData()'
  //       )
  //     })

  //     it('reverts with InvalidExitedValidatorsData if any record for number of exited validators equals 0', async () => {
  //       const { newReportItems } = await prepareNextReportInNextFrame({
  //         ...reportFields,
  //         stakingModuleIdsWithNewlyExitedValidators: [1, 2],
  //         numExitedValidatorsByStakingModule: [3, 0],
  //       })
  //       await assert.reverts(
  //         oracle.submitReportData(newReportItems, oracleVersion, { from: member1 }),
  //         'InvalidExitedValidatorsData()'
  //       )
  //     })

  //     it('reverts with ExitedValidatorsLimitExceeded if exited validators rate limit will be reached', async () => {
  //       // Really simple test here for now
  //       // TODO: Come up with more tests for better coverage of edge-case scenarios that can be accrued
  //       //       during calculation `exitedValidatorsPerDay` rate in AccountingOracle:612
  //       const totalExitedValidators = reportFields.numExitedValidatorsByStakingModule.reduce(
  //         (sum, curr) => sum + curr,
  //         0
  //       )
  //       const exitingRateLimit = totalExitedValidators - 1
  //       await oracleReportSanityChecker.setChurnValidatorsPerDayLimit(exitingRateLimit)
  //       assert.equals(
  //         (await oracleReportSanityChecker.getOracleReportLimits()).churnValidatorsPerDayLimit,
  //         exitingRateLimit
  //       )
  //       await assert.reverts(
  //         oracle.submitReportData(reportItems, oracleVersion, { from: member1 }),
  //         `ExitedValidatorsLimitExceeded(${exitingRateLimit}, ${totalExitedValidators})`
  //       )
  //     })
    })

  //   context('delivers the data to corresponded contracts', () => {
  //     it('should call handleOracleReport on Lido', async () => {
  //       assert.equals((await mockLido.getLastCall_handleOracleReport()).callCount, 0)
  //       await consensus.setTime(deadline)
  //       const tx = await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
  //       assert.emits(tx, 'ProcessingStarted', { refSlot: reportFields.refSlot })

  //       const lastOracleReportToLido = await mockLido.getLastCall_handleOracleReport()

  //       assert.equals(lastOracleReportToLido.callCount, 1)
  //       assert.equals(
  //         lastOracleReportToLido.currentReportTimestamp,
  //         GENESIS_TIME + reportFields.refSlot * SECONDS_PER_SLOT
  //       )

  //       assert.equals(lastOracleReportToLido.clBalance, reportFields.clBalanceGwei + '000000000')
  //       assert.equals(lastOracleReportToLido.withdrawalVaultBalance, reportFields.withdrawalVaultBalance)
  //       assert.equals(lastOracleReportToLido.elRewardsVaultBalance, reportFields.elRewardsVaultBalance)
  //       assert.sameOrderedMembers(
  //         toNum(lastOracleReportToLido.withdrawalFinalizationBatches),
  //         toNum(reportFields.withdrawalFinalizationBatches)
  //       )
  //       assert.equals(lastOracleReportToLido.simulatedShareRate, reportFields.simulatedShareRate)
  //     })

  //     it('should call updateExitedValidatorsCountByStakingModule on StakingRouter', async () => {
  //       assert.equals((await mockStakingRouter.lastCall_updateExitedKeysByModule()).callCount, 0)
  //       await consensus.setTime(deadline)
  //       const tx = await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
  //       assert.emits(tx, 'ProcessingStarted', { refSlot: reportFields.refSlot })

  //       const lastOracleReportToStakingRouter = await mockStakingRouter.lastCall_updateExitedKeysByModule()

  //       assert.equals(lastOracleReportToStakingRouter.callCount, 1)
  //       assert.equals(lastOracleReportToStakingRouter.moduleIds, reportFields.stakingModuleIdsWithNewlyExitedValidators)
  //       assert.equals(lastOracleReportToStakingRouter.exitedKeysCounts, reportFields.numExitedValidatorsByStakingModule)
  //     })

  //     it('does not calling StakingRouter.updateExitedKeysByModule if lists of exited validators is empty', async () => {
  //       const { newReportItems, newReportFields } = await prepareNextReportInNextFrame({
  //         ...reportFields,
  //         stakingModuleIdsWithNewlyExitedValidators: [],
  //         numExitedValidatorsByStakingModule: [],
  //       })
  //       const tx = await oracle.submitReportData(newReportItems, oracleVersion, { from: member1 })
  //       assert.emits(tx, 'ProcessingStarted', { refSlot: newReportFields.refSlot })
  //       const lastOracleReportToStakingRouter = await mockStakingRouter.lastCall_updateExitedKeysByModule()
  //       assert.equals(lastOracleReportToStakingRouter.callCount, 0)
  //     })

  //     it('should call handleConsensusLayerReport on legacyOracle', async () => {
  //       await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
  //       const lastCall = await mockLegacyOracle.lastCall__handleConsensusLayerReport()
  //       assert.equals(lastCall.totalCalls, 1)
  //       assert.equals(lastCall.refSlot, reportFields.refSlot)
  //       assert.equals(lastCall.clBalance, e9(reportFields.clBalanceGwei))
  //       assert.equals(lastCall.clValidators, reportFields.numValidators)
  //     })

  //     it('should call onOracleReport on WithdrawalQueue', async () => {
  //       const prevProcessingRefSlot = +(await oracle.getLastProcessingRefSlot())
  //       await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
  //       const currentProcessingRefSlot = +(await oracle.getLastProcessingRefSlot())
  //       const lastCall = await mockWithdrawalQueue.lastCall__onOracleReport()
  //       assert.equals(lastCall.callCount, 1)
  //       assert.equals(lastCall.isBunkerMode, reportFields.isBunkerMode)
  //       assert.equals(lastCall.prevReportTimestamp, GENESIS_TIME + prevProcessingRefSlot * SECONDS_PER_SLOT)
  //       assert.equals(lastCall.currentReportTimestamp, GENESIS_TIME + currentProcessingRefSlot * SECONDS_PER_SLOT)
  //     })
  //   })

  //   context('warns when prev extra data has not been processed yet', () => {
  //     it('emits WarnExtraDataIncompleteProcessing', async () => {
  //       await consensus.setTime(deadline)
  //       const prevRefSlot = +(await consensus.getCurrentFrame()).refSlot
  //       await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
  //       await consensus.advanceTimeToNextFrameStart()
  //       const nextRefSlot = +(await consensus.getCurrentFrame()).refSlot
  //       const tx = await consensus.submitReport(nextRefSlot, HASH_1, CONSENSUS_VERSION, { from: member1 })
  //       assert.emits(
  //         tx,
  //         'WarnExtraDataIncompleteProcessing',
  //         {
  //           refSlot: prevRefSlot,
  //           processedItemsCount: 0,
  //           itemsCount: extraDataItems.length,
  //         },
  //         { abi: AccountingOracleAbi }
  //       )
  //     })
  //   })

  //   context('enforces extra data format', () => {
  //     it('should revert on invalid extra data format', async () => {
  //       await consensus.setTime(deadline)
  //       await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })

  //       const nextRefSlot = reportFields.refSlot + SLOTS_PER_FRAME
  //       const changedReportItems = getAccountingReportDataItems({
  //         ...reportFields,
  //         refSlot: nextRefSlot,
  //         extraDataFormat: EXTRA_DATA_FORMAT_LIST + 1,
  //       })

  //       const changedReportHash = calcAccountingReportDataHash(changedReportItems)
  //       await consensus.advanceTimeToNextFrameStart()
  //       await consensus.submitReport(nextRefSlot, changedReportHash, CONSENSUS_VERSION, {
  //         from: member1,
  //       })

  //       await assert.revertsWithCustomError(
  //         oracle.submitReportData(changedReportItems, oracleVersion, { from: member1 }),
  //         `UnsupportedExtraDataFormat(${EXTRA_DATA_FORMAT_LIST + 1})`
  //       )
  //     })

  //     it('should revert on non-empty format but zero length', async () => {
  //       await consensus.setTime(deadline)
  //       const { refSlot } = await consensus.getCurrentFrame()
  //       const reportFields = getReportFields({
  //         refSlot: +refSlot,
  //         extraDataItemsCount: 0,
  //       })
  //       const reportItems = getAccountingReportDataItems(reportFields)
  //       const reportHash = calcAccountingReportDataHash(reportItems)
  //       await consensus.submitReport(refSlot, reportHash, CONSENSUS_VERSION, { from: member1 })
  //       await assert.revertsWithCustomError(
  //         oracle.submitReportData(reportItems, oracleVersion, { from: member1 }),
  //         `ExtraDataItemsCountCannotBeZeroForNonEmptyData()`
  //       )
  //     })

  //     it('should revert on non-empty format but zero hash', async () => {
  //       await consensus.setTime(deadline)
  //       const { refSlot } = await consensus.getCurrentFrame()
  //       const reportFields = getReportFields({
  //         refSlot: +refSlot,
  //         extraDataHash: ZERO_HASH,
  //       })
  //       const reportItems = getAccountingReportDataItems(reportFields)
  //       const reportHash = calcAccountingReportDataHash(reportItems)
  //       await consensus.submitReport(refSlot, reportHash, CONSENSUS_VERSION, { from: member1 })
  //       await assert.revertsWithCustomError(
  //         oracle.submitReportData(reportItems, oracleVersion, { from: member1 }),
  //         `ExtraDataHashCannotBeZeroForNonEmptyData()`
  //       )
  //     })
  //   })

  //   context('enforces zero extraData fields for the empty format', () => {
  //     it('should revert for non empty ExtraDataHash', async () => {
  //       await consensus.setTime(deadline)
  //       const { refSlot } = await consensus.getCurrentFrame()
  //       const nonZeroHash = web3.utils.keccak256('nonZeroHash')
  //       const reportFields = getReportFields({
  //         refSlot: +refSlot,
  //         isBunkerMode: false,
  //         extraDataFormat: EXTRA_DATA_FORMAT_EMPTY,
  //         extraDataHash: nonZeroHash,
  //         extraDataItemsCount: 0,
  //       })
  //       const reportItems = getAccountingReportDataItems(reportFields)
  //       const reportHash = calcAccountingReportDataHash(reportItems)
  //       await consensus.submitReport(refSlot, reportHash, CONSENSUS_VERSION, { from: member1 })
  //       await assert.revertsWithCustomError(
  //         oracle.submitReportData(reportItems, oracleVersion, { from: member1 }),
  //         `UnexpectedExtraDataHash("${ZERO_HASH}", "${nonZeroHash}")`
  //       )
  //     })

  //     it('should revert for non zero ExtraDataLength', async () => {
  //       await consensus.setTime(deadline)
  //       const { refSlot } = await consensus.getCurrentFrame()
  //       const reportFields = getReportFields({
  //         refSlot: +refSlot,
  //         isBunkerMode: false,
  //         extraDataFormat: EXTRA_DATA_FORMAT_EMPTY,
  //         extraDataHash: ZERO_HASH,
  //         extraDataItemsCount: 10,
  //       })
  //       const reportItems = getAccountingReportDataItems(reportFields)
  //       const reportHash = calcAccountingReportDataHash(reportItems)
  //       await consensus.submitReport(refSlot, reportHash, CONSENSUS_VERSION, { from: member1 })
  //       await assert.revertsWithCustomError(
  //         oracle.submitReportData(reportItems, oracleVersion, { from: member1 }),
  //         `UnexpectedExtraDataItemsCount(0, 10)`
  //       )
  //     })
  //   })

  //   context('ExtraDataProcessingState', () => {
  //     it('should be empty from start', async () => {
  //       const data = await oracle.getExtraDataProcessingState()
  //       assert.equals(data.refSlot, '0')
  //       assert.equals(data.dataFormat, '0')
  //       assert.equals(data.itemsCount, '0')
  //       assert.equals(data.itemsProcessed, '0')
  //       assert.equals(data.lastSortingKey, '0')
  //       assert.equals(data.dataHash, ZERO_HASH)
  //     })

  //     it('should be filled with report data after submitting', async () => {
  //       await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
  //       const data = await oracle.getExtraDataProcessingState()
  //       assert.equals(data.refSlot, reportFields.refSlot)
  //       assert.equals(data.dataFormat, reportFields.extraDataFormat)
  //       assert.equals(data.itemsCount, reportFields.extraDataItemsCount)
  //       assert.equals(data.itemsProcessed, '0')
  //       assert.equals(data.lastSortingKey, '0')
  //       assert.equals(data.dataHash, reportFields.extraDataHash)
  //     })
  //   })
  // })
})
