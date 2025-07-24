import { keccak256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import {
  Burner,
  ICSModule,
  IOracleReportSanityChecker_preV3,
  LazyOracle,
  LidoLocator,
  OperatorGrid,
  PredepositGuarantee,
  StakingRouter,
  V3TemporaryAdmin,
  VaultHub,
} from "typechain-types";

import { ether, log } from "lib";
import { loadContract } from "lib/contract";
import { deployBehindOssifiableProxy, deployImplementation, deployWithoutProxy, makeTx } from "lib/deploy";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

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
  const hashConsensusAddress = state[Sk.hashConsensusForAccountingOracle].address;
  const pdgDeployParams = parameters[Sk.predepositGuarantee].deployParameters;
  const stakingRouterAddress = state[Sk.stakingRouter].proxy.address;

  const proxyContractsOwner = agentAddress;

  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const wstethAddress = state[Sk.wstETH].address;
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);
  const gateSealAddress = parameters.gateSealForVaults.address;

  //
  // Deploy V3TemporaryAdmin
  //

  const v3TemporaryAdmin = await deployWithoutProxy(Sk.v3TemporaryAdmin, "V3TemporaryAdmin", deployer, [
    agentAddress,
    gateSealAddress,
  ]);

  //
  // Deploy Lido new implementation
  //

  await deployImplementation(Sk.appLido, "Lido", deployer);

  //
  // Deploy Accounting
  //

  const accounting = await deployBehindOssifiableProxy(Sk.accounting, "Accounting", proxyContractsOwner, deployer, [
    locatorAddress,
    lidoAddress,
  ]);

  //
  // Deploy AccountingOracle new implementation
  //
  const accountingOracleImpl = await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, [
    locatorAddress,
    Number(chainSpec.secondsPerSlot),
    Number(chainSpec.genesisTime),
  ]);

  //
  // Deploy Burner
  //

  // Prepare initialization data for Burner.initialize(address admin, bool isMigrationAllowed)
  const isMigrationAllowed = true;
  const burnerInterface = await ethers.getContractFactory("Burner");
  const burnerInitData = burnerInterface.interface.encodeFunctionData("initialize", [
    v3TemporaryAdmin.address,
    isMigrationAllowed,
  ]);

  const burner_ = await deployBehindOssifiableProxy(
    Sk.burner,
    "Burner",
    proxyContractsOwner,
    deployer,
    [locatorAddress, lidoAddress],
    null, // implementation
    true, // withStateFile
    undefined, // signerOrOptions
    burnerInitData,
  );
  const burner = await loadContract<Burner>("Burner", burner_.address);

  const stakingRouter = await loadContract<StakingRouter>("StakingRouter", stakingRouterAddress);
  const stakingModules = await stakingRouter.getStakingModules();
  const csm = stakingModules[2];
  if (csm.name !== "Community Staking") {
    throw new Error("Community Staking module not found");
  }
  const csmModule = await loadContract<ICSModule>("ICSModule", csm.stakingModuleAddress);
  const csmAccountingAddress = await csmModule.accounting();

  //
  // Deploy LazyOracle
  //

  // Prepare initialization data for LazyOracle.initialize(address admin, uint256 quarantinePeriod, uint256 maxRewardRatioBP)
  const lazyOracleInterface = await ethers.getContractFactory("LazyOracle");
  const lazyOracleInitData = lazyOracleInterface.interface.encodeFunctionData("initialize", [
    v3TemporaryAdmin.address,
    lazyOracleParams.quarantinePeriod,
    lazyOracleParams.maxRewardRatioBP,
  ]);

  const lazyOracle_ = await deployBehindOssifiableProxy(
    Sk.lazyOracle,
    "LazyOracle",
    proxyContractsOwner,
    deployer,
    [locatorAddress],
    null, // implementation
    true, // withStateFile
    undefined, // signerOrOptions
    lazyOracleInitData,
  );

  const lazyOracle = await loadContract<LazyOracle>("LazyOracle", lazyOracle_.address);
  log("LazyOracle initialized with V3TemporaryAdmin", v3TemporaryAdmin.address);

  //
  // Deploy StakingVault implementation contract
  //

  const stakingVaultImpl = await deployWithoutProxy(Sk.stakingVaultImplementation, "StakingVault", deployer, [
    depositContract,
  ]);

  //
  // Deploy UpgradeableBeacon contract
  //

  const beacon = await deployWithoutProxy(Sk.stakingVaultBeacon, "UpgradeableBeacon", deployer, [
    stakingVaultImpl.address,
    agentAddress,
  ]);

  //
  // Deploy BeaconProxy to get bytecode and add it to whitelist
  //

  const vaultBeaconProxy = await ethers.deployContract("PinnedBeaconProxy", [beacon.address, "0x"]);
  const vaultBeaconProxyCode = await ethers.provider.getCode(await vaultBeaconProxy.getAddress());
  const vaultBeaconProxyCodeHash = keccak256(vaultBeaconProxyCode);
  console.log("BeaconProxy address", await vaultBeaconProxy.getAddress());

  //
  // Deploy VaultHub
  //

  // Prepare initialization data for VaultHub.initialize(address admin)
  const vaultHubInterface = await ethers.getContractFactory("VaultHub");
  const vaultHubInitData = vaultHubInterface.interface.encodeFunctionData("initialize", [v3TemporaryAdmin.address]);

  const vaultHub_ = await deployBehindOssifiableProxy(
    Sk.vaultHub,
    "VaultHub",
    proxyContractsOwner,
    deployer,
    [locatorAddress, lidoAddress, hashConsensusAddress, vaultHubParams.relativeShareLimitBP],
    null, // implementation
    true, // withStateFile
    undefined, // signerOrOptions
    vaultHubInitData,
  );

  const vaultHub = await loadContract<VaultHub>("VaultHub", vaultHub_.address);

  //
  // Deploy PredepositGuarantee
  //

  // Prepare initialization data for PredepositGuarantee.initialize(address admin)
  const predepositGuaranteeInterface = await ethers.getContractFactory("PredepositGuarantee");
  const predepositGuaranteeInitData = predepositGuaranteeInterface.interface.encodeFunctionData("initialize", [
    v3TemporaryAdmin.address,
  ]);

  const predepositGuarantee_ = await deployBehindOssifiableProxy(
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
    null, // implementation
    true, // withStateFile
    undefined, // signerOrOptions
    predepositGuaranteeInitData,
  );

  const predepositGuarantee = await loadContract<PredepositGuarantee>(
    "PredepositGuarantee",
    predepositGuarantee_.address,
  );

  //
  // Deploy OracleReportSanityChecker
  //

  const oldSanityCheckerAddress = await locator.oracleReportSanityChecker();
  const oldSanityChecker = await loadContract<IOracleReportSanityChecker_preV3>(
    "IOracleReportSanityChecker_preV3",
    oldSanityCheckerAddress,
  );
  const oldCheckerLimits = await oldSanityChecker.getOracleReportLimits();

  const oracleReportSanityCheckerArgs = [
    locatorAddress,
    accountingOracleImpl.address,
    accounting.address,
    agentAddress,
    [
      oldCheckerLimits.exitedValidatorsPerDayLimit,
      oldCheckerLimits.appearedValidatorsPerDayLimit,
      oldCheckerLimits.annualBalanceIncreaseBPLimit,
      oldCheckerLimits.maxValidatorExitRequestsPerReport,
      oldCheckerLimits.maxItemsPerExtraDataTransaction,
      oldCheckerLimits.maxNodeOperatorsPerExtraDataItem,
      oldCheckerLimits.requestTimestampMargin,
      oldCheckerLimits.maxPositiveTokenRebase,
      oldCheckerLimits.initialSlashingAmountPWei,
      oldCheckerLimits.inactivityPenaltiesAmountPWei,
      oldCheckerLimits.clBalanceOraclesErrorUpperBPLimit,
    ],
  ];

  const newSanityChecker = await deployWithoutProxy(
    Sk.oracleReportSanityChecker,
    "OracleReportSanityChecker",
    deployer,
    oracleReportSanityCheckerArgs,
  );

  //
  // Deploy OperatorGrid
  //

  const gridParams = parameters[Sk.operatorGrid].deployParameters;
  const defaultTierParams = {
    shareLimit: ether(gridParams.defaultTierParams.shareLimitInEther),
    reserveRatioBP: gridParams.defaultTierParams.reserveRatioBP,
    forcedRebalanceThresholdBP: gridParams.defaultTierParams.forcedRebalanceThresholdBP,
    infraFeeBP: gridParams.defaultTierParams.infraFeeBP,
    liquidityFeeBP: gridParams.defaultTierParams.liquidityFeeBP,
    reservationFeeBP: gridParams.defaultTierParams.reservationFeeBP,
  };

  const operatorGridInterface = await ethers.getContractFactory("OperatorGrid");
  const operatorGridInitData = operatorGridInterface.interface.encodeFunctionData("initialize", [
    v3TemporaryAdmin.address,
    defaultTierParams,
  ]);

  const operatorGrid_ = await deployBehindOssifiableProxy(
    Sk.operatorGrid,
    "OperatorGrid",
    proxyContractsOwner,
    deployer,
    [locatorAddress],
    null, // implementation
    true, // withStateFile
    undefined, // signerOrOptions
    operatorGridInitData,
  );

  const operatorGrid = await loadContract<OperatorGrid>("OperatorGrid", operatorGrid_.address);

  //
  // Deploy Delegation implementation contract
  //

  const dashboardImpl = await deployWithoutProxy(Sk.dashboardImpl, "Dashboard", deployer, [
    lidoAddress,
    wstethAddress,
    vaultHub.address,
    locatorAddress,
  ]);
  const dashboardImplAddress = await dashboardImpl.getAddress();

  //
  // Deploy VaultFactory
  //

  const vaultFactory = await deployWithoutProxy(Sk.stakingVaultFactory, "VaultFactory", deployer, [
    locatorAddress,
    beacon.address,
    dashboardImplAddress,
  ]);
  console.log("VaultFactory address", await vaultFactory.getAddress());

  //
  // Deploy new LidoLocator implementation
  //
  const locatorConfig: LidoLocator.ConfigStruct = {
    accountingOracle: await locator.accountingOracle(),
    depositSecurityModule: await locator.depositSecurityModule(),
    elRewardsVault: await locator.elRewardsVault(),
    lido: lidoAddress,
    oracleReportSanityChecker: newSanityChecker.address,
    postTokenRebaseReceiver: ZeroAddress,
    burner: burner.address,
    stakingRouter: await locator.stakingRouter(),
    treasury: treasuryAddress,
    validatorsExitBusOracle: await locator.validatorsExitBusOracle(),
    withdrawalQueue: await locator.withdrawalQueue(),
    withdrawalVault: await locator.withdrawalVault(),
    oracleDaemonConfig: await locator.oracleDaemonConfig(),
    validatorExitDelayVerifier: getAddress(Sk.validatorExitDelayVerifier, state),
    triggerableWithdrawalsGateway: getAddress(Sk.triggerableWithdrawalsGateway, state),
    accounting: accounting.address,
    predepositGuarantee: predepositGuarantee.address,
    wstETH: wstethAddress,
    vaultHub: vaultHub.address,
    vaultFactory: vaultFactory.address,
    lazyOracle: lazyOracle.address,
    operatorGrid: operatorGrid.address,
  };
  await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [locatorConfig]);

  //
  // Deploy ValidatorConsolidationRequests
  //

  const validatorConsolidationRequests_ = await deployWithoutProxy(
    Sk.validatorConsolidationRequests,
    "ValidatorConsolidationRequests",
    deployer,
    [locatorAddress],
  );
  console.log("ValidatorConsolidationRequests address", await validatorConsolidationRequests_.getAddress());

  //
  // Complete setup: set allowed codehash, grant all roles to agent, transfer admin
  //
  const v3TemporaryAdminContract = await loadContract<V3TemporaryAdmin>("V3TemporaryAdmin", v3TemporaryAdmin.address);
  await makeTx(
    v3TemporaryAdminContract,
    "completeSetup",
    [
      vaultHub_.address,
      predepositGuarantee_.address,
      lazyOracle_.address,
      operatorGrid_.address,
      burner_.address,
      accounting.address,
      csmAccountingAddress,
      vaultBeaconProxyCodeHash,
    ],
    { from: deployer },
  );
}
