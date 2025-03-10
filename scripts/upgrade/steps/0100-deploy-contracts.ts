import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { loadContract } from "lib/contract";
import { deployBehindOssifiableProxy, deployImplementation, deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

import { LidoLocator } from "../../../typechain-types";
import { readUpgradeParameters } from "../upgrade-utils";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const parameters = readUpgradeParameters();
  const state = readNetworkState();

  // Extract necessary addresses and parameters from the state
  const lidoAddress = state[Sk.appLido].proxy.address;
  const legacyOracleAddress = state[Sk.appOracle].proxy.address;
  const agentAddress = state[Sk.appAgent].proxy.address;
  const treasuryAddress = state[Sk.appAgent].proxy.address;
  const chainSpec = state[Sk.chainSpec];
  const vaultHubParams = parameters[Sk.vaultHub].deployParameters;
  const burnerParams = parameters[Sk.burner].deployParameters;
  const depositContract = state.chainSpec.depositContractAddress;
  const wethContract = parameters["delegation"].deployParameters.wethContract;

  // TODO: maybe take the parameters from current sanity checker
  const sanityCheckerParams = parameters[Sk.oracleReportSanityChecker].deployParameters;

  const proxyContractsOwner = deployer;
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
    lidoAddress,
    accounting.address,
    vaultHubParams.connectedVaultsLimit,
    vaultHubParams.relativeShareLimitBP,
  ]);

  // Deploy WithdrawalVault new implementation
  await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, [lidoAddress, treasuryAddress]);

  // Deploy AccountingOracle new implementation
  const accountingOracleImpl = await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, [
    locatorAddress,
    legacyOracleAddress,
    Number(chainSpec.secondsPerSlot),
    Number(chainSpec.genesisTime),
  ]);

  // Deploy Burner
  // TODO: take burner shares burnt from current burner
  const burner = await deployWithoutProxy(Sk.burner, "Burner", deployer, [
    burnerAdmin,
    locatorAddress,
    lidoAddress,
    burnerParams.totalCoverSharesBurnt,
    burnerParams.totalNonCoverSharesBurnt,
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

  // Deploy new LidoLocator implementation
  const locatorConfig: string[] = [
    await locator.accountingOracle(),
    await locator.depositSecurityModule(),
    await locator.elRewardsVault(),
    legacyOracleAddress,
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
    wstethAddress,
    vaultHub.address,
  ];
  await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [locatorConfig]);

  // Deploy StakingVault implementation contract
  const stakingVaultImpl = await deployWithoutProxy(Sk.stakingVaultImpl, "StakingVault", deployer, [
    vaultHub.address,
    depositContract,
  ]);
  const stakingVaultImplAddress = await stakingVaultImpl.getAddress();

  // Deploy Delegation implementation contract
  const delegation = await deployWithoutProxy(Sk.delegationImpl, "Delegation", deployer, [
    wethContract,
    wstethAddress,
    locatorAddress,
  ]);
  const delegationAddress = await delegation.getAddress();

  // Deploy Delegation implementation contract
  const beacon = await deployWithoutProxy(Sk.stakingVaultBeacon, "UpgradeableBeacon", deployer, [
    stakingVaultImplAddress,
    deployer,
  ]);
  const beaconAddress = await beacon.getAddress();

  // Deploy VaultFactory contract
  const factory = await deployWithoutProxy(Sk.stakingVaultFactory, "VaultFactory", deployer, [
    beaconAddress,
    delegationAddress,
  ]);
  console.log("Factory address", await factory.getAddress());
}
