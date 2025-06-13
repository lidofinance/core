import * as dotenv from "dotenv";
import { ethers } from "hardhat";
import { join } from "path";

import { LidoLocator } from "typechain-types";

import { cy, deployImplementation, loadContract, log, persistNetworkState, readNetworkState, Sk } from "lib";

dotenv.config({ path: join(__dirname, "../../.env") });

//--------------------------------------------------------------------------
// Constants
//--------------------------------------------------------------------------

// Consensus‑spec constants
const SECONDS_PER_SLOT = 12;
const SLOTS_PER_EPOCH = 32;
const SHARD_COMMITTEE_PERIOD_SLOTS = 2 ** 8 * SLOTS_PER_EPOCH; // 8192

// G‑indices (phase0 spec)
const VALIDATOR_PREV_GINDEX = "0x0000000000000000000000000000000000000000000000000096000000000028";
const VALIDATOR_CURR_GINDEX = VALIDATOR_PREV_GINDEX;
const HISTORICAL_SUMMARIES_PREV_GINDEX = "0x0000000000000000000000000000000000000000000000000000000000005b00";
const HISTORICAL_SUMMARIES_CURR_GINDEX = HISTORICAL_SUMMARIES_PREV_GINDEX;

// TriggerableWithdrawalsGateway params
const TRIGGERABLE_WITHDRAWALS_GAS_LIMIT = 13_000;
const TRIGGERABLE_WITHDRAWALS_MIN_PRIORITY_FEE = 1; // wei
const TRIGGERABLE_WITHDRAWALS_MAX_VALIDATORS = 48;

//--------------------------------------------------------------------------
// Helpers
//--------------------------------------------------------------------------

function requireEnv(variable: string): string {
  const value = process.env[variable];
  if (!value) throw new Error(`Environment variable ${variable} is not set`);
  log(`Using env variable ${variable}=${value}`);
  return value;
}

//--------------------------------------------------------------------------
// Main
//--------------------------------------------------------------------------

async function main(): Promise<void> {
  // -----------------------------------------------------------------------
  // Environment & chain context
  // -----------------------------------------------------------------------
  const deployer = ethers.getAddress(requireEnv("DEPLOYER"));
  const genesisTime = parseInt(requireEnv("GENESIS_TIME"), 10);

  const { chainId } = await ethers.provider.getNetwork();
  log(cy(`Deploying contracts on chain ${chainId}`));

  // -----------------------------------------------------------------------
  // State & configuration
  // -----------------------------------------------------------------------
  const state = readNetworkState();
  persistNetworkState(state);

  const chainSpec = state[Sk.chainSpec];
  log(`Chain spec: ${JSON.stringify(chainSpec, null, 2)}`);

  const agent = state["app:aragon-agent"].proxy.address;
  log(`Using agent: ${agent}`);

  const locator = await loadContract<LidoLocator>("LidoLocator", state[Sk.lidoLocator].proxy.address);

  // -----------------------------------------------------------------------
  // Deployments
  // -----------------------------------------------------------------------

  // 1. ValidatorsExitBusOracle
  const validatorsExitBusOracle = await deployImplementation(
    Sk.validatorsExitBusOracle,
    "ValidatorsExitBusOracle",
    deployer,
    [SECONDS_PER_SLOT, genesisTime, locator.address],
  );
  log.success(`ValidatorsExitBusOracle: ${validatorsExitBusOracle.address}`);

  // 2. TriggerableWithdrawalsGateway
  const triggerableWithdrawalsGateway = await deployImplementation(
    Sk.triggerableWithdrawalsGateway,
    "TriggerableWithdrawalsGateway",
    deployer,
    [
      agent,
      locator.address,
      TRIGGERABLE_WITHDRAWALS_GAS_LIMIT,
      TRIGGERABLE_WITHDRAWALS_MIN_PRIORITY_FEE,
      TRIGGERABLE_WITHDRAWALS_MAX_VALIDATORS,
    ],
  );
  log.success(`TriggerableWithdrawalsGateway: ${triggerableWithdrawalsGateway.address}`);

  // 3. WithdrawalVault
  const withdrawalVault = await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, [
    await locator.lido(),
    await locator.treasury(),
    triggerableWithdrawalsGateway.address,
  ]);
  log.success(`WithdrawalVault: ${withdrawalVault.address}`);

  // -----------------------------------------------------------------------
  // Shared libraries
  // -----------------------------------------------------------------------
  const minFirstAllocationStrategyAddress = state[Sk.minFirstAllocationStrategy].address;
  const libraries = {
    MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
  } as const;

  // 4. StakingRouter
  const stakingRouter = await deployImplementation(
    Sk.stakingRouter,
    "StakingRouter",
    deployer,
    [chainSpec.depositContractAddress],
    { libraries },
  );
  log.success(`StakingRouter: ${stakingRouter.address}`);

  // 5. NodeOperatorsRegistry
  const nor = await deployImplementation(Sk.appNodeOperatorsRegistry, "NodeOperatorsRegistry", deployer, [], {
    libraries,
  });
  log.success(`NodeOperatorsRegistry: ${nor.address}`);

  // 6. ValidatorExitDelayVerifier
  const validatorExitDelayVerifier = await deployImplementation(
    Sk.validatorExitDelayVerifier,
    "ValidatorExitDelayVerifier",
    deployer,
    [
      locator.address,
      VALIDATOR_PREV_GINDEX,
      VALIDATOR_CURR_GINDEX,
      HISTORICAL_SUMMARIES_PREV_GINDEX,
      HISTORICAL_SUMMARIES_CURR_GINDEX,
      1, // firstSupportedSlot
      1, // pivotSlot
      SLOTS_PER_EPOCH,
      SECONDS_PER_SLOT,
      genesisTime,
      SHARD_COMMITTEE_PERIOD_SLOTS * SECONDS_PER_SLOT, // seconds
    ],
  );
  log.success(`ValidatorExitDelayVerifier: ${validatorExitDelayVerifier.address}`);

  // 7. AccountingOracle
  const accountingOracle = await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, [
    locator.address,
    await locator.lido(),
    await locator.legacyOracle(),
    Number(chainSpec.secondsPerSlot),
    Number(chainSpec.genesisTime),
  ]);
  log.success(`AccountingOracle: ${accountingOracle.address}`);

  // -----------------------------------------------------------------------
  // New LidoLocator (all addresses consolidated)
  // -----------------------------------------------------------------------
  const locatorConfig = [
    await locator.accountingOracle(),
    await locator.depositSecurityModule(),
    await locator.elRewardsVault(),
    await locator.legacyOracle(),
    await locator.lido(),
    await locator.oracleReportSanityChecker(),
    await locator.postTokenRebaseReceiver(),
    await locator.burner(),
    stakingRouter.address,
    await locator.treasury(),
    validatorsExitBusOracle.address,
    await locator.withdrawalQueue(),
    withdrawalVault.address,
    await locator.oracleDaemonConfig(),
    validatorExitDelayVerifier.address,
    triggerableWithdrawalsGateway.address,
  ];

  const newLocator = await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [locatorConfig]);
  log.success(`LidoLocator: ${newLocator.address}`);

  // -----------------------------------------------------------------------
  // Governance summary
  // -----------------------------------------------------------------------
  log.emptyLine();
  log(`Configuration for governance script:`);
  log.emptyLine();
  log(`LIDO_LOCATOR_IMPL = "${newLocator.address}"`);
  log(`ACCOUNTING_ORACLE_IMPL = "${accountingOracle.address}"`);
  log(`VALIDATORS_EXIT_BUS_ORACLE_IMPL = "${validatorsExitBusOracle.address}"`);
  log(`WITHDRAWAL_VAULT_IMPL = "${withdrawalVault.address}"`);
  log(`STAKING_ROUTER_IMPL = "${stakingRouter.address}"`);
  log(`NODE_OPERATORS_REGISTRY_IMPL = "${nor.address}"`);
  log(`VALIDATOR_EXIT_DELAY_VERIFIER_IMPL = "${validatorExitDelayVerifier.address}"`);
  log(`TRIGGERABLE_WITHDRAWALS_GATEWAY_IMPL = "${triggerableWithdrawalsGateway.address}"\n`);
  log.emptyLine();
}

main().catch((error) => {
  log.error(error);
  process.exitCode = 1;
});
