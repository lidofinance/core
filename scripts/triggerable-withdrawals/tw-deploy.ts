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

  const validatorsExitBusOracle = (
    await deployImplementation(
      Sk.validatorsExitBusOracle,
      "ValidatorsExitBusOracle",
      deployer,
      validatorsExitBusOracleArgs,
    )
  ).address;
  log.success(`ValidatorsExitBusOracle address: ${validatorsExitBusOracle}`);
  log.emptyLine();

  const withdrawalVaultArgs = [LIDO_PROXY, TREASURY_PROXY];

  const withdrawalVault = (
    await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, withdrawalVaultArgs)
  ).address;
  log.success(`WithdrawalVault address implementation: ${withdrawalVault}`);

  const minFirstAllocationStrategyAddress = state[Sk.minFirstAllocationStrategy].address;
  const libraries = {
    MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
  };

  const DEPOSIT_CONTRACT_ADDRESS = state[Sk.chainSpec].depositContract;
  log(`Deposit contract address: ${DEPOSIT_CONTRACT_ADDRESS}`);
  const stakingRouterAddress = (
    await deployImplementation(Sk.stakingRouter, "StakingRouter", deployer, [DEPOSIT_CONTRACT_ADDRESS], { libraries })
  ).address;

  log(`StakingRouter implementation address: ${stakingRouterAddress}`);

  const NOR = await deployImplementation(Sk.appNodeOperatorsRegistry, "NodeOperatorsRegistry", deployer, [], {
    libraries,
  });

  log.success(`NOR implementation address: ${NOR.address}`);

  log.emptyLine();

  log(`Configuration for voting script:`);
  log(`VALIDATORS_EXIT_BUS_ORACLE_IMPL = "${validatorsExitBusOracle}"
WITHDRAWAL_VAULT_IMPL = "${withdrawalVault}"
STAKING_ROUTER_IMPL = "${stakingRouterAddress}"
NODE_OPERATORS_REGISTRY_IMPL = "${NOR.address}"`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
