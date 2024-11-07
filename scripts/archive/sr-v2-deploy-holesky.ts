import { ethers, run } from "hardhat";

import { DepositSecurityModule, DepositSecurityModule__factory } from "typechain-types";

import {
  deployImplementation,
  deployWithoutProxy,
  loadContract,
  log,
  persistNetworkState,
  readNetworkState,
  Sk,
} from "lib";

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

async function main() {
  // DSM args
  const PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS = 6646;
  const MAX_OPERATORS_PER_UNVETTING = 200;

  // Accounting Oracle args
  const SECONDS_PER_SLOT = 12;
  const GENESIS_TIME = 1695902400;

  // Oracle report sanity checker
  // 43200 check value
  const LIMITS = [9000, 500, 1000, 50, 600, 8, 24, 7680, 750000, 43200];
  const MANAGERS_ROSTER = [[], [], [], [], [], [], [], [], [], [], []];

  const deployer = ethers.getAddress(getEnvVariable("DEPLOYER"));
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const balance = await ethers.provider.getBalance(deployer);
  log(`Deployer ${deployer} on network ${chainId} has balance: ${ethers.formatEther(balance)} ETH`);

  const state = readNetworkState();
  state[Sk.scratchDeployGasUsed] = 0n.toString();
  persistNetworkState(state);

  const guardians = [
    "0x711B5fCfeD5A30CA78e0CAC321B060dE9D6f8979",
    "0xDAaE8C017f1E2a9bEC6111d288f9ebB165e0E163",
    "0x31fa51343297FFce0CC1E67a50B2D3428057D1b1",
    "0x43464Fe06c18848a2E2e913194D64c1970f4326a",
    "0x79A132BE0c25cED09e745629D47cf05e531bb2bb",
    "0x0bf1B3d1e6f78b12f26204348ABfCA9310259FfA",
    "0xf060ab3d5dCfdC6a0DFd5ca0645ac569b8f105CA",
  ];
  const quorum = 3;

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

  log(`MinFirstAllocationStrategy address: ${minFirstAllocationStrategyAddress}`);

  const libraries = {
    MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
  };

  const stakingRouterAddress = (
    await deployImplementation(Sk.stakingRouter, "StakingRouter", deployer, [DEPOSIT_CONTRACT_ADDRESS], { libraries })
  ).address;

  log(`StakingRouter implementation address: ${stakingRouterAddress}`);

  const appNodeOperatorsRegistry = (
    await deployImplementation(Sk.appNodeOperatorsRegistry, "NodeOperatorsRegistry", deployer, [], { libraries })
  ).address;

  log(`NodeOperatorsRegistry address implementation: ${appNodeOperatorsRegistry}`);

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

  log(`New DSM address: ${depositSecurityModuleAddress}`);

  const dsmContract = await loadContract<DepositSecurityModule>(
    DepositSecurityModule__factory,
    depositSecurityModuleAddress,
  );
  await dsmContract.addGuardians(guardians, quorum);

  await dsmContract.setOwner(APP_AGENT_ADDRESS);

  log(`Guardians list: ${await dsmContract.getGuardians()}, quorum ${await dsmContract.getGuardianQuorum()}`);

  const accountingOracleArgs = [LOCATOR, LIDO, LEGACY_ORACLE, SECONDS_PER_SLOT, GENESIS_TIME];

  const accountingOracleAddress = (
    await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, accountingOracleArgs)
  ).address;

  log(`AO implementation address: ${accountingOracleAddress}`);

  const oracleReportSanityCheckerArgs = [LOCATOR, SC_ADMIN, LIMITS, MANAGERS_ROSTER];

  const oracleReportSanityCheckerAddress = (
    await deployWithoutProxy(
      Sk.oracleReportSanityChecker,
      "OracleReportSanityChecker",
      deployer,
      oracleReportSanityCheckerArgs,
    )
  ).address;

  log(`OracleReportSanityChecker new address ${oracleReportSanityCheckerAddress}`);

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

  log(`Locator implementation address ${locatorAddress}`);

  // verification part

  log("sleep before starting verification of contracts...");
  await sleep(10_000);
  log("start verification of contracts...");

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
