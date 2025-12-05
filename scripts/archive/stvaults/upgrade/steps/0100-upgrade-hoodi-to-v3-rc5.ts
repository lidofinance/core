import assert from "assert";
import { ethers } from "hardhat";

import { LidoLocator } from "typechain-types";

import { deployImplementation, deployWithoutProxy, loadContract, readNetworkState, Sk } from "lib";

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;
  assert.equal(process.env.DEPLOYER, deployer);

  const state = readNetworkState();

  //
  // Extract necessary addresses and parameters from the state
  //
  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const lidoAddress = state[Sk.appLido].proxy.address;
  const wstethAddress = state[Sk.wstETH].address;
  const vaultHubProxyAddress = state[Sk.vaultHub].proxy.address;
  const accountingProxyAddress = state[Sk.accounting].proxy.address;
  const agentAddress = state[Sk.appAgent].proxy.address;

  const beaconAddress = state[Sk.stakingVaultBeacon].address;
  const previousFactoryAddress = state[Sk.stakingVaultFactory].address;

  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

  //
  // New OperatorGrid implementation
  //
  const newOperatorGridImpl = await deployImplementation(Sk.operatorGrid, "OperatorGrid", deployer, [locatorAddress]);
  const newOperatorGridImplAddress = await newOperatorGridImpl.getAddress();
  console.log("New OperatorGrid implementation address", newOperatorGridImplAddress);

  //
  // New Accounting implementation
  //
  const newAccountingImpl = await deployImplementation(Sk.accounting, "Accounting", deployer, [
    locatorAddress,
    lidoAddress,
  ]);
  const newAccountingImplAddress = await newAccountingImpl.getAddress();
  console.log("New Accounting implementation address", newAccountingImplAddress);

  //
  // New Dashboard implementation
  //
  const dashboardImpl = await deployWithoutProxy(Sk.dashboardImpl, "Dashboard", deployer, [
    lidoAddress,
    wstethAddress,
    vaultHubProxyAddress,
    locatorAddress,
  ]);
  const dashboardImplAddress = await dashboardImpl.getAddress();
  console.log("New Dashboard implementation address", dashboardImplAddress);

  //
  // New VaultFactory implementation
  //
  const vaultFactory = await deployWithoutProxy(Sk.stakingVaultFactory, "VaultFactory", deployer, [
    locatorAddress,
    beaconAddress,
    dashboardImplAddress,
    previousFactoryAddress,
  ]);
  const newVaultFactoryAddress = await vaultFactory.getAddress();
  console.log("New VaultFactory implementation address", newVaultFactoryAddress);

  //
  // TokenRateNotifier implementation
  //
  const newTokenRateNotifier = await deployImplementation(Sk.tokenRebaseNotifierV3, "TokenRateNotifier", deployer, [
    agentAddress,
    accountingProxyAddress,
  ]);
  const newTokenRateNotifierAddress = await newTokenRateNotifier.getAddress();
  console.log("TokenRateNotifier address", newTokenRateNotifierAddress);

  //
  // New LidoLocator implementation
  //
  const locatorConfig: LidoLocator.ConfigStruct = {
    accountingOracle: await locator.accountingOracle(),
    depositSecurityModule: await locator.depositSecurityModule(),
    elRewardsVault: await locator.elRewardsVault(),
    lido: await locator.lido(),
    oracleReportSanityChecker: await locator.oracleReportSanityChecker(),
    postTokenRebaseReceiver: newTokenRateNotifierAddress,
    burner: await locator.burner(),
    stakingRouter: await locator.stakingRouter(),
    treasury: await locator.treasury(),
    validatorsExitBusOracle: await locator.validatorsExitBusOracle(),
    withdrawalQueue: await locator.withdrawalQueue(),
    withdrawalVault: await locator.withdrawalVault(),
    oracleDaemonConfig: await locator.oracleDaemonConfig(),
    validatorExitDelayVerifier: await locator.validatorExitDelayVerifier(),
    triggerableWithdrawalsGateway: await locator.triggerableWithdrawalsGateway(),
    accounting: await locator.accounting(),
    predepositGuarantee: await locator.predepositGuarantee(),
    wstETH: await locator.wstETH(),
    vaultHub: await locator.vaultHub(),
    vaultFactory: newVaultFactoryAddress,
    lazyOracle: await locator.lazyOracle(),
    operatorGrid: await locator.operatorGrid(),
  };
  const lidoLocatorImpl = await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [locatorConfig]);
  const newLocatorAddress = await lidoLocatorImpl.getAddress();
  console.log("New LidoLocator implementation address", newLocatorAddress);
}
