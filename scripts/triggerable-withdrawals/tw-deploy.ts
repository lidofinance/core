import * as dotenv from "dotenv";
import { ethers, run } from "hardhat";
import { join } from "path";
import readline from "readline";

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
  const validatorsExitBusOracleArgs = [SECONDS_PER_SLOT, genesisTime, locator];

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

  // Deploy WithdrawalVault
  const withdrawalVaultArgs = [LIDO_PROXY, TREASURY_PROXY];

  const withdrawalVault = (
    await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, withdrawalVaultArgs)
  ).address;
  log.success(`WithdrawalVault address implementation: ${withdrawalVault}`);
  log.emptyLine();

  // Deploy AO
  // const accountingOracleArgs = [LOCATOR, LIDO, LEGACY_ORACLE, SECONDS_PER_SLOT, GENESIS_TIME];
  // const accountingOracleAddress = (
  //   await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, accountingOracleArgs)
  // ).address;
  // log.success(`AO implementation address: ${accountingOracleAddress}`);
  // log.emptyLine();

  // await waitForPressButton();

  log(cy("Continuing..."));

  await run("verify:verify", {
    address: withdrawalVault,
    constructorArguments: withdrawalVaultArgs,
    contract: "contracts/0.8.9/WithdrawalVault.sol:WithdrawalVault",
  });

  await run("verify:verify", {
    address: validatorsExitBusOracle,
    constructorArguments: [],
    contract: "contracts/0.8.9/ValidatorsExitBusOracle.sol:ValidatorsExitBusOracle",
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
