import { assert } from "chai";
import { isAddress } from "ethers";

import type { LidoLocator } from "typechain-types/index.js";

import {
  deployImplementation,
  getDeployerSigner,
  loadContract,
  type LoadedContract,
  log,
  readNetworkState,
  Sk,
} from "#lib";

const VIEW_NAMES_AND_CTOR_ARGS = [
  "accountingOracle",
  "depositSecurityModule",
  "elRewardsVault",
  "lido",
  "oracleReportSanityChecker",
  "postTokenRebaseReceiver",
  "burner",
  "stakingRouter",
  "treasury",
  "validatorsExitBusOracle",
  "withdrawalQueue",
  "withdrawalVault",
  "oracleDaemonConfig",
];

const g_newAddresses: { [key: string]: string } = {};

async function getNewFromEnvOrCurrent(name: string, locator: LoadedContract<LidoLocator>): Promise<string> {
  const valueFromEnv = process.env[name];
  if (valueFromEnv) {
    if (!isAddress(valueFromEnv)) {
      log.error(`Value ${valueFromEnv} of ${name} is not an address`);
      process.exit(1);
    }
    g_newAddresses[name] = valueFromEnv;
    return valueFromEnv;
  }
  return await locator.getFunction(name).staticCall();
}

async function getConstructorArgs(locator: LoadedContract<LidoLocator>): Promise<string[]> {
  return await Promise.all(VIEW_NAMES_AND_CTOR_ARGS.map((name) => getNewFromEnvOrCurrent(name, locator)));
}

async function deployNewLocator(deployer: string, ctorArgs: string[]): Promise<LoadedContract> {
  return await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [ctorArgs]);
}

async function verifyConstructorArgs(newLocator: LoadedContract, locator: LoadedContract<LidoLocator>): Promise<void> {
  for (const viewName of VIEW_NAMES_AND_CTOR_ARGS) {
    const actual = await newLocator.getFunction(viewName).staticCall();
    assert.equal(actual, await getNewFromEnvOrCurrent(viewName, locator));
  }
}

export async function main(): Promise<void> {
  const deployer = (await getDeployerSigner()).address;
  assert.equal(process.env.DEPLOYER, deployer);

  const state = readNetworkState();
  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

  const ctorArgs = await getConstructorArgs(locator);
  if (Object.keys(g_newAddresses).length === 0) {
    log(`No new addresses specified: exiting doing nothing`);
    process.exit(0);
  }

  for (const name in g_newAddresses) {
    log.warning(`"${name}" new address: ${g_newAddresses[name]}`);
  }

  const newLocator = await deployNewLocator(deployer, ctorArgs);
  await verifyConstructorArgs(newLocator, locator);
}
