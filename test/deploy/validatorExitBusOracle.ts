import { expect } from "chai";
import { ethers } from "hardhat";

import { HashConsensus__Harness, ReportProcessor__Mock, ValidatorsExitBusOracle } from "typechain-types";

import {
  CONSENSUS_VERSION,
  EPOCHS_PER_FRAME,
  GENESIS_TIME,
  INITIAL_EPOCH,
  SECONDS_PER_SLOT,
  SLOTS_PER_EPOCH,
} from "lib";

import { deployHashConsensus } from "./hashConsensus";
import { deployLidoLocator, updateLidoLocatorImplementation } from "./locator";

export const DATA_FORMAT_LIST = 1;

async function deployMockAccountingOracle(secondsPerSlot = SECONDS_PER_SLOT, genesisTime = GENESIS_TIME) {
  const lido = await ethers.deployContract("Accounting__MockForAccountingOracle");
  const ao = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
    await lido.getAddress(),
    secondsPerSlot,
    genesisTime,
  ]);
  return { ao, lido };
}

async function deployOracleReportSanityCheckerForExitBus(
  lidoLocator: string,
  accountingOracle: string,
  accounting: string,
  admin: string,
) {
  return await ethers.getContractFactory("OracleReportSanityChecker").then((f) =>
    f.deploy(lidoLocator, accountingOracle, accounting, admin, {
      exitedValidatorsPerDayLimit: 0n,
      appearedValidatorsPerDayLimit: 0n,
      annualBalanceIncreaseBPLimit: 0n,
      maxValidatorExitRequestsPerReport: 2000,
      maxItemsPerExtraDataTransaction: 0n,
      maxNodeOperatorsPerExtraDataItem: 0n,
      requestTimestampMargin: 0n,
      maxPositiveTokenRebase: 0n,
      initialSlashingAmountPWei: 0n,
      inactivityPenaltiesAmountPWei: 0n,
      clBalanceOraclesErrorUpperBPLimit: 0n,
    }),
  );
}

export async function deployVEBO(
  admin: string,
  {
    epochsPerFrame = EPOCHS_PER_FRAME,
    secondsPerSlot = SECONDS_PER_SLOT,
    slotsPerEpoch = SLOTS_PER_EPOCH,
    genesisTime = GENESIS_TIME,
    initialEpoch = INITIAL_EPOCH,
  } = {},
) {
  const locator = await deployLidoLocator();
  const locatorAddr = await locator.getAddress();

  const oracle = await ethers.deployContract("ValidatorsExitBus__Harness", [secondsPerSlot, genesisTime, locatorAddr]);

  const { consensus } = await deployHashConsensus(admin, {
    reportProcessor: oracle as unknown as ReportProcessor__Mock,
    epochsPerFrame,
    secondsPerSlot,
    genesisTime,
  });

  const { ao, lido } = await deployMockAccountingOracle(secondsPerSlot, genesisTime);

  const accountingOracleAddress = await ao.getAddress();
  const accountingAddress = await locator.accounting();

  await updateLidoLocatorImplementation(locatorAddr, {
    lido: await lido.getAddress(),
    accountingOracle: accountingOracleAddress,
  });

  const oracleReportSanityChecker = await deployOracleReportSanityCheckerForExitBus(
    locatorAddr,
    accountingOracleAddress,
    accountingAddress,
    admin,
  );

  await updateLidoLocatorImplementation(locatorAddr, {
    validatorsExitBusOracle: await oracle.getAddress(),
    oracleReportSanityChecker: await oracleReportSanityChecker.getAddress(),
  });

  await consensus.setTime(genesisTime + initialEpoch * slotsPerEpoch * secondsPerSlot);

  return {
    locatorAddr,
    oracle,
    consensus,
    oracleReportSanityChecker,
  };
}

interface VEBOConfig {
  admin: string;
  oracle: ValidatorsExitBusOracle;
  consensus: HashConsensus__Harness;
  dataSubmitter?: string;
  consensusVersion?: bigint;
  lastProcessingRefSlot?: number;
  resumeAfterDeploy?: boolean;
}

export async function initVEBO({
  admin,
  oracle,
  consensus,
  dataSubmitter = undefined,
  consensusVersion = CONSENSUS_VERSION,
  lastProcessingRefSlot = 0,
  resumeAfterDeploy = false,
}: VEBOConfig) {
  const initTx = await oracle.initialize(admin, await consensus.getAddress(), consensusVersion, lastProcessingRefSlot);

  await oracle.grantRole(await oracle.MANAGE_CONSENSUS_CONTRACT_ROLE(), admin);
  await oracle.grantRole(await oracle.MANAGE_CONSENSUS_VERSION_ROLE(), admin);
  await oracle.grantRole(await oracle.PAUSE_ROLE(), admin);
  await oracle.grantRole(await oracle.RESUME_ROLE(), admin);

  if (dataSubmitter) {
    await oracle.grantRole(await oracle.SUBMIT_DATA_ROLE(), dataSubmitter);
  }

  expect(await oracle.DATA_FORMAT_LIST()).to.equal(DATA_FORMAT_LIST);

  if (resumeAfterDeploy) {
    await oracle.resume();
  }

  return initTx;
}
