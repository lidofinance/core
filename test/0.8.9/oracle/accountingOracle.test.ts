import { expect } from 'chai';
import { ethers } from 'hardhat';
import { HardhatEthersHelpers } from 'hardhat/types';

import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

import { AccountingOracle, HashConsensusTimeTravellable, LegacyOracle } from 'typechain-types';

import { ether, hex, streccak } from 'lib';

import {
  deployLocatorWithDummyAddressesImplementation,
  updateLocatorImplementation,
}  from '../../../lib/locator-deploy';

// const { calcAccountingReportDataHash, getAccountingReportDataItems } = require('../../helpers/reportData')
import {
  computeEpochAt,
  computeEpochFirstSlot,
  computeEpochFirstSlotAt,
  computeSlotAt,
  computeTimestampAtSlot,
  CONSENSUS_VERSION,
  EPOCHS_PER_FRAME,
  GENESIS_TIME,
  HASH_1,
  HASH_2,
  HASH_3,
  SECONDS_PER_EPOCH,
  SECONDS_PER_SLOT,
  SLOTS_PER_EPOCH,
  SLOTS_PER_FRAME,
  ZERO_HASH,
} from './baseOracle';
import { deployHashConsensus } from './hashConsensus';

// const AccountingOracle = artifacts.require('AccountingOracleTimeTravellable')
// const MockLido = artifacts.require('MockLidoForAccountingOracle')
// const MockStakingRouter = artifacts.require('MockStakingRouterForAccountingOracle')
// const MockWithdrawalQueue = artifacts.require('MockWithdrawalQueueForAccountingOracle')
// const MockLegacyOracle = artifacts.require('MockLegacyOracle')

const V1_ORACLE_LAST_COMPLETED_EPOCH = 2 * EPOCHS_PER_FRAME;
const V1_ORACLE_LAST_REPORT_SLOT = V1_ORACLE_LAST_COMPLETED_EPOCH * SLOTS_PER_EPOCH;

const EXTRA_DATA_FORMAT_EMPTY = 0;
const EXTRA_DATA_FORMAT_LIST = 1;

const EXTRA_DATA_TYPE_STUCK_VALIDATORS = 1;
const EXTRA_DATA_TYPE_EXITED_VALIDATORS = 2;

function encodeExtraDataItem(
  itemIndex: number,
  itemType: number,
  moduleId: number,
  nodeOperatorIds: number[],
  keysCounts: number[]) {
  const itemHeader = hex(itemIndex, 3) + hex(itemType, 2);
  const payloadHeader = hex(moduleId, 3) + hex(nodeOperatorIds.length, 8);
  const operatorIdsPayload = nodeOperatorIds.map((id) => hex(id, 8)).join('');
  const keysCountsPayload = keysCounts.map((count) => hex(count, 16)).join('');
  return '0x' + itemHeader + payloadHeader + operatorIdsPayload + keysCountsPayload;
}

// extraData = {
//   stuckKeys: [
//     { moduleId: 1, nodeOpIds: [0], keysCounts: [1] },
//     { moduleId: 2, nodeOpIds: [0], keysCounts: [2] },
//     { moduleId: 3, nodeOpIds: [2], keysCounts: [3] },
//   ],
//   exitedKeys: [
//     { moduleId: 2, nodeOpIds: [1, 2], keysCounts: [1, 3] },
//     { moduleId: 3, nodeOpIds: [1], keysCounts: [2] },
//   ],
// }

type KeyType = { moduleId: number; nodeOpIds: number[]; keysCounts: number[] };
type ExtraDataType = { stuckKeys: KeyType[]; exitedKeys: KeyType[] };

export function encodeExtraDataItems(data: ExtraDataType) {
  const items: string[] = [];
  const encodeItem = (item: KeyType, type: number) =>
    encodeExtraDataItem(items.length, type, item.moduleId, item.nodeOpIds, item.keysCounts)
  data.stuckKeys.forEach((item: KeyType) => items.push(encodeItem(item, EXTRA_DATA_TYPE_STUCK_VALIDATORS)))
  data.exitedKeys.forEach((item: KeyType) => items.push(encodeItem(item, EXTRA_DATA_TYPE_EXITED_VALIDATORS)))
  return items
}

export function packExtraDataList(extraDataItems: string[]) {
  return '0x' + extraDataItems.map((s) => s.substring(2)).join('');
}

export function calcExtraDataListHash(packedExtraDataList: string) {
  return streccak(packedExtraDataList);
}

async function deployMockLegacyOracle({
  epochsPerFrame = EPOCHS_PER_FRAME,
  slotsPerEpoch = SLOTS_PER_EPOCH,
  secondsPerSlot = SECONDS_PER_SLOT,
  genesisTime = GENESIS_TIME,
  lastCompletedEpochId = V1_ORACLE_LAST_COMPLETED_EPOCH,
} = {}) {
  const legacyOracle = await ethers.deployContract('MockLegacyOracle');
  await legacyOracle.setParams(epochsPerFrame, slotsPerEpoch, secondsPerSlot, genesisTime, lastCompletedEpochId);
  return legacyOracle;
}

async function deployMockLidoAndStakingRouter() {
  const stakingRouter = await ethers.deployContract('MockStakingRouterForAccountingOracle');
  const withdrawalQueue = await ethers.deployContract('MockWithdrawalQueueForAccountingOracle');
  const lido = await ethers.deployContract('MockLidoForAccountingOracle');
  return { lido, stakingRouter, withdrawalQueue };
}

async function deployAccountingOracleSetup(
  admin: string,
  {
    initialEpoch = null as number | null,
    epochsPerFrame = EPOCHS_PER_FRAME,
    slotsPerEpoch = SLOTS_PER_EPOCH,
    secondsPerSlot = SECONDS_PER_SLOT,
    genesisTime = GENESIS_TIME,
    getLidoAndStakingRouter = deployMockLidoAndStakingRouter,
    getLegacyOracle = deployMockLegacyOracle,
    lidoLocatorAddr = null as string | null,
    legacyOracleAddr = null as string | null,
    lidoAddr = null as string | null,
  } = {}
) {
  const locatorAddr = await (await deployLocatorWithDummyAddressesImplementation(admin)).getAddress();
  const { lido, stakingRouter, withdrawalQueue } = await getLidoAndStakingRouter();
  const oracleReportSanityChecker = await deployOracleReportSanityCheckerForAccounting(locatorAddr, admin);

  const legacyOracle = await getLegacyOracle();

  if (initialEpoch == null) {
    initialEpoch = Number(await legacyOracle.getLastCompletedEpochId() + BigInt(epochsPerFrame));
  }

  const oracle = await ethers.deployContract('AccountingOracle', [
    lidoLocatorAddr || locatorAddr,
    lidoAddr || await lido.getAddress(),
    legacyOracleAddr || await legacyOracle.getAddress(),
    secondsPerSlot,
    genesisTime
  ]);

  const { consensus } = await deployHashConsensus(admin, {
    reportProcessor: oracle,
    epochsPerFrame,
    slotsPerEpoch,
    secondsPerSlot,
    genesisTime,
    initialEpoch,
  });
  await updateLocatorImplementation(locatorAddr, admin, {
    lido: lidoAddr || await lido.getAddress(),
    stakingRouter: await stakingRouter.getAddress(),
    withdrawalQueue: await withdrawalQueue.getAddress(),
    oracleReportSanityChecker: await oracleReportSanityChecker.getAddress(),
    accountingOracle: await oracle.getAddress(),
  });

  // pretend we're at the first slot of the initial frame's epoch
  await consensus.setTime(genesisTime + initialEpoch * slotsPerEpoch * secondsPerSlot);

  return {
    lido,
    stakingRouter,
    withdrawalQueue,
    locatorAddr,
    legacyOracle,
    oracle,
    consensus,
    oracleReportSanityChecker,
  }
}

interface AccountingOracleConfig {
  admin: string;
  oracle: AccountingOracle;
  consensus: HashConsensusTimeTravellable;
  dataSubmitter?: string;
  consensusVersion?: number;
  shouldMigrateLegacyOracle?: boolean;
  lastProcessingRefSlot?: number;
};

async function initAccountingOracle({
  admin,
  oracle,
  consensus,
  dataSubmitter = undefined,
  consensusVersion = CONSENSUS_VERSION,
  shouldMigrateLegacyOracle = true,
  lastProcessingRefSlot = 0,
}: AccountingOracleConfig) {
  let initTx;
  if (shouldMigrateLegacyOracle)
    initTx = await oracle.initialize(admin, await consensus.getAddress(), consensusVersion);
  else
    initTx = await oracle.initializeWithoutMigration(
      admin,
      await consensus.getAddress(),
      consensusVersion,
      lastProcessingRefSlot
    );

  await oracle.grantRole(await oracle.MANAGE_CONSENSUS_CONTRACT_ROLE(), admin);
  await oracle.grantRole(await oracle.MANAGE_CONSENSUS_VERSION_ROLE(), admin);

  if (dataSubmitter) {
    await oracle.grantRole(await oracle.SUBMIT_DATA_ROLE(), dataSubmitter);
  }

  expect(await oracle.EXTRA_DATA_FORMAT_EMPTY()).to.be.equal(EXTRA_DATA_FORMAT_EMPTY);
  expect(await oracle.EXTRA_DATA_FORMAT_LIST()).to.be.equal(EXTRA_DATA_FORMAT_LIST);
  expect(await oracle.EXTRA_DATA_TYPE_STUCK_VALIDATORS()).to.be.equal(EXTRA_DATA_TYPE_STUCK_VALIDATORS);
  expect(await oracle.EXTRA_DATA_TYPE_EXITED_VALIDATORS()).to.be.equal(EXTRA_DATA_TYPE_EXITED_VALIDATORS);

  return initTx;
}

async function deployOracleReportSanityCheckerForAccounting(lidoLocator: string, admin: string) {
  const churnValidatorsPerDayLimit = 100;
  const limitsList = [churnValidatorsPerDayLimit, 0, 0, 0, 32 * 12, 15, 16, 0, 0];
  const managersRoster = [[admin], [admin], [admin], [admin], [admin], [admin], [admin], [admin], [admin], [admin]];

  const oracleReportSanityChecker = await ethers.deployContract('OracleReportSanityChecker', [
    lidoLocator,
    admin,
    limitsList,
    managersRoster
  ]);
  return oracleReportSanityChecker;
}

interface AccountingOracleSetup {
  admin: string;
  consensus: HashConsensusTimeTravellable;
  oracle: AccountingOracle;
  legacyOracle: LegacyOracle;
  dataSubmitter?: string;
  consensusVersion?: number;
};

async function configureAccountingOracleSetup({
  admin,
  consensus,
  oracle,
  legacyOracle,
  dataSubmitter = undefined,
  consensusVersion = CONSENSUS_VERSION,
}: AccountingOracleSetup) {
  // this is done as a part of the protocol upgrade voting execution

  const frameConfig = await consensus.getFrameConfig();
  // TODO: Double check it
  await consensus.setTimeInEpochs(await legacyOracle.getLastCompletedEpochId())

  const initialEpoch = (await legacyOracle.getLastCompletedEpochId()) + frameConfig.epochsPerFrame;

  const updateInitialEpochIx = await consensus.updateInitialEpoch(initialEpoch);
  const initTx = await initAccountingOracle({ admin, oracle, consensus, dataSubmitter, consensusVersion })

  return { updateInitialEpochIx, initTx };
}

async function deployAndConfigureAccountingOracle(admin: string) {
  /// this is done (far) before the protocol upgrade voting initiation:
  ///   1. deploy HashConsensus
  ///   2. deploy AccountingOracle impl
  const deployed = await deployAccountingOracleSetup(admin);

  // pretend we're after the legacy oracle's last proc epoch but before the new oracle's initial epoch
  expect(EPOCHS_PER_FRAME).to.be.greaterThan(1);
  const voteExecTime = GENESIS_TIME + (V1_ORACLE_LAST_COMPLETED_EPOCH + 1) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
  await deployed.consensus.setTime(voteExecTime);

  /// this is done as a part of the protocol upgrade voting execution:
  ///   1. calculate HashConsensus initial epoch as the last finalized legacy epoch + frame size
  ///   2. set HashConsensus initial epoch
  ///   3. deploy AccountingOracle proxy (skipped in these tests as they're not testing the proxy setup)
  ///   4. initialize AccountingOracle
  const finalizeResult = await configureAccountingOracleSetup({ admin, ...deployed });

  // pretend we're at the first slot of the new oracle's initial epoch
  const initialEpoch = V1_ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME;
  await deployed.consensus.setTime(GENESIS_TIME + initialEpoch * SLOTS_PER_EPOCH * SECONDS_PER_SLOT);

  return { ...deployed, ...finalizeResult };
}

export async function getInitialFrameStartTime(consensus: HashConsensusTimeTravellable) {
  const chainConfig = await consensus.getChainConfig();
  const frameConfig = await consensus.getFrameConfig();
  return BigInt(frameConfig.initialEpoch) * chainConfig.slotsPerEpoch *
    chainConfig.secondsPerSlot + BigInt(chainConfig.genesisTime);
}


describe('AccountingOracle.sol', () => {
  // let consensus;
  // let oracle;
  // let mockLido;
  // let mockStakingRouter;
  // let mockWithdrawalQueue;
  // let legacyOracle;

  context('Deployment and initial configuration', () => {
    let admin: HardhatEthersSigner;
    let member1: HardhatEthersSigner;

    before(async () => {
      [admin, member1] = await ethers.getSigners();

    });
    const updateInitialEpoch = async (consensus: HashConsensusTimeTravellable) => {
      // pretend we're after the legacy oracle's last proc epoch but before the new oracle's initial epoch
      const voteExecTime = GENESIS_TIME + (V1_ORACLE_LAST_COMPLETED_EPOCH + 1) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT
      await consensus.setTime(voteExecTime)
      await consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME)
    }

    it('init fails if the chain config is different from the one of the legacy oracle', async () => {
      let deployed = await deployAccountingOracleSetup(admin.address, {
        getLegacyOracle: () => deployMockLegacyOracle({ slotsPerEpoch: SLOTS_PER_EPOCH + 1 }),
      })
      await updateInitialEpoch(deployed.consensus);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed })).to.be.revertedWithCustomError(
        deployed.oracle,
        'IncorrectOracleMigration'
      ).withArgs(0);

      deployed = await deployAccountingOracleSetup(admin.address, {
        getLegacyOracle: () => deployMockLegacyOracle({ secondsPerSlot: SECONDS_PER_SLOT + 1 }),
      });
      await updateInitialEpoch(deployed.consensus);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed })).to.be.revertedWithCustomError(
        deployed.oracle,
        'IncorrectOracleMigration'
      ).withArgs(0);

      deployed = await deployAccountingOracleSetup(admin.address, {
        getLegacyOracle: () => deployMockLegacyOracle({ genesisTime: GENESIS_TIME + 1 }),
      });
      await updateInitialEpoch(deployed.consensus);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed })).to.be.revertedWithCustomError(
        deployed.oracle,
        'IncorrectOracleMigration'
      ).withArgs(0);
    })

    // it('init fails if the frame size is different from the one of the legacy oracle', async () => {
    //   const deployed = await deployAccountingOracleSetup(admin, {
    //     getLegacyOracle: () => deployMockLegacyOracle({ epochsPerFrame: EPOCHS_PER_FRAME - 1 }),
    //   })
    //   await updateInitialEpoch(deployed.consensus)
    //   await assert.reverts(initAccountingOracle({ admin, ...deployed }), 'IncorrectOracleMigration(1)')
    // })

    // it(`init fails if the initial epoch of the new oracle is not the next frame's first epoch`, async () => {
    //   const deployed = await deployAccountingOracleSetup(admin)

    //   const voteExecTime = GENESIS_TIME + (V1_ORACLE_LAST_COMPLETED_EPOCH + 1) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT
    //   await deployed.consensus.setTime(voteExecTime)

    //   const snapshot = new EvmSnapshot(ethers.provider)
    //   await snapshot.make()

    //   await deployed.consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME - 1)
    //   await assert.reverts(initAccountingOracle({ admin, ...deployed }), 'IncorrectOracleMigration(2)')
    //   await snapshot.rollback()

    //   await deployed.consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME + 1)
    //   await assert.reverts(initAccountingOracle({ admin, ...deployed }), 'IncorrectOracleMigration(2)')
    //   await snapshot.rollback()

    //   await deployed.consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + 2 * EPOCHS_PER_FRAME)
    //   await assert.reverts(initAccountingOracle({ admin, ...deployed }), 'IncorrectOracleMigration(2)')
    //   await snapshot.rollback()
    // })

    // it('reverts when slotsPerSecond is zero', async () => {
    //   await assert.reverts(deployAccountingOracleSetup(admin, { secondsPerSlot: 0 }), 'SecondsPerSlotCannotBeZero()')
    // })

    // it('deployment and init finishes successfully otherwise', async () => {
    //   const deployed = await deployAccountingOracleSetup(admin)

    //   const voteExecTime = GENESIS_TIME + (V1_ORACLE_LAST_COMPLETED_EPOCH + 1) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT
    //   await deployed.consensus.setTime(voteExecTime)
    //   await deployed.consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME)

    //   await initAccountingOracle({ admin, ...deployed })

    //   const refSlot = await deployed.oracle.getLastProcessingRefSlot()
    //   const epoch = await deployed.legacyOracle.getLastCompletedEpochId()
    //   assert.equals(refSlot, epoch.muln(SLOTS_PER_EPOCH))
    // })

    // it('deployment and init finishes successfully (default setup)', async () => {
    //   const deployed = await deployAndConfigureAccountingOracle(admin)
    //   consensus = deployed.consensus
    //   oracle = deployed.oracle
    //   mockLido = deployed.lido
    //   mockStakingRouter = deployed.stakingRouter
    //   mockWithdrawalQueue = deployed.withdrawalQueue
    //   legacyOracle = deployed.legacyOracle
    // })

    // it('mock setup is correct', async () => {
    //   // check the mock time-travellable setup
    //   const time1 = +(await consensus.getTime())
    //   assert.equals(await oracle.getTime(), time1)

    //   await consensus.advanceTimeBy(SECONDS_PER_SLOT)

    //   const time2 = +(await consensus.getTime())
    //   assert.equal(time2, time1 + SECONDS_PER_SLOT)
    //   assert.equals(await oracle.getTime(), time2)

    //   const handleOracleReportCallData = await mockLido.getLastCall_handleOracleReport()
    //   assert.equals(handleOracleReportCallData.callCount, 0)

    //   const updateExitedKeysByModuleCallData = await mockStakingRouter.lastCall_updateExitedKeysByModule()
    //   assert.equals(updateExitedKeysByModuleCallData.callCount, 0)

    //   assert.equals(await mockStakingRouter.totalCalls_reportExitedKeysByNodeOperator(), 0)
    //   assert.equals(await mockStakingRouter.totalCalls_reportStuckKeysByNodeOperator(), 0)

    //   const onOracleReportLastCall = await mockWithdrawalQueue.lastCall__onOracleReport()
    //   assert.equals(onOracleReportLastCall.callCount, 0)
    // })

    // it('the initial reference slot is greater than the last one of the legacy oracle', async () => {
    //   const legacyRefSlot = +(await legacyOracle.getLastCompletedEpochId()) * SLOTS_PER_EPOCH
    //   assert.isAbove(+(await consensus.getCurrentFrame()).refSlot, legacyRefSlot)
    // })

    // it('initial configuration is correct', async () => {
    //   assert.equal(await oracle.getConsensusContract(), consensus.address)
    //   assert.equals(await oracle.getConsensusVersion(), CONSENSUS_VERSION)
    //   assert.equal(await oracle.LIDO(), mockLido.address)
    //   assert.equals(await oracle.SECONDS_PER_SLOT(), SECONDS_PER_SLOT)
    // })

    // it('constructor reverts if lido locator address is zero', async () => {
    //   await assert.reverts(
    //     deployAccountingOracleSetup(admin, { lidoLocatorAddr: ZERO_ADDRESS }),
    //     'LidoLocatorCannotBeZero()'
    //   )
    // })

    // it('constructor reverts if legacy oracle address is zero', async () => {
    //   await assert.reverts(
    //     deployAccountingOracleSetup(admin, { legacyOracleAddr: ZERO_ADDRESS }),
    //     'LegacyOracleCannotBeZero()'
    //   )
    // })

    // it('constructor reverts if lido address is zero', async () => {
    //   await assert.reverts(deployAccountingOracleSetup(admin, { lidoAddr: ZERO_ADDRESS }), 'LidoCannotBeZero()')
    // })

    // it('initialize reverts if admin address is zero', async () => {
    //   const deployed = await deployAccountingOracleSetup(admin)
    //   await updateInitialEpoch(deployed.consensus)
    //   await assert.reverts(
    //     deployed.oracle.initialize(ZERO_ADDRESS, deployed.consensus.address, CONSENSUS_VERSION, { from: admin }),
    //     'AdminCannotBeZero()'
    //   )
    // })

    // it('initializeWithoutMigration reverts if admin address is zero', async () => {
    //   const deployed = await deployAccountingOracleSetup(admin)
    //   await updateInitialEpoch(deployed.consensus)

    //   await assert.reverts(
    //     deployed.oracle.initializeWithoutMigration(ZERO_ADDRESS, deployed.consensus.address, CONSENSUS_VERSION, 0, {
    //       from: admin,
    //     }),
    //     'AdminCannotBeZero()'
    //   )
    // })

    // it('initializeWithoutMigration succeeds otherwise', async () => {
    //   const deployed = await deployAccountingOracleSetup(admin)
    //   await updateInitialEpoch(deployed.consensus)
    //   await deployed.oracle.initializeWithoutMigration(admin, deployed.consensus.address, CONSENSUS_VERSION, 0, {
    //     from: admin,
    //   })
    // })
  })
})
