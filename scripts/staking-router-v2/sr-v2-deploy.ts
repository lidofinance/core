import * as dotenv from "dotenv";
import { ethers, run } from "hardhat";
import { join } from "path";
import readline from "readline";

import { DepositSecurityModule, DepositSecurityModule__factory } from "typechain-types";

import {
  cy,
  deployImplementation,
  deployWithoutProxy,
  loadContract,
  log,
  persistNetworkState,
  readNetworkState,
  Sk,
  updateObjectInState,
} from "lib";

dotenv.config({ path: join(__dirname, "../../.env") });

function getEnvVariable(name: string, defaultValue?: string) {
  const value = process.env[name];
  if (value === undefined) {
    if (defaultValue === undefined) {
      throw new Error(`Env variable ${name} must be set`);
    }
    return defaultValue;
  } else {
    log(`Using env variable ${name}=${value}`);
    return value;
  }
}

// Accounting Oracle args
const SECONDS_PER_SLOT = 12;
const GENESIS_TIME = 1606824023;
// Oracle report sanity checker
const LIMITS = [9000, 43200, 1000, 50, 600, 8, 62, 7680, 750000, 1000, 101, 74];
// DSM args
const PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS = 6646;
const MAX_OPERATORS_PER_UNVETTING = 200;
const guardians = [
  "0x5fd0dDbC3351d009eb3f88DE7Cd081a614C519F1",
  "0x7912Fa976BcDe9c2cf728e213e892AD7588E6AaF",
  "0x14D5d5B71E048d2D75a39FfC5B407e3a3AB6F314",
  "0xf82D88217C249297C6037BA77CE34b3d8a90ab43",
  "0xa56b128Ea2Ea237052b0fA2a96a387C0E43157d8",
  "0xd4EF84b638B334699bcf5AF4B0410B8CCD71943f",
];
const quorum = 4;

async function main() {
  const deployer = ethers.getAddress(getEnvVariable("DEPLOYER"));
  const chainId = (await ethers.provider.getNetwork()).chainId;

  log(cy(`Deploy of contracts on chain ${chainId}`));

  const state = readNetworkState();
  state[Sk.scratchDeployGasUsed] = 0n.toString();
  persistNetworkState(state);

  // Read contracts addresses from config
  const DEPOSIT_CONTRACT_ADDRESS = state[Sk.chainSpec].depositContractAddress;
  const APP_AGENT_ADDRESS = state[Sk.appAgent].proxy.address;
  const SC_ADMIN = APP_AGENT_ADDRESS;
  const LIDO = state[Sk.appLido].proxy.address;
  const STAKING_ROUTER = state[Sk.stakingRouter].proxy.address;
  const LOCATOR = state[Sk.lidoLocator].proxy.address;
  const LEGACY_ORACLE = state[Sk.appOracle].proxy.address;
  const ACCOUNTING_ORACLE_PROXY = state[Sk.accountingOracle].proxy.address;
  const EL_REWARDS_VAULT = state[Sk.executionLayerRewardsVault].address;
  const BURNER = state[Sk.burner].address;
  const TREASURY_ADDRESS = APP_AGENT_ADDRESS;
  const VEBO = state[Sk.validatorsExitBusOracle].proxy.address;
  const WQ = state[Sk.withdrawalQueueERC721].proxy.address;
  const WITHDRAWAL_VAULT = state[Sk.withdrawalVault].proxy.address;
  const ORACLE_DAEMON_CONFIG = state[Sk.oracleDaemonConfig].address;

  // Deploy MinFirstAllocationStrategy
  const minFirstAllocationStrategyAddress = (
    await deployWithoutProxy(Sk.minFirstAllocationStrategy, "MinFirstAllocationStrategy", deployer)
  ).address;
  log.success(`MinFirstAllocationStrategy address: ${minFirstAllocationStrategyAddress}`);
  log.emptyLine();

  const libraries = {
    MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
  };

  // Deploy StakingRouter
  const stakingRouterAddress = (
    await deployImplementation(Sk.stakingRouter, "StakingRouter", deployer, [DEPOSIT_CONTRACT_ADDRESS], { libraries })
  ).address;
  log.success(`StakingRouter implementation address: ${stakingRouterAddress}`);
  log.emptyLine();

  // Deploy NOR
  const appNodeOperatorsRegistry = (
    await deployImplementation(Sk.appNodeOperatorsRegistry, "NodeOperatorsRegistry", deployer, [], { libraries })
  ).address;
  log.success(`NodeOperatorsRegistry address implementation: ${appNodeOperatorsRegistry}`);
  log.emptyLine();

  updateObjectInState(Sk.appSimpleDvt, {
    implementation: {
      contract: "contracts/0.4.24/nos/NodeOperatorsRegistry.sol",
      address: appNodeOperatorsRegistry,
      constructorArgs: [],
    },
  });

  // Deploy DSM
  const depositSecurityModuleParams = [
    LIDO,
    DEPOSIT_CONTRACT_ADDRESS,
    STAKING_ROUTER,
    PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS,
    MAX_OPERATORS_PER_UNVETTING,
  ];
  const depositSecurityModuleAddress = (
    await deployWithoutProxy(Sk.depositSecurityModule, "DepositSecurityModule", deployer, depositSecurityModuleParams)
  ).address;
  log.success(`New DSM address: ${depositSecurityModuleAddress}`);
  log.emptyLine();

  const dsmContract = await loadContract<DepositSecurityModule>(
    DepositSecurityModule__factory,
    depositSecurityModuleAddress,
  );
  await dsmContract.addGuardians(guardians, quorum);
  await dsmContract.setOwner(APP_AGENT_ADDRESS);
  log.success(`Guardians list: ${await dsmContract.getGuardians()}`);
  log.success(`Quorum: ${await dsmContract.getGuardianQuorum()}`);
  log.emptyLine();

  // Deploy AO
  const accountingOracleArgs = [LOCATOR, LIDO, LEGACY_ORACLE, SECONDS_PER_SLOT, GENESIS_TIME];
  const accountingOracleAddress = (
    await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, accountingOracleArgs)
  ).address;
  log.success(`AO implementation address: ${accountingOracleAddress}`);
  log.emptyLine();

  // Deploy OracleReportSanityCheckerArgs
  const oracleReportSanityCheckerArgs = [LOCATOR, SC_ADMIN, LIMITS];
  const oracleReportSanityCheckerAddress = (
    await deployWithoutProxy(
      Sk.oracleReportSanityChecker,
      "OracleReportSanityChecker",
      deployer,
      oracleReportSanityCheckerArgs,
    )
  ).address;
  log.success(`OracleReportSanityChecker new address ${oracleReportSanityCheckerAddress}`);
  log.emptyLine();

  const locatorConfig = [
    [
      ACCOUNTING_ORACLE_PROXY,
      depositSecurityModuleAddress,
      EL_REWARDS_VAULT,
      LEGACY_ORACLE,
      LIDO,
      oracleReportSanityCheckerAddress,
      LEGACY_ORACLE,
      BURNER,
      STAKING_ROUTER,
      TREASURY_ADDRESS,
      VEBO,
      WQ,
      WITHDRAWAL_VAULT,
      ORACLE_DAEMON_CONFIG,
    ],
  ];

  const locatorAddress = (await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, locatorConfig)).address;
  log.success(`Locator implementation address ${locatorAddress}`);
  log.emptyLine();

  if (getEnvVariable("RUN_ON_FORK", "false") === "true") {
    log(cy("Deploy script was executed on fork, will skip verification"));
    return;
  }

  await waitForPressButton();

  log(cy("Continuing..."));

  await run("verify:verify", {
    address: minFirstAllocationStrategyAddress,
    constructorArguments: [],
    contract: "contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy",
  });

  await run("verify:verify", {
    address: stakingRouterAddress,
    constructorArguments: [DEPOSIT_CONTRACT_ADDRESS],
    libraries: {
      MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
    },
    contract: "contracts/0.8.9/StakingRouter.sol:StakingRouter",
  });

  await run("verify:verify", {
    address: appNodeOperatorsRegistry,
    constructorArguments: [],
    libraries: {
      MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
    },
    contract: "contracts/0.4.24/nos/NodeOperatorsRegistry.sol:NodeOperatorsRegistry",
  });

  await run("verify:verify", {
    address: depositSecurityModuleAddress,
    constructorArguments: depositSecurityModuleParams,
    contract: "contracts/0.8.9/DepositSecurityModule.sol:DepositSecurityModule",
  });

  await run("verify:verify", {
    address: accountingOracleAddress,
    constructorArguments: accountingOracleArgs,
    contract: "contracts/0.8.9/oracle/AccountingOracle.sol:AccountingOracle",
  });

  await run("verify:verify", {
    address: oracleReportSanityCheckerAddress,
    constructorArguments: oracleReportSanityCheckerArgs,
    contract: "contracts/0.8.9/sanity_checks/OracleReportSanityChecker.sol:OracleReportSanityChecker",
  });

  await run("verify:verify", {
    address: locatorAddress,
    constructorArguments: locatorConfig,
    contract: "contracts/0.8.9/LidoLocator.sol:LidoLocator",
  });
}

async function waitForPressButton(): Promise<void> {
  return new Promise<void>((resolve) => {
    log(cy("When contracts will be ready for verification step, press Enter to continue..."));
    const rl = readline.createInterface({ input: process.stdin });

    rl.on("line", () => {
      rl.close();
      resolve();
    });
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
