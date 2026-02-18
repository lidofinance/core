import { expect } from "chai";
import { ethers } from "hardhat";

import { HashConsensus__Harness, ReportProcessor__Mock, ValidatorsExitBusOracle } from "typechain-types";

import {
  EPOCHS_PER_FRAME,
  GENESIS_TIME,
  INITIAL_EPOCH,
  SECONDS_PER_SLOT,
  SLOTS_PER_EPOCH,
  VEBO_CONSENSUS_VERSION,
} from "lib";

import { deployHashConsensus } from "./hashConsensus";
import { deployLidoLocator, updateLidoLocatorImplementation } from "./locator";

export const DATA_FORMAT_LIST = 1;
export const DATA_FORMAT_LIST_WITH_KEY_INDEX = 2;

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
      simulatedShareRateDeviationBPLimit: 0n,
      maxBalanceExitRequestedPerReportInEth: 65_535n, // Max uint16 (65,535 ETH)
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

async function deployTWG() {
  return await ethers.deployContract("TriggerableWithdrawalsGateway__MockForVEB");
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

  // Deploy mock StakingRouter with default module configurations
  const stakingRouter = await ethers.deployContract("StakingRouter__MockForValidatorsExitBus");
  const stakingRouterAddr = await stakingRouter.getAddress();

  // Configure default modules:
  // Module 1: Legacy (0x01) - 32 ETH validators
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(1, 0x01);
  // Modules 2, 3, 5, 7: MaxEB (0x02) - 2048 ETH validators
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(2, 0x02);
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(3, 0x02);
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(5, 0x02);
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(7, 0x02);
  // Modules 100, 101: Used in tests - configure as Legacy (0x01)
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(100, 0x01);
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(101, 0x01);

  // Deploy universal mock modules for key verification (Format 2 testing)
  // These mocks return requested keys and work for both legacy and new interfaces
  const mockModule1 = await ethers.deployContract("StakingModule__MockForKeyVerification");
  const mockModule2 = await ethers.deployContract("StakingModule__MockForKeyVerification");
  const mockModule3 = await ethers.deployContract("StakingModule__MockForKeyVerification");
  const mockModule5 = await ethers.deployContract("StakingModule__MockForKeyVerification");
  const mockModule7 = await ethers.deployContract("StakingModule__MockForKeyVerification");

  await stakingRouter.setStakingModuleAddress(1, await mockModule1.getAddress());
  await stakingRouter.setStakingModuleAddress(2, await mockModule2.getAddress());
  await stakingRouter.setStakingModuleAddress(3, await mockModule3.getAddress());
  await stakingRouter.setStakingModuleAddress(5, await mockModule5.getAddress());
  await stakingRouter.setStakingModuleAddress(7, await mockModule7.getAddress());

  await updateLidoLocatorImplementation(locatorAddr, {
    stakingRouter: stakingRouterAddr,
  });

  // Deploy mock NodeOperatorsRegistry
  // In permissive mode (default), it returns empty keys which causes ValidatorsExitBus
  // to skip validation. Tests can explicitly configure keys if needed.
  const nodeOperatorsRegistry = await ethers.deployContract("NodeOperatorsRegistry__Mock");

  // Max effective balance values (in ETH)
  const MAX_BALANCE_WC_TYPE_01_ETH = 32n; // 32 ETH for legacy validators
  const MAX_BALANCE_WC_TYPE_02_ETH = 2048n; // 2048 ETH for MaxEB validators

  // Legacy modules bitmask: set bit for each legacy module (NOR=1, SDVT=3)
  // Example: modules 1 and 3 are legacy -> bitmask = (1 << 1) | (1 << 3) = 0b1010 = 10
  const LEGACY_MODULES_BITMASK = 1n << 1n; // Module 1 is legacy

  const oracle = await ethers.deployContract("ValidatorsExitBus__Harness", [
    secondsPerSlot,
    genesisTime,
    locatorAddr,
    LEGACY_MODULES_BITMASK,
    MAX_BALANCE_WC_TYPE_01_ETH,
    MAX_BALANCE_WC_TYPE_02_ETH,
  ]);

  const { consensus } = await deployHashConsensus(admin, {
    reportProcessor: oracle as unknown as ReportProcessor__Mock,
    epochsPerFrame,
    secondsPerSlot,
    genesisTime,
  });

  const { ao, lido } = await deployMockAccountingOracle(secondsPerSlot, genesisTime);
  const triggerableWithdrawalsGateway = await deployTWG();

  const accountingOracleAddress = await ao.getAddress();
  const accountingAddress = await locator.accounting();

  await updateLidoLocatorImplementation(locatorAddr, {
    lido: await lido.getAddress(),
    accountingOracle: accountingOracleAddress,
    triggerableWithdrawalsGateway: await triggerableWithdrawalsGateway.getAddress(),
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
    triggerableWithdrawalsGateway: await triggerableWithdrawalsGateway.getAddress(),
  });

  await consensus.setTime(genesisTime + initialEpoch * slotsPerEpoch * secondsPerSlot);

  return {
    locator,
    locatorAddr,
    oracle,
    consensus,
    oracleReportSanityChecker,
    triggerableWithdrawalsGateway,
    nodeOperatorsRegistry,
    stakingRouter,
    mockModules: {
      module1: mockModule1,
      module2: mockModule2,
      module3: mockModule3,
      module5: mockModule5,
      module7: mockModule7,
    },
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
  maxRequestsPerBatch?: number;
  maxExitBalanceEth?: bigint;
  balancePerFrameEth?: bigint;
  frameDurationInSec?: number;
}

export async function initVEBO({
  admin,
  oracle,
  consensus,
  dataSubmitter = undefined,
  consensusVersion = VEBO_CONSENSUS_VERSION,
  lastProcessingRefSlot = 0,
  resumeAfterDeploy = false,
  maxRequestsPerBatch = 600,
  maxExitBalanceEth = 13_000n, // 13,000 ETH
  balancePerFrameEth = 32n, // 32 ETH (1 legacy validator per frame)
  frameDurationInSec = 48,
}: VEBOConfig) {
  const initTx = await oracle.initialize(
    admin,
    await consensus.getAddress(),
    consensusVersion,
    lastProcessingRefSlot,
    maxRequestsPerBatch,
    maxExitBalanceEth,
    balancePerFrameEth,
    frameDurationInSec,
  );

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
