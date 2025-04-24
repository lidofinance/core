import * as dotenv from "dotenv";
import { ethers, run } from "hardhat";
import { join } from "path";

import { LidoLocator } from "typechain-types";

import { cy, loadContract, log, persistNetworkState, readNetworkState, Sk } from "lib";

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
  const chainId = (await ethers.provider.getNetwork()).chainId;

  log(cy(`Deploy of contracts on chain ${chainId}`));

  const state = readNetworkState();
  persistNetworkState(state);

  // Read contracts addresses from config
  const locator = await loadContract<LidoLocator>("LidoLocator", state[Sk.lidoLocator].proxy.address);

  const LIDO_PROXY = await locator.lido();
  const TREASURY_PROXY = await locator.treasury();

  const validatorsExitBusOracleArgs = [SECONDS_PER_SLOT, genesisTime, locator.address];
  const withdrawalVaultArgs = [LIDO_PROXY, TREASURY_PROXY];
  const validatorExitVerifierArgs = [
    locator.address,
    "0x0000000000000000000000000000000000000000000000000096000000000028", // GIndex gIFirstValidatorPrev,
    "0x0000000000000000000000000000000000000000000000000096000000000028", // GIndex gIFirstValidatorCurr,
    "0x000000000000000000000000000000000000000000000000000000000161c004", // GIndex gIHistoricalSummariesPrev,
    "0x000000000000000000000000000000000000000000000000000000000161c004", // GIndex gIHistoricalSummariesCurr,
    1, // uint64 firstSupportedSlot,
    1, // uint64 pivotSlot,
    32, // uint32 slotsPerEpoch,
    12, // uint32 secondsPerSlot,
    genesisTime, // uint64 genesisTime,
    2 ** 8 * 32 * 12, // uint32 shardCommitteePeriodInSeconds
  ];

  await run("verify:verify", {
    address: state[Sk.withdrawalVault].implementation.address,
    constructorArguments: withdrawalVaultArgs,
    contract: "contracts/0.8.9/WithdrawalVault.sol:WithdrawalVault",
  });

  await run("verify:verify", {
    address: state[Sk.validatorsExitBusOracle].implementation.address,
    constructorArguments: validatorsExitBusOracleArgs,
    contract: "contracts/0.8.9/oracle/ValidatorsExitBusOracle.sol:ValidatorsExitBusOracle",
  });

  await run("verify:verify", {
    address: state[Sk.validatorExitVerifier].implementation.address,
    constructorArguments: validatorExitVerifierArgs,
    contract: "contracts/0.8.9/oracle/ValidatorsExitBusOracle.sol:ValidatorsExitBusOracle",
  });

  await run("verify:verify", {
    address: state[Sk.lidoLocator].implementation.address,
    constructorArguments: locatorConfig,
    contract: "contracts/0.8.9/LidoLocator.sol:LidoLocator",
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
