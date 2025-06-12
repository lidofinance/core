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
  VaultHub,
} from "typechain-types";

import { ether, log } from "lib";
import { loadContract } from "lib/contract";
import { deployBehindOssifiableProxy, deployImplementation, deployWithoutProxy, makeTx } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

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
  const nodeOperatorsRegistryAddress = state[Sk.appNodeOperatorsRegistry].proxy.address;
  const simpleDvtAddress = state[Sk.appSimpleDvt].proxy.address;
  const oracleReportSanityCheckerAddress = state[Sk.oracleReportSanityChecker].address;

  const proxyContractsOwner = agentAddress;

  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const wstethAddress = state[Sk.wstETH].address;
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

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

  const burner_ = await deployBehindOssifiableProxy(Sk.burner, "Burner", proxyContractsOwner, deployer, [
    locatorAddress,
    lidoAddress,
  ]);

  const burner = await loadContract<Burner>("Burner", burner_.address);

  const isMigrationAllowed = true;
  await burner.initialize(deployer, isMigrationAllowed);

  const requestBurnSharesRole = await burner.REQUEST_BURN_SHARES_ROLE();
  await makeTx(burner, "grantRole", [requestBurnSharesRole, accounting.address], { from: deployer });

  const stakingRouter = await loadContract<StakingRouter>("StakingRouter", stakingRouterAddress);
  const stakingModules = await stakingRouter.getStakingModules();
  const csm = stakingModules[2];
  if (csm.name !== "Community Staking") {
    throw new Error("Community Staking module not found");
  }
  const csmModule = await loadContract<ICSModule>("ICSModule", csm.stakingModuleAddress);
  const csmAccountingAddress = await csmModule.accounting();

  await makeTx(burner, "grantRole", [requestBurnSharesRole, nodeOperatorsRegistryAddress], { from: deployer });
  await makeTx(burner, "grantRole", [requestBurnSharesRole, simpleDvtAddress], { from: deployer });
  await makeTx(burner, "grantRole", [requestBurnSharesRole, csmAccountingAddress], { from: deployer });

  await makeTx(burner, "grantRole", [DEFAULT_ADMIN_ROLE, agentAddress], { from: deployer });
  await makeTx(burner, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });

  //
  // Deploy LazyOracle
  //

  const lazyOracle_ = await deployBehindOssifiableProxy(Sk.lazyOracle, "LazyOracle", proxyContractsOwner, deployer, [
    locatorAddress,
    hashConsensusAddress,
  ]);

  const lazyOracle = await loadContract<LazyOracle>("LazyOracle", lazyOracle_.address);
  await makeTx(
    lazyOracle,
    "initialize",
    [deployer, lazyOracleParams.quarantinePeriod, lazyOracleParams.maxRewardRatioBP],
    { from: deployer },
  );
  log("LazyOracle initialized with admin", deployer);

  const updateSanityParamsRole = await lazyOracle.UPDATE_SANITY_PARAMS_ROLE();

  await makeTx(lazyOracle, "grantRole", [DEFAULT_ADMIN_ROLE, agentAddress], { from: deployer });
  await makeTx(lazyOracle, "grantRole", [updateSanityParamsRole, agentAddress], { from: deployer });

  await makeTx(lazyOracle, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });

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

  const vaultHub_ = await deployBehindOssifiableProxy(Sk.vaultHub, "VaultHub", proxyContractsOwner, deployer, [
    locatorAddress,
    lidoAddress,
    hashConsensusAddress,
    vaultHubParams.relativeShareLimitBP,
  ]);

  const vaultHubAdmin = deployer;
  const vaultHub = await loadContract<VaultHub>("VaultHub", vaultHub_.address);
  await makeTx(vaultHub, "initialize", [vaultHubAdmin], { from: deployer });
  log("VaultHub initialized with admin", vaultHubAdmin);

  const vaultMasterRole = await vaultHub.VAULT_MASTER_ROLE();
  const vaultCodehashRole = await vaultHub.VAULT_CODEHASH_SET_ROLE();

  await makeTx(vaultHub, "grantRole", [vaultCodehashRole, deployer], { from: deployer });
  await makeTx(vaultHub, "setAllowedCodehash", [vaultBeaconProxyCodeHash], { from: deployer });
  await makeTx(vaultHub, "renounceRole", [vaultCodehashRole, deployer], { from: deployer });

  await makeTx(vaultHub, "grantRole", [DEFAULT_ADMIN_ROLE, agentAddress], { from: deployer });
  await makeTx(vaultHub, "grantRole", [vaultMasterRole, agentAddress], { from: deployer });
  await makeTx(vaultHub, "grantRole", [vaultCodehashRole, agentAddress], { from: deployer });

  await makeTx(vaultHub, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });

  //
  // Deploy PredepositGuarantee
  //

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
  );

  const predepositGuarantee = await loadContract<PredepositGuarantee>(
    "PredepositGuarantee",
    predepositGuarantee_.address,
  );
  await makeTx(predepositGuarantee, "initialize", [agentAddress], { from: deployer });

  //
  // Deploy OracleReportSanityChecker
  //

  const sanityChecker = await loadContract<IOracleReportSanityChecker_preV3>(
    "IOracleReportSanityChecker_preV3",
    oracleReportSanityCheckerAddress,
  );
  const oldCheckerLimits = await sanityChecker.getOracleReportLimits();

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

  const oracleReportSanityChecker = await deployWithoutProxy(
    Sk.oracleReportSanityChecker,
    "OracleReportSanityChecker",
    deployer,
    oracleReportSanityCheckerArgs,
  );

  //
  // Deploy OperatorGrid
  //

  const operatorGrid_ = await deployBehindOssifiableProxy(
    Sk.operatorGrid,
    "OperatorGrid",
    proxyContractsOwner,
    deployer,
    [locatorAddress],
  );

  const gridParams = parameters[Sk.operatorGrid].deployParameters;
  const defaultTierParams = {
    shareLimit: ether(gridParams.defaultTierParams.shareLimitInEther),
    reserveRatioBP: gridParams.defaultTierParams.reserveRatioBP,
    forcedRebalanceThresholdBP: gridParams.defaultTierParams.forcedRebalanceThresholdBP,
    infraFeeBP: gridParams.defaultTierParams.infraFeeBP,
    liquidityFeeBP: gridParams.defaultTierParams.liquidityFeeBP,
    reservationFeeBP: gridParams.defaultTierParams.reservationFeeBP,
  };
  const operatorGrid = await loadContract<OperatorGrid>("OperatorGrid", operatorGrid_.address);
  const operatorGridAdmin = deployer;
  await makeTx(operatorGrid, "initialize", [operatorGridAdmin, defaultTierParams], { from: deployer });
  await makeTx(operatorGrid, "grantRole", [await operatorGrid.REGISTRY_ROLE(), agentAddress], {
    from: operatorGridAdmin,
  });
  await makeTx(operatorGrid, "grantRole", [DEFAULT_ADMIN_ROLE, agentAddress], { from: deployer });
  await makeTx(operatorGrid, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });

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
    vaultFactory.address,
    lazyOracle.address,
    operatorGrid.address,
  ];
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
}
