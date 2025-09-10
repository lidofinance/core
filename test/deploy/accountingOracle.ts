import { expect } from "chai";
import { ethers } from "hardhat";

import { AccountingOracle, HashConsensus__Harness, ReportProcessor__Mock } from "typechain-types";

import {
  AO_CONSENSUS_VERSION,
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

export const ORACLE_LAST_COMPLETED_EPOCH = 2n * EPOCHS_PER_FRAME;
export const ORACLE_LAST_REPORT_SLOT = ORACLE_LAST_COMPLETED_EPOCH * SLOTS_PER_EPOCH;

async function deployMockAccountingAndStakingRouter() {
  const stakingRouter = await ethers.deployContract("StakingRouter__MockForAccountingOracle");
  const withdrawalQueue = await ethers.deployContract("WithdrawalQueue__MockForAccountingOracle");
  const accounting = await ethers.deployContract("Accounting__MockForAccountingOracle");
  return { accounting, stakingRouter, withdrawalQueue };
}

async function deployMockLazyOracle() {
  return ethers.deployContract("LazyOracle__MockForAccountingOracle");
}

export async function deployAccountingOracleSetup(
  admin: string,
  {
    initialEpoch = ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME,
    epochsPerFrame = EPOCHS_PER_FRAME,
    slotsPerEpoch = SLOTS_PER_EPOCH,
    secondsPerSlot = SECONDS_PER_SLOT,
    genesisTime = GENESIS_TIME,
    getLidoAndStakingRouter = deployMockAccountingAndStakingRouter,
    lidoLocatorAddr = null as string | null,
  } = {},
) {
  const locator = await deployLidoLocator();
  const locatorAddr = await locator.getAddress();
  const { accounting, stakingRouter, withdrawalQueue } = await getLidoAndStakingRouter();

  const oracle = await ethers.deployContract("AccountingOracle__Harness", [
    lidoLocatorAddr || locatorAddr,
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

  const accountingOracleAddress = await oracle.getAddress();
  const accountingAddress = await accounting.getAddress();

  await updateLidoLocatorImplementation(locatorAddr, {
    stakingRouter: await stakingRouter.getAddress(),
    withdrawalQueue: await withdrawalQueue.getAddress(),
    accountingOracle: accountingOracleAddress,
    accounting: accountingAddress,
  });

  const lazyOracle = await deployMockLazyOracle();

  const oracleReportSanityChecker = await deployOracleReportSanityCheckerForAccounting(
    locatorAddr,
    accountingOracleAddress,
    accountingAddress,
    admin,
  );

  await updateLidoLocatorImplementation(locatorAddr, {
    oracleReportSanityChecker: await oracleReportSanityChecker.getAddress(),
    lazyOracle: await lazyOracle.getAddress(),
  });

  // pretend we're at the first slot of the initial frame's epoch
  await consensus.setTime(genesisTime + initialEpoch * slotsPerEpoch * secondsPerSlot);

  return {
    accounting,
    stakingRouter,
    withdrawalQueue,
    locatorAddr,
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
  lastProcessingRefSlot?: bigint;
}

export async function initAccountingOracle({
  admin,
  oracle,
  consensus,
  dataSubmitter = undefined,
  consensusVersion = AO_CONSENSUS_VERSION,
  lastProcessingRefSlot = 0n,
}: AccountingOracleConfig) {
  const initTx = await oracle.initialize(admin, await consensus.getAddress(), consensusVersion, lastProcessingRefSlot);

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

async function deployOracleReportSanityCheckerForAccounting(
  lidoLocator: string,
  accountingOracle: string,
  accounting: string,
  admin: string,
) {
  const exitedValidatorsPerDayLimit = 55;
  const appearedValidatorsPerDayLimit = 100;
  return await ethers.getContractFactory("OracleReportSanityChecker").then((f) =>
    f.deploy(lidoLocator, accountingOracle, accounting, admin, {
      exitedValidatorsPerDayLimit,
      appearedValidatorsPerDayLimit,
      annualBalanceIncreaseBPLimit: 0n,
      simulatedShareRateDeviationBPLimit: 0n,
      maxValidatorExitRequestsPerReport: 32n * 12n,
      maxItemsPerExtraDataTransaction: 15n,
      maxNodeOperatorsPerExtraDataItem: 16n,
      requestTimestampMargin: 0n,
      maxPositiveTokenRebase: 0n,
      initialSlashingAmountPWei: 0n,
      inactivityPenaltiesAmountPWei: 0n,
      clBalanceOraclesErrorUpperBPLimit: 0n,
    }),
  );
}

interface AccountingOracleSetup {
  admin: string;
  consensus: HashConsensus__Harness;
  oracle: AccountingOracle;
  dataSubmitter?: string;
  consensusVersion?: bigint;
}

async function configureAccountingOracleSetup({
  admin,
  consensus,
  oracle,
  dataSubmitter = undefined,
  consensusVersion = AO_CONSENSUS_VERSION,
}: AccountingOracleSetup) {
  // this is done as a part of the protocol upgrade voting execution

  const frameConfig = await consensus.getFrameConfig();
  const initialEpoch = ORACLE_LAST_COMPLETED_EPOCH + frameConfig.epochsPerFrame;
  const updateInitialEpochIx = await consensus.updateInitialEpoch(initialEpoch);

  const initTx = await initAccountingOracle({
    admin,
    oracle,
    consensus,
    dataSubmitter,
    consensusVersion,
    lastProcessingRefSlot: ORACLE_LAST_REPORT_SLOT,
  });

  return { updateInitialEpochIx, initTx };
}

export async function deployAndConfigureAccountingOracle(admin: string) {
  /// this is done (far) before the protocol upgrade voting initiation:
  ///   1. deploy HashConsensus
  ///   2. deploy AccountingOracle impl
  const deployed = await deployAccountingOracleSetup(admin);

  // pretend we're after the legacy oracle's last proc epoch but before the new oracle's initial epoch
  expect(EPOCHS_PER_FRAME).to.be.greaterThan(1);
  const voteExecTime = GENESIS_TIME + (ORACLE_LAST_COMPLETED_EPOCH + 1n) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
  await deployed.consensus.setTime(voteExecTime);

  /// this is done as a part of the protocol upgrade voting execution:
  ///   1. calculate HashConsensus initial epoch as the last finalized legacy epoch + frame size
  ///   2. set HashConsensus initial epoch
  ///   3. deploy AccountingOracle proxy (skipped in these tests as they're not testing the proxy setup)
  ///   4. initialize AccountingOracle
  const finalizeResult = await configureAccountingOracleSetup({ admin, ...deployed });

  // pretend we're at the first slot of the new oracle's initial epoch
  const initialEpoch = ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME;
  await deployed.consensus.setTime(GENESIS_TIME + initialEpoch * SLOTS_PER_EPOCH * SECONDS_PER_SLOT);

  return { ...deployed, ...finalizeResult };
}
