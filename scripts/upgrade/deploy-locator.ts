import { assert } from "chai";
import { ethers } from "hardhat";

import { deployImplementation, getContractAt, LoadedContract, log, readNetworkState, Sk } from "lib";

const VIEW_NAMES_AND_CTOR_ARGS = [
  // As view names on LidoLocator
  "accountingOracle",
  "depositSecurityModule",
  "elRewardsVault",
  "legacyOracle",
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

/////////////// GLOBAL VARIABLES ///////////////
const g_newAddresses: { [key: string]: string } = {};
/////////////// GLOBAL VARIABLES ///////////////

async function getNewFromEnvOrCurrent(name: string, locator: LoadedContract) {
  const valueFromEnv = process.env[name];
  if (valueFromEnv) {
    if (!ethers.isAddress(valueFromEnv)) {
      log.error(`Value ${valueFromEnv} of ${name} is not an address`);
      process.exit(1);
    }
    g_newAddresses[name] = valueFromEnv;
    return valueFromEnv;
  }
  return await locator.getFunction(name).staticCall();
}

async function main() {
  log.scriptStart(__filename);

  const deployer = (await ethers.provider.getSigner()).address;
  assert.equal(process.env.DEPLOYER, deployer);

  const state = readNetworkState();
  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const locator = await getContractAt("LidoLocator", locatorAddress);

  const newOrCurrent = async (name: string) => {
    return await getNewFromEnvOrCurrent(name, locator);
  };
  const ctorArgs = await Promise.all(VIEW_NAMES_AND_CTOR_ARGS.map(newOrCurrent));

  if (Object.keys(g_newAddresses).length === 0) {
    log(`No new addresses specified: exiting doing nothing`);
    process.exit(0);
  }
  log.splitter();
  for (const name in g_newAddresses) {
    log(`(!) "${name}" new address: ${g_newAddresses[name]}`);
  }
  log.splitter();

  const newLocator = await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [ctorArgs]);

  // To check order in ctor args was not broken
  for (const viewName of VIEW_NAMES_AND_CTOR_ARGS) {
    const actual = await newLocator.getFunction(viewName).staticCall();
    assert.equal(actual, await getNewFromEnvOrCurrent(viewName, locator));
  }

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
