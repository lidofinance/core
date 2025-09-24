import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { LidoLocator, LidoLocator__factory, OssifiableProxy, OssifiableProxy__factory } from "typechain-types";

import { certainAddress } from "lib";

async function deployDummyLocator(config?: Partial<LidoLocator.ConfigStruct>, deployer?: HardhatEthersSigner) {
  if (!deployer) {
    [deployer] = await ethers.getSigners();
  }

  const factory = new LidoLocator__factory(deployer);

  const locator = await factory.deploy({
    accountingOracle: certainAddress("dummy-locator:accountingOracle"),
    depositSecurityModule: certainAddress("dummy-locator:depositSecurityModule"),
    elRewardsVault: certainAddress("dummy-locator:elRewardsVault"),
    lido: certainAddress("dummy-locator:lido"),
    oracleReportSanityChecker: certainAddress("dummy-locator:oracleReportSanityChecker"),
    postTokenRebaseReceiver: certainAddress("dummy-locator:postTokenRebaseReceiver"),
    burner: certainAddress("dummy-locator:burner"),
    stakingRouter: certainAddress("dummy-locator:stakingRouter"),
    treasury: certainAddress("dummy-locator:treasury"),
    validatorsExitBusOracle: certainAddress("dummy-locator:validatorsExitBusOracle"),
    withdrawalQueue: certainAddress("dummy-locator:withdrawalQueue"),
    withdrawalVault: certainAddress("dummy-locator:withdrawalVault"),
    oracleDaemonConfig: certainAddress("dummy-locator:oracleDaemonConfig"),
    validatorExitDelayVerifier: certainAddress("dummy-locator:validatorExitDelayVerifier"),
    triggerableWithdrawalsGateway: certainAddress("dummy-locator:triggerableWithdrawalsGateway"),
    accounting: certainAddress("dummy-locator:accounting"),
    predepositGuarantee: certainAddress("dummy-locator:predepositGuarantee"),
    wstETH: certainAddress("dummy-locator:wstETH"),
    vaultHub: certainAddress("dummy-locator:vaultHub"),
    vaultFactory: certainAddress("dummy-locator:vaultFactory"),
    operatorGrid: certainAddress("dummy-locator:operatorGrid"),
    lazyOracle: certainAddress("dummy-locator:lazyOracle"),
    ...config,
  });

  return locator as LidoLocator;
}

export async function deployLidoLocator(config?: Partial<LidoLocator.ConfigStruct>, deployer?: HardhatEthersSigner) {
  if (!deployer) {
    [deployer] = await ethers.getSigners();
  }

  const locator = await deployDummyLocator(config, deployer);
  const proxyFactory = new OssifiableProxy__factory(deployer);
  const proxy = await proxyFactory.deploy(await locator.getAddress(), await deployer.getAddress(), new Uint8Array());

  return locator.attach(await proxy.getAddress()) as LidoLocator;
}

async function updateImplementation(
  proxyAddress: string,
  config: LidoLocator.ConfigStruct,
  customLocator?: string,
  proxyOwner?: HardhatEthersSigner,
) {
  if (!proxyOwner) {
    [proxyOwner] = await ethers.getSigners();
  }

  const proxyFactory = new OssifiableProxy__factory(proxyOwner);
  const proxy = proxyFactory.attach(proxyAddress) as OssifiableProxy;

  let implementation;
  if (customLocator) {
    const contractFactory = await ethers.getContractFactory(customLocator);
    implementation = await contractFactory.connect(proxyOwner).deploy(config);
  } else {
    implementation = await deployDummyLocator(config, proxyOwner);
  }

  const implementationAddress = await implementation.getAddress();
  await proxy.proxy__upgradeTo(implementationAddress);
}

export async function updateLidoLocatorImplementation(
  locatorAddress: string,
  configUpdate: Partial<LidoLocator.ConfigStruct> = {},
  customLocator?: string,
  admin?: HardhatEthersSigner,
) {
  const config = await getLocatorConfig(locatorAddress);

  Object.assign(config, configUpdate);

  await updateImplementation(locatorAddress, config, customLocator, admin);
}

async function getLocatorConfig(locatorAddress: string): Promise<LidoLocator.ConfigStruct> {
  const locator = await ethers.getContractAt("LidoLocator", locatorAddress);

  const addresses = [
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
    "accounting",
    "predepositGuarantee",
    "wstETH",
    "vaultHub",
    "vaultFactory",
    "lazyOracle",
    "operatorGrid",
  ] as Partial<keyof LidoLocator.ConfigStruct>[];

  const configPromises = addresses.map((name) => locator[name]());

  const config = await Promise.all(configPromises);

  return Object.fromEntries(addresses.map((n, i) => [n, config[i]])) as LidoLocator.ConfigStruct;
}
