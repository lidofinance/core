import * as dotenv from "dotenv";
import { ethers } from "hardhat";
import { join } from "path";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { LidoLocator } from "typechain-types";

import { cy, deployImplementation, deployWithoutProxy, loadContract, log, persistNetworkState, readNetworkState, Sk } from "lib";

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

// Must comply with the specification
// https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#time-parameters-1
const SECONDS_PER_SLOT = 12;

// Must match the beacon chain genesis_time: https://beaconstate-mainnet.chainsafe.io/eth/v1/beacon/genesis
// and the current value: https://etherscan.io/address/0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb
const genesisTime = parseInt(getEnvVariable("GENESIS_TIME"));

export async function main() {
  const deployer = ethers.getAddress(getEnvVariable("DEPLOYER"));
  const chainId = (await ethers.provider.getNetwork()).chainId;

  log(cy(`Deploy of contracts on chain ${chainId}`));

  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  persistNetworkState(state);

  const chainSpec = state[Sk.chainSpec];

  log(`Chain spec: ${JSON.stringify(chainSpec, null, 2)}`);

  const agent = state["app:aragon-agent"].proxy.address;
  log(`Using agent: ${agent}`);
  // Read contracts addresses from config
  const locator = await loadContract<LidoLocator>("LidoLocator", state[Sk.lidoLocator].proxy.address);

  const LIDO_PROXY = await locator.lido();
  const TREASURY_PROXY = await locator.treasury();

  // Deploy ValidatorExitBusOracle
  // uint256 secondsPerSlot, uint256 genesisTime, address lidoLocator
  const validatorsExitBusOracleArgs = [SECONDS_PER_SLOT, genesisTime, locator.address];

  const validatorsExitBusOracle = await deployImplementation(
    Sk.validatorsExitBusOracle,
    "ValidatorsExitBusOracle",
    deployer,
    validatorsExitBusOracleArgs,
  );
  log.success(`ValidatorsExitBusOracle address: ${validatorsExitBusOracle.address}`);
  log.emptyLine();

  const triggerableWithdrawalsGateway = await deployImplementation(
    Sk.triggerableWithdrawalsGateway,
    "TriggerableWithdrawalsGateway",
    deployer,
    [agent, locator.address, 13000, 1, 48],
  );
  log.success(`TriggerableWithdrawalsGateway implementation address: ${triggerableWithdrawalsGateway.address}`);
  log.emptyLine();

  const withdrawalVaultArgs = [LIDO_PROXY, TREASURY_PROXY, triggerableWithdrawalsGateway.address];

  const withdrawalVault = await deployImplementation(
    Sk.withdrawalVault,
    "WithdrawalVault",
    deployer,
    withdrawalVaultArgs,
  );
  log.success(`WithdrawalVault address implementation: ${withdrawalVault.address}`);

  const minFirstAllocationStrategyAddress = state[Sk.minFirstAllocationStrategy].address;
  const libraries = {
    MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
  };

  const DEPOSIT_CONTRACT_ADDRESS = parameters[Sk.chainSpec].depositContract;
  log(`Deposit contract address: ${DEPOSIT_CONTRACT_ADDRESS}`);
  const stakingRouterAddress = await deployImplementation(
    Sk.stakingRouter,
    "StakingRouter",
    deployer,
    [DEPOSIT_CONTRACT_ADDRESS],
    { libraries },
  );

  log(`StakingRouter implementation address: ${stakingRouterAddress.address}`);

  const NOR = await deployImplementation(Sk.appNodeOperatorsRegistry, "NodeOperatorsRegistry", deployer, [], {
    libraries,
  });

  log.success(`NOR implementation address: ${NOR.address}`);
  log.emptyLine();

  const validatorExitDelayVerifierArgs = [
    locator.address,
    {
      gIFirstValidatorPrev: "0x0000000000000000000000000000000000000000000000000096000000000028",
      gIFirstValidatorCurr: "0x0000000000000000000000000000000000000000000000000096000000000028", 
      gIFirstHistoricalSummaryPrev: "0x000000000000000000000000000000000000000000000000000000b600000018",
      gIFirstHistoricalSummaryCurr: "0x000000000000000000000000000000000000000000000000000000b600000018",
      gIFirstBlockRootInSummaryPrev: "0x000000000000000000000000000000000000000000000000000000000040000d",
      gIFirstBlockRootInSummaryCurr: "0x000000000000000000000000000000000000000000000000000000000040000d"
    }, // GIndices struct
    22140000, // uint64 firstSupportedSlot, same as test data
    22140000, // uint64 pivotSlot, same as test data  
    22140000, // uint64 capellaSlot, same as test data
    8192, // uint64 slotsPerHistoricalRoot,
    32, // uint32 slotsPerEpoch,
    12, // uint32 secondsPerSlot,
    genesisTime, // uint64 genesisTime,
    2 ** 8 * 32 * 12, // uint32 shardCommitteePeriodInSeconds
  ];

  const validatorExitDelayVerifier = await deployImplementation(
    Sk.validatorExitDelayVerifier,
    "ValidatorExitDelayVerifier",
    deployer,
    validatorExitDelayVerifierArgs,
  );
  log.success(`ValidatorExitDelayVerifier implementation address: ${validatorExitDelayVerifier.address}`);
  log.emptyLine();

  const accountingOracle = await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, [
    locator.address,
    await locator.lido(),
    await locator.legacyOracle(),
    Number(chainSpec.secondsPerSlot),
    Number(chainSpec.genesisTime),
  ]);

  // fetch contract addresses that will not changed
  const locatorConfig = [
    await locator.accountingOracle(),
    await locator.depositSecurityModule(),
    await locator.elRewardsVault(),
    await locator.legacyOracle(),
    await locator.lido(),
    await locator.oracleReportSanityChecker(),
    await locator.postTokenRebaseReceiver(),
    await locator.burner(),
    await locator.stakingRouter(),
    await locator.treasury(),
    await locator.validatorsExitBusOracle(),
    await locator.withdrawalQueue(),
    await locator.withdrawalVault(),
    await locator.oracleDaemonConfig(),
    validatorExitDelayVerifier.address,
    triggerableWithdrawalsGateway.address,
  ];

  const lidoLocator = await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [locatorConfig]);

  log(`Configuration for voting script:`);
  log(`
LIDO_LOCATOR_IMPL = "${lidoLocator.address}"
ACCOUNTING_ORACLE = "${accountingOracle.address}"
VALIDATORS_EXIT_BUS_ORACLE_IMPL = "${validatorsExitBusOracle.address}"
WITHDRAWAL_VAULT_IMPL = "${withdrawalVault.address}"
STAKING_ROUTER_IMPL = "${stakingRouterAddress.address}"
NODE_OPERATORS_REGISTRY_IMPL = "${NOR.address}"
VALIDATOR_EXIT_VERIFIER = "${validatorExitDelayVerifier.address}"
TRIGGERABLE_WITHDRAWALS_GATEWAY = "${triggerableWithdrawalsGateway.address}"
`);
  await deployWithoutProxy(Sk.TWVoteScript, "TWVoteScript", deployer, [
    state[Sk.appVoting].proxy.address,
    state[Sk.dgDualGovernance].proxy.address,
    {
      // Contract addresses
      agent: agent,
      lido_locator: state[Sk.lidoLocator].proxy.address,
      lido_locator_impl: lidoLocator.address,
      validators_exit_bus_oracle: await locator.validatorsExitBusOracle(),
      validators_exit_bus_oracle_impl: validatorsExitBusOracle.address,
      triggerable_withdrawals_gateway: triggerableWithdrawalsGateway.address,
      withdrawal_vault: await locator.withdrawalVault(),
      withdrawal_vault_impl: withdrawalVault.address,
      accounting_oracle: await locator.accountingOracle(),
      accounting_oracle_impl: accountingOracle.address,
      staking_router: await locator.stakingRouter(),
      staking_router_impl: stakingRouterAddress.address,
      validator_exit_verifier: validatorExitDelayVerifier.address,
      node_operators_registry: state[Sk.appNodeOperatorsRegistry].proxy.address,
      node_operators_registry_impl: NOR.address,
      oracle_daemon_config: await locator.oracleDaemonConfig(),
      simple_dvt: state[Sk.appSimpleDvt].proxy.address,

      // Other parameters
      node_operators_registry_app_id: state[Sk.appNodeOperatorsRegistry].aragonApp.id,
      simple_dvt_app_id: state[Sk.appSimpleDvt].aragonApp.id,
      nor_version: [6, 0, 0],
      vebo_consensus_version: 4,
      ao_consensus_version: 4,
      nor_exit_deadline_in_sec: 30 * 60, // 30 minutes
      exit_events_lookback_window_in_slots: 7200,
      nor_content_uri: state[Sk.appNodeOperatorsRegistry].aragonApp.contentURI,
    },
  ]);
}
