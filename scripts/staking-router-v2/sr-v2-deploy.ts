import * as dotenv from "dotenv";
import { ethers, run } from "hardhat";
import { join } from "path";
import readline from "readline";

import {
  DepositSecurityModule,
  DepositSecurityModule__factory,
  LidoLocator,
  LidoLocator__factory,
} from "typechain-types";

import {
  cy,
  deployImplementation,
  deployWithoutProxy,
  loadContract,
  log,
  persistNetworkState,
  rd,
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

/* Accounting Oracle args */

// Must comply with the specification
// https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#time-parameters-1
const SECONDS_PER_SLOT = 12;

// Must match the beacon chain genesis_time: https://beaconstate-mainnet.chainsafe.io/eth/v1/beacon/genesis
// and the current value: https://etherscan.io/address/0x852deD011285fe67063a08005c71a85690503Cee#readProxyContract#F6
const GENESIS_TIME = 1606824023;

/* Oracle report sanity checker */

// Defines the maximum number of validators that may be reported as "exited"
// per day, depending on the consensus layer churn limit.
//
// CURRENT_ACTIVE_VALIDATORS_NUMBER = ~1100000 // https://beaconcha.in/
// CURRENT_EXIT_CHURN_LIMIT = 16 // https://www.validatorqueue.com/
// EPOCHS_PER_DAY = 225 // (24 * 60 * 60) sec / 12 sec per slot / 32 slots per epoch
//
// https://github.com/ethereum/consensus-specs/blob/dev/specs/deneb/beacon-chain.md#validator-cycle
// MAX_PER_EPOCH_ACTIVATION_CHURN_LIMIT = 8
//
// MAX_VALIDATORS_PER_DAY = EPOCHS_PER_DAY * MAX_PER_EPOCH_ACTIVATION_CHURN_LIMIT = 1800 // 225 * 8
// MAX_VALIDATORS_AFTER_TWO_YEARS = MAX_VALIDATORS_PER_DAY * 365 * 2 + CURRENT_VALIDATORS_NUMBER // 1100000 + (1800 * 365 * 2) = ~2500000
//
// https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#validator-cycle
// CHURN_LIMIT_QUOTIENT = 65536
//
// https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#get_validator_churn_limit
// MAX_EXIT_CHURN_LIMIT_AFTER_TWO_YEARS = MAX_VALIDATORS_AFTER_TWO_YEARS / CHURN_LIMIT_QUOTIENT // 2500000 / 65536 = ~38
// EXITED_VALIDATORS_PER_DAY_LIMIT = MAX_EXIT_CHURN_LIMIT_AFTER_TWO_YEARS * EPOCHS_PER_DAY // 38 * 225 = 8550 = ~9000
const EXITED_VALIDATORS_PER_DAY_LIMIT = 9000;

// Defines the maximum number of validators that can be reported as "appeared"
// in a single day, limited by the maximum daily deposits via DSM
//
// BLOCKS_PER_DAY = (24 * 60 * 60) / 12 = 7200
// MAX_DEPOSITS_PER_BLOCK = 150
// MIN_DEPOSIT_BLOCK_DISTANCE = 25
//
// APPEARED_VALIDATORS_PER_DAY_LIMIT = BLOCKS_PER_DAY / MIN_DEPOSIT_BLOCK_DISTANCE * MAX_DEPOSITS_PER_BLOCK = 43200
// Current limits: https://etherscan.io/address/0xC77F8768774E1c9244BEed705C4354f2113CFc09#readContract#F10
//                 https://etherscan.io/address/0xC77F8768774E1c9244BEed705C4354f2113CFc09#readContract#F11
// The proposed limits remain unchanged for curated modules and reduced for CSM
const APPEARED_VALIDATORS_PER_DAY_LIMIT = 43200;

// Must match the current value https://docs.lido.fi/guides/verify-lido-v2-upgrade-manual/#oraclereportsanitychecker
const ANNUAL_BALANCE_INCREASE_BP_LIMIT = 1000;
const SIMULATED_SHARE_RATE_DEVIATION_BP_LIMIT = 50;
const MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT = 600;

// The optimal number of items is greater than 6 (2 items for stuck or exited keys per 3 modules) to ensure
// a small report can fit into a single transaction. However, there is additional capacity in case a module
// requires more than 2 items. Hence, the limit of 8 items per report was chosen.
const MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION = 8;

// This parameter defines the maximum number of node operators that can be reported per extra data list item.
// Gas consumption for updating a single node operator:
//
// - CSM:
//   Average: ~16,650 gas
//   Max: ~41,150 gas (in cases with unstuck keys under specific conditions)
// - Curated-based: ~15,500 gas
//
// Each transaction can contain up to 8 items, and each item is limited to a maximum of 1,000,000 gas.
// Thus, the total gas consumption per transaction remains within 8,000,000 gas.
// Using the higher value of CSM (41,150 gas), the calculation is as follows:
//
// Operators per item: 1,000,000 / 41,150 = 24.3
// Thus, the limit was set at 24 operators per item.
const MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM = 24;

// Must match the current value https://docs.lido.fi/guides/verify-lido-v2-upgrade-manual/#oraclereportsanitychecker
const REQUEST_TIMESTAMP_MARGIN = 7680;
const MAX_POSITIVE_TOKEN_REBASE = 750000;

// Must match the value in LIP-23 https://github.com/lidofinance/lido-improvement-proposals/blob/develop/LIPS/lip-23.md
// and the proposed number on the research forum https://research.lido.fi/t/staking-router-community-staking-module-upgrade-announcement/8612
const INITIAL_SLASHING_AMOUNT_P_WEI = 1000;
const INACTIVITY_PENALTIES_AMOUNT_P_WEI = 101;

// Must match the proposed number on the research forum https://research.lido.fi/t/staking-router-community-staking-module-upgrade-announcement/8612
const CL_BALANCE_ORACLES_ERROR_UPPER_BP_LIMIT = 50;

const LIMITS = [
  EXITED_VALIDATORS_PER_DAY_LIMIT,
  APPEARED_VALIDATORS_PER_DAY_LIMIT,
  ANNUAL_BALANCE_INCREASE_BP_LIMIT,
  SIMULATED_SHARE_RATE_DEVIATION_BP_LIMIT,
  MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT,
  MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION,
  MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM,
  REQUEST_TIMESTAMP_MARGIN,
  MAX_POSITIVE_TOKEN_REBASE,
  INITIAL_SLASHING_AMOUNT_P_WEI,
  INACTIVITY_PENALTIES_AMOUNT_P_WEI,
  CL_BALANCE_ORACLES_ERROR_UPPER_BP_LIMIT,
];

/* DSM args */

// Must match the current value https://etherscan.io/address/0xC77F8768774E1c9244BEed705C4354f2113CFc09#readContract#F13
const PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS = 6646;

// Unvetting a single operator requires approximately 20,000 gas. Thus, the maximum number of operators per unvetting
// is defined as 200 to keep the maximum transaction cost below 4,000,000 gas.
const MAX_OPERATORS_PER_UNVETTING = 200;

// Must match the current list https://etherscan.io/address/0xC77F8768774E1c9244BEed705C4354f2113CFc09#readContract#F9
const GUARDIANS = [
  "0x5fd0dDbC3351d009eb3f88DE7Cd081a614C519F1",
  "0x7912Fa976BcDe9c2cf728e213e892AD7588E6AaF",
  "0x14D5d5B71E048d2D75a39FfC5B407e3a3AB6F314",
  "0xf82D88217C249297C6037BA77CE34b3d8a90ab43",
  "0xa56b128Ea2Ea237052b0fA2a96a387C0E43157d8",
  "0xd4EF84b638B334699bcf5AF4B0410B8CCD71943f",
];

// Must match the current value https://etherscan.io/address/0xC77F8768774E1c9244BEed705C4354f2113CFc09#readContract#F8
const QUORUM = 4;

// stETH on Optimism is going to change the locator implementation
// on October 11th after SRv2 deployment but before SRv2 voting
//
// We're taking the proposed implementation of the upcoming upgrade
// to make sure that these changes make it into our deployment
//
// Must match the proposed locator impl in the docs: https://docs.lido.fi/deployed-contracts/
const INTERMEDIATE_LOCATOR_IMPL = "0x39aFE23cE59e8Ef196b81F0DCb165E9aD38b9463";

async function main() {
  const deployer = ethers.getAddress(getEnvVariable("DEPLOYER"));
  const chainId = (await ethers.provider.getNetwork()).chainId;

  if (chainId !== 1n) {
    log(rd(`Expected mainnet, got chain id ${chainId}`));
    return;
  }

  log(cy(`Deploy of contracts on chain ${chainId}`));

  const state = readNetworkState();
  persistNetworkState(state);

  // Read contracts addresses from config
  const DEPOSIT_CONTRACT_ADDRESS = state[Sk.chainSpec].depositContractAddress;
  const APP_AGENT_ADDRESS = state[Sk.appAgent].proxy.address;
  const SC_ADMIN = APP_AGENT_ADDRESS;
  const LOCATOR = state[Sk.lidoLocator].proxy.address;

  const locatorImplContract = await loadContract<LidoLocator>(LidoLocator__factory, INTERMEDIATE_LOCATOR_IMPL);
  // fetch contract addresses that will not changed
  const ACCOUNTING_ORACLE_PROXY = await locatorImplContract.accountingOracle();
  const EL_REWARDS_VAULT = await locatorImplContract.elRewardsVault();
  const LEGACY_ORACLE = await locatorImplContract.legacyOracle();
  const LIDO = await locatorImplContract.lido();
  const POST_TOKEN_REBASE_RECEIVER = await locatorImplContract.postTokenRebaseReceiver();
  const BURNER = await locatorImplContract.burner();
  const STAKING_ROUTER = await locatorImplContract.stakingRouter();
  const TREASURY_ADDRESS = await locatorImplContract.treasury();
  const VEBO = await locatorImplContract.validatorsExitBusOracle();
  const WQ = await locatorImplContract.withdrawalQueue();
  const WITHDRAWAL_VAULT = await locatorImplContract.withdrawalVault();
  const ORACLE_DAEMON_CONFIG = await locatorImplContract.oracleDaemonConfig();

  log.lineWithArguments(
    `Fetched addresses from locator impl ${INTERMEDIATE_LOCATOR_IMPL}, result: `,
    getLocatorAddressesToString(
      ACCOUNTING_ORACLE_PROXY,
      EL_REWARDS_VAULT,
      LEGACY_ORACLE,
      LIDO,
      POST_TOKEN_REBASE_RECEIVER,
      BURNER,
      STAKING_ROUTER,
      TREASURY_ADDRESS,
      VEBO,
      WQ,
      WITHDRAWAL_VAULT,
      ORACLE_DAEMON_CONFIG,
    ),
  );
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
  await dsmContract.addGuardians(GUARDIANS, QUORUM);
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
      POST_TOKEN_REBASE_RECEIVER,
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

function getLocatorAddressesToString(
  ACCOUNTING_ORACLE_PROXY: string,
  EL_REWARDS_VAULT: string,
  LEGACY_ORACLE: string,
  LIDO: string,
  POST_TOKEN_REBASE_RECEIVER: string,
  BURNER: string,
  STAKING_ROUTER: string,
  TREASURY_ADDRESS: string,
  VEBO: string,
  WQ: string,
  WITHDRAWAL_VAULT: string,
  ORACLE_DAEMON_CONFIG: string,
) {
  return [
    `ACCOUNTING_ORACLE_PROXY: ${ACCOUNTING_ORACLE_PROXY}`,
    `EL_REWARDS_VAULT: ${EL_REWARDS_VAULT}`,
    `LEGACY_ORACLE: ${LEGACY_ORACLE}`,
    `LIDO: ${LIDO}`,
    `POST_TOKEN_REBASE_RECEIVER: ${POST_TOKEN_REBASE_RECEIVER}`,
    `BURNER: ${BURNER}`,
    `STAKING_ROUTER: ${STAKING_ROUTER}`,
    `TREASURY_ADDRESS: ${TREASURY_ADDRESS}`,
    `VEBO: ${VEBO}`,
    `WQ: ${WQ}`,
    `WITHDRAWAL_VAULT: ${WITHDRAWAL_VAULT}`,
    `ORACLE_DAEMON_CONFIG: ${ORACLE_DAEMON_CONFIG}`,
  ];
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
