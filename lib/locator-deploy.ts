import { ethers } from "hardhat";

import { certainAddress } from "lib";

const invalidButNonZeroLocatorConfig = {
  accountingOracle: certainAddress("dummy"),
  depositSecurityModule: certainAddress("dummy"),
  elRewardsVault: certainAddress("dummy"),
  legacyOracle: certainAddress("dummy"),
  lido: certainAddress("dummy"),
  oracleReportSanityChecker: certainAddress("dummy"),
  postTokenRebaseReceiver: certainAddress("dummy"),
  burner: certainAddress("dummy"),
  stakingRouter: certainAddress("dummy"),
  treasury: certainAddress("dummy"),
  validatorsExitBusOracle: certainAddress("dummy"),
  withdrawalQueue: certainAddress("dummy"),
  withdrawalVault: certainAddress("dummy"),
  oracleDaemonConfig: certainAddress("dummy"),
};

async function deployBehindOssifiableProxy(artifactName: string, proxyOwner: string, constructorArgs: unknown[]) {
  const contractFactory = await ethers.getContractFactory(artifactName);
  const implementation = await contractFactory.deploy(...constructorArgs, { from: proxyOwner });

  const proxyFactory = await ethers.getContractFactory("OssifiableProxy");
  const proxy = await proxyFactory.deploy(await implementation.getAddress(), proxyOwner, new Uint8Array(), {
    from: proxyOwner,
  });

  return proxy;
}

async function updateProxyImplementation(
  proxyAddress: string,
  artifactName: string,
  proxyOwner: string,
  constructorArgs: unknown[],
) {
  const proxy = await ethers.getContractAt("OssifiableProxy", proxyAddress);

  const contractFactory = await ethers.getContractFactory(artifactName);
  const implementation = await contractFactory.deploy(...constructorArgs, { from: proxyOwner });

  await proxy.proxy__upgradeTo(await implementation.getAddress());
}

async function getLocatorConfig(locatorAddress: string) {
  const locator = await ethers.getContractAt("LidoLocator", locatorAddress);
  const config = {
    accountingOracle: await locator.accountingOracle(),
    depositSecurityModule: await locator.depositSecurityModule(),
    elRewardsVault: await locator.elRewardsVault(),
    legacyOracle: await locator.legacyOracle(),
    lido: await locator.lido(),
    oracleReportSanityChecker: await locator.oracleReportSanityChecker(),
    postTokenRebaseReceiver: await locator.postTokenRebaseReceiver(),
    burner: await locator.burner(),
    stakingRouter: await locator.stakingRouter(),
    treasury: await locator.treasury(),
    validatorsExitBusOracle: await locator.validatorsExitBusOracle(),
    withdrawalQueue: await locator.withdrawalQueue(),
    withdrawalVault: await locator.withdrawalVault(),
    oracleDaemonConfig: await locator.oracleDaemonConfig(),
  };
  return config;
}

export async function deployLocatorWithDummyAddressesImplementation(admin: string) {
  const proxy = await deployBehindOssifiableProxy("LidoLocator", admin, [invalidButNonZeroLocatorConfig]);
  return await ethers.getContractAt("LidoLocator", await proxy.getAddress());
}

/// ! Not specified in configUpdate values are set to dummy non zero addresses
export async function updateLocatorImplementation(locatorAddress: string, admin: string, configUpdate = {}) {
  const config = await getLocatorConfig(locatorAddress);
  Object.assign(config, configUpdate);
  await updateProxyImplementation(locatorAddress, "LidoLocator", admin, [config]);
}
