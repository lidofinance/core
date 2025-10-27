import assert from "assert";
import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { LidoLocator } from "typechain-types";

import { deployImplementation, deployWithoutProxy, loadContract, readNetworkState, Sk } from "lib";

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;
  assert.equal(process.env.DEPLOYER, deployer);

  const parameters = readUpgradeParameters();
  const state = readNetworkState();

  //
  // Extract necessary addresses and parameters from the state
  //
  const depositContract = state.chainSpec.depositContractAddress;

  const vaultHubParams = parameters.vaultHub;
  const pdgDeployParams = parameters.predepositGuarantee;

  const lidoAddress = state[Sk.appLido].proxy.address;
  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const vaultHubProxyAddress = state[Sk.vaultHub].proxy.address;
  const hashConsensusAddress = state[Sk.hashConsensusForAccountingOracle].address;
  const wstethAddress = state[Sk.wstETH].address;
  const previousFactoryAddress = state[Sk.stakingVaultFactory].address;
  const beaconAddress = state[Sk.stakingVaultBeacon].address;

  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

  //
  // New StakingVault implementation
  //
  const stakingVaultImpl = await deployWithoutProxy(Sk.stakingVaultImplementation, "StakingVault", deployer, [
    depositContract,
  ]);
  const stakingVaultImplAddress = await stakingVaultImpl.getAddress();
  console.log("New StakingVault implementation address", stakingVaultImplAddress);

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
  // New LazyOracle implementation
  //
  await deployImplementation(Sk.lazyOracle, "LazyOracle", deployer, [locatorAddress]);
  const newLazyOracleAddress = state[Sk.lazyOracle].implementation.address;
  console.log("New LazyOracle implementation address", newLazyOracleAddress);

  //
  // New OperatorGrid implementation
  //
  await deployImplementation(Sk.operatorGrid, "OperatorGrid", deployer, [locatorAddress]);
  const newOperatorGridAddress = state[Sk.operatorGrid].implementation.address;
  console.log("New OperatorGrid implementation address", newOperatorGridAddress);

  //
  // New VaultHub implementation
  //
  await deployImplementation(Sk.vaultHub, "VaultHub", deployer, [
    locatorAddress,
    lidoAddress,
    hashConsensusAddress,
    vaultHubParams.relativeShareLimitBP,
  ]);
  const newVaultHubAddress = state[Sk.vaultHub].implementation.address;
  console.log("New VaultHub implementation address", newVaultHubAddress);

  //
  // New PredepositGuarantee implementation
  //
  await deployImplementation(Sk.predepositGuarantee, "PredepositGuarantee", deployer, [
    pdgDeployParams.genesisForkVersion,
    pdgDeployParams.gIndex,
    pdgDeployParams.gIndexAfterChange,
    pdgDeployParams.changeSlot,
  ]);
  const newPredepositGuaranteeAddress = state[Sk.predepositGuarantee].implementation.address;
  console.log("New PredepositGuarantee implementation address", newPredepositGuaranteeAddress);

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

  const locatorConfig: LidoLocator.ConfigStruct = {
    accountingOracle: await locator.accountingOracle(),
    depositSecurityModule: await locator.depositSecurityModule(),
    elRewardsVault: await locator.elRewardsVault(),
    lido: lidoAddress,
    oracleReportSanityChecker: await locator.oracleReportSanityChecker(),
    postTokenRebaseReceiver: ethers.ZeroAddress,
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
    wstETH: wstethAddress,
    vaultHub: vaultHubProxyAddress,
    vaultFactory: newVaultFactoryAddress,
    lazyOracle: await locator.lazyOracle(),
    operatorGrid: await locator.operatorGrid(),
  };
  const lidoLocatorImpl = await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [locatorConfig]);
  const newLocatorAddress = await lidoLocatorImpl.getAddress();
  console.log("New LidoLocator implementation address", newLocatorAddress);
}
