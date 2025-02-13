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
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
