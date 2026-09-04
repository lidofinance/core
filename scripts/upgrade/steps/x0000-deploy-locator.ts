import { assert } from "chai";
import { getAddress, isAddress } from "ethers";

import type { LidoLocator } from "typechain-types/index.js";

import {
  deployImplementation,
  getDeployerSigner,
  type LoadedContract,
  loadContract,
  log,
  readNetworkState,
  Sk,
} from "#lib";
import { keysOf } from "#lib/protocol/types.js";

const LOCATOR_CONFIG_KEYS = keysOf<LidoLocator.ConfigStruct>()([
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
  "validatorExitDelayVerifier",
  "triggerableWithdrawalsGateway",
  "consolidationGateway",
  "accounting",
  "predepositGuarantee",
  "wstETH",
  "vaultHub",
  "vaultFactory",
  "lazyOracle",
  "operatorGrid",
  "topUpGateway",
]);

const g_newAddresses: Partial<Record<keyof LidoLocator.ConfigStruct, string>> = {};

async function getNewFromEnvOrCurrent(
  name: keyof LidoLocator.ConfigStruct,
  locator: LoadedContract<LidoLocator>,
): Promise<string> {
  const valueFromEnv = process.env[name];
  if (valueFromEnv) {
    if (!isAddress(valueFromEnv)) {
      throw new Error(`Value ${valueFromEnv} of ${name} is not an address`);
    }
    const address = getAddress(valueFromEnv);
    g_newAddresses[name] = address;
    return address;
  }
  return await locator.getFunction(name).staticCall();
}

async function getConstructorArgs(locator: LoadedContract<LidoLocator>): Promise<LidoLocator.ConfigStruct> {
  const addresses = await Promise.all(LOCATOR_CONFIG_KEYS.map((name) => getNewFromEnvOrCurrent(name, locator)));
  return Object.fromEntries(
    LOCATOR_CONFIG_KEYS.map((name, index) => [name, addresses[index]]),
  ) as LidoLocator.ConfigStruct;
}

async function deployNewLocator(deployer: string, config: LidoLocator.ConfigStruct): Promise<LoadedContract> {
  return await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [config]);
}

async function verifyConstructorArgs(newLocator: LoadedContract, config: LidoLocator.ConfigStruct): Promise<void> {
  for (const name of LOCATOR_CONFIG_KEYS) {
    const actual = await newLocator.getFunction(name).staticCall();
    assert.equal(actual, config[name]);
  }
}

export async function main(): Promise<void> {
  const deployer = (await getDeployerSigner()).address;

  const state = readNetworkState();
  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

  const config = await getConstructorArgs(locator);
  if (Object.keys(g_newAddresses).length === 0) {
    log(`No new addresses specified: doing nothing`);
    return;
  }

  for (const [name, address] of Object.entries(g_newAddresses)) {
    log.warning(`"${name}" new address: ${address}`);
  }

  const newLocator = await deployNewLocator(deployer, config);
  await verifyConstructorArgs(newLocator, config);
}
