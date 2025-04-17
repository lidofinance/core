// Deploy StakingRouter 1.5 to Sepolia

import { assert } from "chai";
import { ethers, run } from "hardhat";

import { deployContract, deployImplementation, deployWithoutProxy, log, readNetworkState, Sk } from "lib";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;
  assert.equal(process.env.DEPLOYER, deployer);

  const state = readNetworkState();

  const DEPOSIT_CONTRACT_ADDRESS = state[Sk.chainSpec].depositContract;
  const APP_AGENT_ADDRESS = state[Sk.appAgent].proxy.address;
  const DEPOSIT_SECURITY_MODULE = state[Sk.deployer];
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

  log(`Deploying StakingRouter`, DEPOSIT_CONTRACT_ADDRESS);
  const stakingRouter = await deployContract("StakingRouter", [DEPOSIT_CONTRACT_ADDRESS], deployer, true, {
    libraries,
  });

  console.log(`StakingRouter deployed to ${stakingRouter.address}`);

  const appNodeOperatorsRegistry = (
    await deployImplementation(Sk.appNodeOperatorsRegistry, "NodeOperatorsRegistry", deployer, [], { libraries })
  ).address;

  log(`NodeOperatorsRegistry address implementation: ${appNodeOperatorsRegistry}`);

  const SECONDS_PER_SLOT = 12;
  const GENESIS_TIME = 1655733600;

  const accountingOracleArgs = [LOCATOR, LIDO, LEGACY_ORACLE, SECONDS_PER_SLOT, GENESIS_TIME];

  const accountingOracleAddress = (
    await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, accountingOracleArgs)
  ).address;

  log(`AO implementation address: ${accountingOracleAddress}`);

  const LIMITS = [1500, 0, 1000, 250, 2000, 100, 100, 128, 5000000, 1000, 101, 74];

  const oracleReportSanityCheckerArgs = [LOCATOR, SC_ADMIN, LIMITS];

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
      DEPOSIT_SECURITY_MODULE,
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

  log("sleep before starting verification of contracts...");
  await sleep(10_000);
  log("start verification of contracts...");

  await run("verify:verify", {
    address: minFirstAllocationStrategyAddress,
    constructorArguments: [],
    contract: "contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy",
  });

  await run("verify:verify", {
    address: stakingRouter.address,
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
