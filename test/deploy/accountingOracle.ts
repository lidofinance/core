import { expect } from "chai";
import { ethers } from "hardhat";

import { AccountingOracle, HashConsensus__Harness, LegacyOracle, ReportProcessor__Mock } from "typechain-types";

import {
  CONSENSUS_VERSION,
  EPOCHS_PER_FRAME,
  EXTRA_DATA_FORMAT_EMPTY,
  EXTRA_DATA_FORMAT_LIST,
  EXTRA_DATA_TYPE_EXITED_VALIDATORS,
  EXTRA_DATA_TYPE_STUCK_VALIDATORS,
  GENESIS_TIME,
  SECONDS_PER_SLOT,
  SLOTS_PER_EPOCH,
} from "lib";

import { deployHashConsensus } from "./hashConsensus";
import { deployLidoLocator, updateLidoLocatorImplementation } from "./locator";

export const V1_ORACLE_LAST_COMPLETED_EPOCH = 2n * EPOCHS_PER_FRAME;
export const V1_ORACLE_LAST_REPORT_SLOT = V1_ORACLE_LAST_COMPLETED_EPOCH * SLOTS_PER_EPOCH;

export async function deployMockLegacyOracle({
  epochsPerFrame = EPOCHS_PER_FRAME,
  slotsPerEpoch = SLOTS_PER_EPOCH,
  secondsPerSlot = SECONDS_PER_SLOT,
  genesisTime = GENESIS_TIME,
  lastCompletedEpochId = V1_ORACLE_LAST_COMPLETED_EPOCH,
} = {}) {
  const legacyOracle = await ethers.deployContract("LegacyOracle__MockForAccountingOracle");
  await legacyOracle.setParams(epochsPerFrame, slotsPerEpoch, secondsPerSlot, genesisTime, lastCompletedEpochId);
  return legacyOracle;
}

async function deployMockLidoAndStakingRouter() {
  const stakingRouter = await ethers.deployContract("StakingRouter__MockForAccountingOracle");
  const withdrawalQueue = await ethers.deployContract("WithdrawalQueue__MockForAccountingOracle");
  const lido = await ethers.deployContract("Lido__MockForAccountingOracle");
  return { lido, stakingRouter, withdrawalQueue };
}

export async function deployAccountingOracleSetup(
  admin: string,
  {
    initialEpoch = null as bigint | null,
    epochsPerFrame = EPOCHS_PER_FRAME,
    slotsPerEpoch = SLOTS_PER_EPOCH,
    secondsPerSlot = SECONDS_PER_SLOT,
    genesisTime = GENESIS_TIME,
    getLidoAndStakingRouter = deployMockLidoAndStakingRouter,
    getLegacyOracle = deployMockLegacyOracle,
    lidoLocatorAddr = null as string | null,
    legacyOracleAddr = null as string | null,
    lidoAddr = null as string | null,
  } = {},
) {
  const locator = await deployLidoLocator();
  const locatorAddr = await locator.getAddress();
  const { lido, stakingRouter, withdrawalQueue } = await getLidoAndStakingRouter();
  const oracleReportSanityChecker = await deployOracleReportSanityCheckerForAccounting(locatorAddr, admin);

  const legacyOracle = await getLegacyOracle();

  if (initialEpoch == null) {
    initialEpoch = (await legacyOracle.getLastCompletedEpochId()) + epochsPerFrame;
  }

  const oracle = await ethers.deployContract("AccountingOracle__Harness", [
    lidoLocatorAddr || locatorAddr,
    lidoAddr || (await lido.getAddress()),
    legacyOracleAddr || (await legacyOracle.getAddress()),
    secondsPerSlot,
    genesisTime,
  ]);

  const { consensus } = await deployHashConsensus(admin, {
    reportProcessor: oracle as unknown as ReportProcessor__Mock,
    epochsPerFrame,
    slotsPerEpoch,
    secondsPerSlot,
    genesisTime,
    initialEpoch,
  });

  await updateLidoLocatorImplementation(locatorAddr, {
    lido: lidoAddr || (await lido.getAddress()),
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
  };
}

interface AccountingOracleConfig {
  admin: string;
  oracle: AccountingOracle;
  consensus: HashConsensus__Harness;
  dataSubmitter?: string;
  consensusVersion?: bigint;
  shouldMigrateLegacyOracle?: boolean;
  lastProcessingRefSlot?: number;
}

export async function initAccountingOracle({
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
      lastProcessingRefSlot,
    );

  await oracle.grantRole(await oracle.MANAGE_CONSENSUS_CONTRACT_ROLE(), admin);
  await oracle.grantRole(await oracle.MANAGE_CONSENSUS_VERSION_ROLE(), admin);

  if (dataSubmitter) {
    await oracle.grantRole(await oracle.SUBMIT_DATA_ROLE(), dataSubmitter);
  }

  expect(await oracle.EXTRA_DATA_FORMAT_EMPTY()).to.equal(EXTRA_DATA_FORMAT_EMPTY);
  expect(await oracle.EXTRA_DATA_FORMAT_LIST()).to.equal(EXTRA_DATA_FORMAT_LIST);
  expect(await oracle.EXTRA_DATA_TYPE_STUCK_VALIDATORS()).to.equal(EXTRA_DATA_TYPE_STUCK_VALIDATORS);
  expect(await oracle.EXTRA_DATA_TYPE_EXITED_VALIDATORS()).to.equal(EXTRA_DATA_TYPE_EXITED_VALIDATORS);

  return initTx;
}

async function deployOracleReportSanityCheckerForAccounting(lidoLocator: string, admin: string) {
  const churnValidatorsPerDayLimit = 100;
  const limitsList = [churnValidatorsPerDayLimit, 0, 0, 0, 32 * 12, 15, 16, 0, 0];
  const managersRoster = [[admin], [admin], [admin], [admin], [admin], [admin], [admin], [admin], [admin], [admin]];

  return await ethers.deployContract("OracleReportSanityChecker", [lidoLocator, admin, limitsList, managersRoster]);
}

interface AccountingOracleSetup {
  admin: string;
  consensus: HashConsensus__Harness;
  oracle: AccountingOracle;
  legacyOracle: LegacyOracle;
  dataSubmitter?: string;
  consensusVersion?: bigint;
}

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
  await consensus.setTimeInEpochs(await legacyOracle.getLastCompletedEpochId());

  const initialEpoch = (await legacyOracle.getLastCompletedEpochId()) + frameConfig.epochsPerFrame;

  const updateInitialEpochIx = await consensus.updateInitialEpoch(initialEpoch);
  const initTx = await initAccountingOracle({ admin, oracle, consensus, dataSubmitter, consensusVersion });

  return { updateInitialEpochIx, initTx };
}

export async function deployAndConfigureAccountingOracle(admin: string) {
  /// this is done (far) before the protocol upgrade voting initiation:
  ///   1. deploy HashConsensus
  ///   2. deploy AccountingOracle impl
  const deployed = await deployAccountingOracleSetup(admin);

  // pretend we're after the legacy oracle's last proc epoch but before the new oracle's initial epoch
  expect(EPOCHS_PER_FRAME).to.be.greaterThan(1);
  const voteExecTime = GENESIS_TIME + (V1_ORACLE_LAST_COMPLETED_EPOCH + 1n) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
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
