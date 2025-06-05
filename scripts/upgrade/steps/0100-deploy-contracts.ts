import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { LidoLocator } from "typechain-types";

import { loadContract } from "lib/contract";
import { deployBehindOssifiableProxy, deployImplementation, deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const parameters = readUpgradeParameters();
  const state = readNetworkState();

  // Extract necessary addresses and parameters from the state
  const lidoAddress = state[Sk.appLido].proxy.address;
  const agentAddress = state[Sk.appAgent].proxy.address;
  const treasuryAddress = state[Sk.appAgent].proxy.address;
  const chainSpec = state[Sk.chainSpec];
  const vaultHubParams = parameters[Sk.vaultHub].deployParameters;
  const lazyOracleParams = parameters[Sk.lazyOracle].deployParameters;
  const depositContract = state.chainSpec.depositContractAddress;
  const consensusContract = state[Sk.hashConsensusForAccountingOracle].address;
  const pdgDeployParams = parameters[Sk.predepositGuarantee].deployParameters;

  // TODO: maybe take the parameters from current sanity checker
  const sanityCheckerParams = parameters[Sk.oracleReportSanityChecker].deployParameters;

  const proxyContractsOwner = agentAddress;
  const burnerAdmin = deployer;

  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const wstethAddress = state[Sk.wstETH].address;
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

  // Deploy Lido new implementation
  await deployImplementation(Sk.appLido, "Lido", deployer);

  // Deploy Accounting
  const accounting = await deployBehindOssifiableProxy(Sk.accounting, "Accounting", proxyContractsOwner, deployer, [
    locatorAddress,
    lidoAddress,
  ]);

  // Deploy VaultHub
  const vaultHub = await deployBehindOssifiableProxy(Sk.vaultHub, "VaultHub", proxyContractsOwner, deployer, [
    locatorAddress,
    lidoAddress,
    consensusContract,
    vaultHubParams.relativeShareLimitBP,
  ]);

  // Deploy PredepositGuarantee
  const predepositGuarantee = await deployBehindOssifiableProxy(
    Sk.predepositGuarantee,
    "PredepositGuarantee",
    proxyContractsOwner,
    deployer,
    [
      pdgDeployParams.genesisForkVersion,
      pdgDeployParams.gIndex,
      pdgDeployParams.gIndexAfterChange,
      pdgDeployParams.changeSlot,
    ],
  );

  // Deploy AccountingOracle new implementation
  const accountingOracleImpl = await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, [
    locatorAddress,
    Number(chainSpec.secondsPerSlot),
    Number(chainSpec.genesisTime),
  ]);

  // Deploy Burner
  const isMigrationAllowed = true;
  const burner = await deployWithoutProxy(Sk.burner, "Burner", deployer, [
    burnerAdmin,
    locatorAddress,
    lidoAddress,
    isMigrationAllowed,
  ]);

  // Deploy OracleReportSanityChecker
  const oracleReportSanityCheckerArgs = [
    locatorAddress,
    accountingOracleImpl.address,
    accounting.address,
    agentAddress,
    [
      sanityCheckerParams.exitedValidatorsPerDayLimit,
      sanityCheckerParams.appearedValidatorsPerDayLimit,
      sanityCheckerParams.annualBalanceIncreaseBPLimit,
      sanityCheckerParams.maxValidatorExitRequestsPerReport,
      sanityCheckerParams.maxItemsPerExtraDataTransaction,
      sanityCheckerParams.maxNodeOperatorsPerExtraDataItem,
      sanityCheckerParams.requestTimestampMargin,
      sanityCheckerParams.maxPositiveTokenRebase,
      sanityCheckerParams.initialSlashingAmountPWei,
      sanityCheckerParams.inactivityPenaltiesAmountPWei,
      sanityCheckerParams.clBalanceOraclesErrorUpperBPLimit,
    ],
  ];

  const oracleReportSanityChecker = await deployWithoutProxy(
    Sk.oracleReportSanityChecker,
    "OracleReportSanityChecker",
    deployer,
    oracleReportSanityCheckerArgs,
  );

  // Deploy LazyOracle
  const lazyOracle = await deployWithoutProxy(Sk.lazyOracle, "LazyOracle", deployer, [
    locatorAddress,
    consensusContract,
    agentAddress,
    lazyOracleParams.quarantinePeriod,
    lazyOracleParams.maxElClRewardsBP,
  ]);

  // Deploy OperatorGrid
  const operatorGrid = await deployBehindOssifiableProxy(
    Sk.operatorGrid,
    "OperatorGrid",
    proxyContractsOwner,
    deployer,
    [locatorAddress],
  );

  // Deploy new LidoLocator implementation
  const locatorConfig: string[] = [
    await locator.accountingOracle(),
    await locator.depositSecurityModule(),
    await locator.elRewardsVault(),
    lidoAddress,
    oracleReportSanityChecker.address,
    ZeroAddress,
    burner.address,
    await locator.stakingRouter(),
    treasuryAddress,
    await locator.validatorsExitBusOracle(),
    await locator.withdrawalQueue(),
    await locator.withdrawalVault(),
    await locator.oracleDaemonConfig(),
    accounting.address,
    predepositGuarantee.address,
    wstethAddress,
    vaultHub.address,
    lazyOracle.address,
    operatorGrid.address,
  ];
  await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [locatorConfig]);

  // Deploy StakingVault implementation contract
  const stakingVaultImpl = await deployWithoutProxy(Sk.stakingVaultImplementation, "StakingVault", deployer, [
    depositContract,
  ]);
  const stakingVaultImplAddress = await stakingVaultImpl.getAddress();

  // Deploy Delegation implementation contract
  const dashboardImpl = await deployWithoutProxy(Sk.dashboardImpl, "Dashboard", deployer, [
    lidoAddress,
    wstethAddress,
    vaultHub.address,
    locatorAddress,
  ]);
  const dashboardImplAddress = await dashboardImpl.getAddress();

  // Deploy UpgradeableBeacon contract
  const beacon = await deployWithoutProxy(Sk.stakingVaultBeacon, "UpgradeableBeacon", deployer, [
    stakingVaultImplAddress,
    agentAddress,
  ]);
  const beaconAddress = await beacon.getAddress();

  // Deploy VaultFactory contract
  const vaultFactory = await deployWithoutProxy(Sk.stakingVaultFactory, "VaultFactory", deployer, [
    locatorAddress,
    beaconAddress,
    dashboardImplAddress,
  ]);
  console.log("VaultFactory address", await vaultFactory.getAddress());
}
