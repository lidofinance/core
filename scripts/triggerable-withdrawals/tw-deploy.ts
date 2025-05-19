import * as dotenv from "dotenv";
import { ethers } from "hardhat";
import { join } from "path";

import { LidoLocator } from "typechain-types";

import { cy, deployImplementation, loadContract, log, persistNetworkState, readNetworkState, Sk } from "lib";

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

async function main() {
  const deployer = ethers.getAddress(getEnvVariable("DEPLOYER"));
  const chainId = (await ethers.provider.getNetwork()).chainId;

  log(cy(`Deploy of contracts on chain ${chainId}`));

  const state = readNetworkState();
  persistNetworkState(state);

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

  const withdrawalVaultArgs = [LIDO_PROXY, TREASURY_PROXY];

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

  const DEPOSIT_CONTRACT_ADDRESS = state[Sk.chainSpec].depositContract;
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
    "0x0000000000000000000000000000000000000000000000000096000000000028", // GIndex gIFirstValidatorPrev,
    "0x0000000000000000000000000000000000000000000000000096000000000028", // GIndex gIFirstValidatorCurr,
    "0x0000000000000000000000000000000000000000000000000000000000005b00", // GIndex gIHistoricalSummariesPrev,
    "0x0000000000000000000000000000000000000000000000000000000000005b00", // GIndex gIHistoricalSummariesCurr,
    1, // uint64 firstSupportedSlot,
    1, // uint64 pivotSlot,
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

  const triggerableWithdrawalsGateway = await deployImplementation(
    Sk.triggerableWithdrawalsGateway,
    "triggerableWithdrawalsGateway",
    deployer,
    [deployer, locator.address],
  );
  log.success(`TriggerableWithdrawalsGateway implementation address: ${triggerableWithdrawalsGateway.address}`);
  log.emptyLine();

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
VALIDATORS_EXIT_BUS_ORACLE_IMPL = "${validatorsExitBusOracle.address}"
WITHDRAWAL_VAULT_IMPL = "${withdrawalVault.address}"
STAKING_ROUTER_IMPL = "${stakingRouterAddress.address}"
NODE_OPERATORS_REGISTRY_IMPL = "${NOR.address}"
VALIDATOR_EXIT_VERIFIER = "${validatorExitDelayVerifier.address}"
TRIGGERABLE_WITHDRAWALS_GATEWAY = "${triggerableWithdrawalsGateway.address}"
`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
