import { ethers } from "hardhat";

import {
  HashConsensus__Harness,
  ReportProcessor__Mock,
  StakingModule__MockForKeyVerification,
  ValidatorsExitBusOracle,
} from "typechain-types";

import {
  EPOCHS_PER_FRAME,
  GENESIS_TIME,
  INITIAL_EPOCH,
  numberToHex,
  SECONDS_PER_SLOT,
  SLOTS_PER_EPOCH,
  VEBO_CONSENSUS_VERSION,
} from "lib";

import { deployHashConsensus } from "./hashConsensus";
import { deployLidoLocator, updateLidoLocatorImplementation } from "./locator";

export const MAX_REQUESTS_PER_REPORT = 400;

// MaxEB weights (in ETH)
export const MAX_EFFECTIVE_BALANCE_WEIGHT_WC_TYPE_01 = 32n; // 32 ETH for WC 0x01 validators
export const MAX_EFFECTIVE_BALANCE_WEIGHT_WC_TYPE_02 = 2048n; // 2048 ETH for 0x02 validators

// amount in gwei: 0 is a full withdrawal (FWR), > 0 is a partial one (PWR)
export interface WithdrawalRequest {
  moduleId: number;
  nodeOpId: number | bigint;
  keyIndex: number | bigint;
  amount: bigint;
}

export interface VEBOReportFields {
  consensusVersion: bigint;
  refSlot: bigint;
  requestsCount: number;
  data: string;
}

// | 3 bytes: moduleId | 5 bytes: nodeOpId | 8 bytes: keyIndex | 8 bytes: amount (gwei) |
export function encodeWithdrawalRequests(requests: WithdrawalRequest[]): string {
  return (
    "0x" +
    requests
      .map(
        ({ moduleId, nodeOpId, keyIndex, amount }) =>
          numberToHex(moduleId, 3) + numberToHex(nodeOpId, 5) + numberToHex(keyIndex, 8) + numberToHex(amount, 8),
      )
      .join("")
  );
}

export function calcVEBOReportDataHash(report: VEBOReportFields): string {
  const reportData = [report.consensusVersion, report.refSlot, report.requestsCount, report.data];
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["(uint256,uint256,uint256,bytes)"], [reportData]));
}

async function deployMockAccountingOracle(secondsPerSlot = SECONDS_PER_SLOT, genesisTime = GENESIS_TIME) {
  const lido = await ethers.deployContract("Accounting__MockForAccountingOracle");
  const ao = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
    await lido.getAddress(),
    secondsPerSlot,
    genesisTime,
  ]);
  return { ao, lido };
}

async function deployOracleReportSanityCheckerForExitBus(lidoLocator: string, accounting: string, admin: string) {
  return await ethers.getContractFactory("OracleReportSanityChecker").then((f) =>
    f.deploy(lidoLocator, accounting, admin, {
      exitedEthAmountPerDayLimit: 0n,
      appearedEthAmountPerDayLimit: 0n,
      annualBalanceIncreaseBPLimit: 0n,
      simulatedShareRateDeviationBPLimit: 0n,
      maxBalanceExitRequestedPerReportInEth: 65_535n, // Max uint16 (65,535 ETH)
      maxEffectiveBalanceWeightWCType01: MAX_EFFECTIVE_BALANCE_WEIGHT_WC_TYPE_01,
      maxEffectiveBalanceWeightWCType02: MAX_EFFECTIVE_BALANCE_WEIGHT_WC_TYPE_02,
      maxItemsPerExtraDataTransaction: 0n,
      maxNodeOperatorsPerExtraDataItem: 0n,
      requestTimestampMargin: 0n,
      maxPositiveTokenRebase: 1n,
      maxCLBalanceDecreaseBP: 360n,
      clBalanceOraclesErrorUpperBPLimit: 0n,
      consolidationEthAmountPerDayLimit: 0n,
      exitedValidatorEthAmountLimit: 1n,
      externalPendingBalanceCapEth: 0n,
    }),
  );
}

async function deployTWB() {
  return await ethers.deployContract("TriggerableWithdrawalsBus__MockForVEB");
}

export async function deployVEBO(
  admin: string,
  {
    epochsPerFrame = EPOCHS_PER_FRAME,
    secondsPerSlot = SECONDS_PER_SLOT,
    slotsPerEpoch = SLOTS_PER_EPOCH,
    genesisTime = GENESIS_TIME,
    initialEpoch = INITIAL_EPOCH,
    maxRequestsPerReport = MAX_REQUESTS_PER_REPORT,
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
  // Modules 2, 3, 4, 5, 7: MaxEB (0x02) - 2048 ETH validators
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(2, 0x02);
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(3, 0x02);
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(4, 0x02);
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(5, 0x02);
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(7, 0x02);
  // Modules 100, 101: Used in tests - configure as Legacy (0x01)
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(100, 0x01);
  await stakingRouter.setStakingModuleWithdrawalCredentialsType(101, 0x01);

  // Deploy universal mock modules: they return signing keys by keyIndex
  // and work for both legacy and new interfaces
  const mockModule1 = await ethers.deployContract("StakingModule__MockForKeyVerification");
  const mockModule2 = await ethers.deployContract("StakingModule__MockForKeyVerification");
  const mockModule3 = await ethers.deployContract("StakingModule__MockForKeyVerification");
  const mockModule4 = await ethers.deployContract("StakingModule__MockForKeyVerification");
  const mockModule5 = await ethers.deployContract("StakingModule__MockForKeyVerification");
  const mockModule7 = await ethers.deployContract("StakingModule__MockForKeyVerification");

  await stakingRouter.setStakingModuleAddress(1, await mockModule1.getAddress());
  await stakingRouter.setStakingModuleAddress(2, await mockModule2.getAddress());
  await stakingRouter.setStakingModuleAddress(3, await mockModule3.getAddress());
  await stakingRouter.setStakingModuleAddress(4, await mockModule4.getAddress());
  await stakingRouter.setStakingModuleAddress(5, await mockModule5.getAddress());
  await stakingRouter.setStakingModuleAddress(7, await mockModule7.getAddress());

  await updateLidoLocatorImplementation(locatorAddr, {
    stakingRouter: stakingRouterAddr,
  });

  const oracle = await ethers.deployContract("ValidatorsExitBus__Harness", [
    secondsPerSlot,
    genesisTime,
    locatorAddr,
    maxRequestsPerReport,
  ]);

  const { consensus } = await deployHashConsensus(admin, {
    reportProcessor: oracle as unknown as ReportProcessor__Mock,
    epochsPerFrame,
    secondsPerSlot,
    genesisTime,
  });

  const { ao, lido } = await deployMockAccountingOracle(secondsPerSlot, genesisTime);
  const triggerableWithdrawalsBus = await deployTWB();

  const accountingOracleAddress = await ao.getAddress();
  const accountingAddress = await locator.accounting();

  await updateLidoLocatorImplementation(locatorAddr, {
    lido: await lido.getAddress(),
    accountingOracle: accountingOracleAddress,
    triggerableWithdrawalsBus: await triggerableWithdrawalsBus.getAddress(),
  });

  const oracleReportSanityChecker = await deployOracleReportSanityCheckerForExitBus(
    locatorAddr,
    accountingAddress,
    admin,
  );

  await updateLidoLocatorImplementation(locatorAddr, {
    validatorsExitBusOracle: await oracle.getAddress(),
    oracleReportSanityChecker: await oracleReportSanityChecker.getAddress(),
    triggerableWithdrawalsBus: await triggerableWithdrawalsBus.getAddress(),
  });

  await consensus.setTime(genesisTime + initialEpoch * slotsPerEpoch * secondsPerSlot);

  return {
    locator,
    locatorAddr,
    oracle,
    consensus,
    oracleReportSanityChecker,
    triggerableWithdrawalsBus,
    stakingRouter,
    mockModules: {
      module1: mockModule1,
      module2: mockModule2,
      module3: mockModule3,
      module4: mockModule4,
      module5: mockModule5,
      module7: mockModule7,
    },
  };
}

// Derive the same 48-byte pubkey as StakingModule__MockForKeyVerification fallback:
// pubkey = keccak(nodeOpId, keyIndex) || first 16 bytes of keccak(nodeOpId, keyIndex, 1)
export function makeMockPubkey(nodeOpId: number | bigint, keyIndex: number | bigint): string {
  const hash1 = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [nodeOpId, keyIndex]),
  );
  const hash2 = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256"], [nodeOpId, keyIndex, 1]),
  );
  return ("0x" + hash1.slice(2) + hash2.slice(2)).slice(0, 2 + 96);
}

// Seed StakingModule__MockForKeyVerification instances with signing keys matching requests
export async function seedMockModuleSigningKeys(
  mockModules: {
    module1: StakingModule__MockForKeyVerification;
    module2: StakingModule__MockForKeyVerification;
    module3: StakingModule__MockForKeyVerification;
    module4: StakingModule__MockForKeyVerification;
    module5: StakingModule__MockForKeyVerification;
    module7: StakingModule__MockForKeyVerification;
  },
  requests: { moduleId: number; nodeOpId: number; keyIndex: number; pubkey?: string }[],
) {
  const modMap: Record<number, StakingModule__MockForKeyVerification> = {
    1: mockModules.module1,
    2: mockModules.module2,
    3: mockModules.module3,
    4: mockModules.module4,
    5: mockModules.module5,
    7: mockModules.module7,
  };

  for (const r of requests) {
    const mod = modMap[r.moduleId];
    if (!mod || !mod.setSigningKey) continue;
    const pubkey = r.pubkey ?? makeMockPubkey(r.nodeOpId, r.keyIndex);
    await mod.setSigningKey(r.nodeOpId, r.keyIndex, pubkey);
  }
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
  consensusVersion = VEBO_CONSENSUS_VERSION,
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

  if (resumeAfterDeploy) {
    await oracle.resume();
  }

  return initTx;
}
