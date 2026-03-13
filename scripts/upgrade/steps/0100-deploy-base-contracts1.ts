import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import {
  Burner,
  IGateSealFactory,
  IOracleReportSanityChecker_preV3,
  LazyOracle,
  LidoLocator,
  OperatorGrid,
  PredepositGuarantee,
  VaultHub,
} from "typechain-types";

import { ether, log } from "lib";
import { loadContract } from "lib/contract";
import { deployBehindOssifiableProxy, deployImplementation, deployWithoutProxy, makeTx } from "lib/deploy";
import { findEventsWithInterfaces } from "lib/event";
import { getAddress, readNetworkState, Sk, updateObjectInState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const parameters = readUpgradeParameters();
  const state = readNetworkState();

  // Extract necessary addresses and parameters from the state
  const lidoAddress = state[Sk.appLido].proxy.address;
  const agentAddress = state[Sk.appAgent].proxy.address;
  const treasuryAddress = state[Sk.appAgent].proxy.address;
  const stakingRouterAddress = state[Sk.stakingRouter].proxy.address;

  const chainSpec = state[Sk.chainSpec];
  // const vaultHubParams = parameters.vaultHub;
  // const lazyOracleParams = parameters.lazyOracle;
  const depositContract = state.chainSpec.depositContractAddress;
  const hashConsensusAddress = state[Sk.hashConsensusForAccountingOracle].address;
  // const pdgDeployParams = parameters.predepositGuarantee;
  const resealManagerAddress = state[Sk.resealManager].address;

  const proxyContractsOwner = agentAddress;

  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const wstethAddress = state[Sk.wstETH].address;
  // const oldTokenRateNotifierAddress = state[Sk.tokenRebaseNotifier].address;
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
  // Deploy StakingRouter implementation contract
  //

  const stakingRouterImpl = await deployImplementation(Sk.stakingRouter, "StakingRouter", deployer, [depositContract]);

  // //
  // // Deploy VaultHub
  // //

  // // Prepare initialization data for VaultHub.initialize(address admin)
  // const vaultHubInterface = await ethers.getContractFactory("VaultHub");
  // const vaultHubInitData = vaultHubInterface.interface.encodeFunctionData("initialize", [v3TemporaryAdmin.address]);

  // const vaultHub_ = await deployBehindOssifiableProxy(
  //   Sk.vaultHub,
  //   "VaultHub",
  //   proxyContractsOwner,
  //   deployer,
  //   [locatorAddress, lidoAddress, hashConsensusAddress, vaultHubParams.maxRelativeShareLimitBP],
  //   null, // implementation
  //   true, // withStateFile
  //   undefined, // signerOrOptions
  //   vaultHubInitData,
  // );

  // const vaultHub = await loadContract<VaultHub>("VaultHub", vaultHub_.address);

  // //
  // // Deploy PredepositGuarantee
  // //

  // // Prepare initialization data for PredepositGuarantee.initialize(address admin)
  // const predepositGuaranteeInterface = await ethers.getContractFactory("PredepositGuarantee");
  // const predepositGuaranteeInitData = predepositGuaranteeInterface.interface.encodeFunctionData("initialize", [
  //   v3TemporaryAdmin.address,
  // ]);

  // const predepositGuarantee_ = await deployBehindOssifiableProxy(
  //   Sk.predepositGuarantee,
  //   "PredepositGuarantee",
  //   proxyContractsOwner,
  //   deployer,
  //   [
  //     pdgDeployParams.genesisForkVersion,
  //     pdgDeployParams.gIndex,
  //     pdgDeployParams.gIndexAfterChange,
  //     pdgDeployParams.changeSlot,
  //   ],
  //   null, // implementation
  //   true, // withStateFile
  //   undefined, // signerOrOptions
  //   predepositGuaranteeInitData,
  // );

  // const predepositGuarantee = await loadContract<PredepositGuarantee>(
  //   "PredepositGuarantee",
  //   predepositGuarantee_.address,
  // );

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
      oldCheckerLimits.simulatedShareRateDeviationBPLimit,
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

  // //
  // // Deploy OperatorGrid
  // //

  // const gridParams = parameters.operatorGrid;
  // const defaultTierParams = {
  //   shareLimit: ether(gridParams.defaultTierParams.shareLimitInEther),
  //   reserveRatioBP: gridParams.defaultTierParams.reserveRatioBP,
  //   forcedRebalanceThresholdBP: gridParams.defaultTierParams.forcedRebalanceThresholdBP,
  //   infraFeeBP: gridParams.defaultTierParams.infraFeeBP,
  //   liquidityFeeBP: gridParams.defaultTierParams.liquidityFeeBP,
  //   reservationFeeBP: gridParams.defaultTierParams.reservationFeeBP,
  // };

  // const operatorGridInterface = await ethers.getContractFactory("OperatorGrid");
  // const operatorGridInitData = operatorGridInterface.interface.encodeFunctionData("initialize", [
  //   v3TemporaryAdmin.address,
  //   defaultTierParams,
  // ]);

  // const operatorGrid_ = await deployBehindOssifiableProxy(
  //   Sk.operatorGrid,
  //   "OperatorGrid",
  //   proxyContractsOwner,
  //   deployer,
  //   [locatorAddress],
  //   null, // implementation
  //   true, // withStateFile
  //   undefined, // signerOrOptions
  //   operatorGridInitData,
  // );

  // const operatorGrid = await loadContract<OperatorGrid>("OperatorGrid", operatorGrid_.address);

  //
  // Deploy new LidoLocator implementation
  //
  const locatorConfig: LidoLocator.ConfigStruct = {
    accountingOracle: await locator.accountingOracle(),
    depositSecurityModule: await locator.depositSecurityModule(),
    elRewardsVault: await locator.elRewardsVault(),
    lido: lidoAddress,
    oracleReportSanityChecker: newSanityChecker.address,
    // postTokenRebaseReceiver: newTokenRateNotifier.address,
    // burner: burner.address,
    stakingRouter: await locator.stakingRouter(),
    treasury: treasuryAddress,
    validatorsExitBusOracle: await locator.validatorsExitBusOracle(),
    withdrawalQueue: await locator.withdrawalQueue(),
    withdrawalVault: await locator.withdrawalVault(),
    oracleDaemonConfig: await locator.oracleDaemonConfig(),
    validatorExitDelayVerifier: getAddress(Sk.validatorExitDelayVerifier, state),
    triggerableWithdrawalsGateway: getAddress(Sk.triggerableWithdrawalsGateway, state),
    accounting: accounting.address,
    // predepositGuarantee: predepositGuarantee.address,
    wstETH: wstethAddress,
    // vaultHub: vaultHub.address,
    // vaultFactory: vaultFactory.address,
    // lazyOracle: lazyOracle.address,
    // operatorGrid: operatorGrid.address,
  };
  const lidoLocatorImpl = await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [locatorConfig]);

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
  // GateSeal
  //

  // const gateSealFactory = await loadContract<IGateSealFactory>(
  //   "IGateSealFactory",
  //   getAddress(Sk.gateSealFactory, state),
  // );

  // // Calculate expiryTimestamp as current block timestamp + 1 year (in seconds)
  // const latestBlock = await ethers.provider.getBlock("latest");
  // const expiryTimestamp = latestBlock!.timestamp + 365 * 24 * 60 * 60;

  // const gateSealReceipt = await makeTx(
  //   gateSealFactory,
  //   "create_gate_seal",
  //   [
  //     parameters.gateSealForVaults.sealingCommittee,
  //     parameters.gateSealForVaults.sealDuration,
  //     [vaultHub.address, predepositGuarantee.address],
  //     expiryTimestamp,
  //   ],
  //   { from: deployer },
  // );
  // const gateSealAddress = await findEventsWithInterfaces(gateSealReceipt, "GateSealCreated", [
  //   gateSealFactory.interface,
  // ])[0].args.gate_seal;
  // console.log("GateSeal address", gateSealAddress);

  // updateObjectInState(Sk.gateSealV3, {
  //   address: gateSealAddress,
  // });
}
