import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import {
  ConsolidationBus,
  ConsolidationMigrator,
  IGateSealFactory,
  IOracleReportSanityChecker_preV4,
  LidoLocator,
  TopUpGateway,
  UpgradeTemporaryAdmin,
} from "typechain-types";

import { findEventsWithInterfaces } from "lib";
import { loadContract } from "lib/contract";
import { deployBehindOssifiableProxy, deployImplementation, deployWithoutProxy, makeTx } from "lib/deploy";
import { getAddress, readNetworkState, Sk, updateObjectInState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState();
  const parameters = readUpgradeParameters();

  const agentAddress = getAddress(Sk.appAgent, state);
  const treasuryAddress = agentAddress;
  const lidoAddress = getAddress(Sk.appLido, state);
  const easyTrackAddress = getAddress(Sk.easyTrack, state);
  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const stakingRouterAddress = getAddress(Sk.stakingRouter, state);
  const accountingAddress = getAddress(Sk.accounting, state);
  const withdrawalVaultAddress = getAddress(Sk.withdrawalVault, state);
  const triggerableWithdrawalsGatewayAddress = getAddress(Sk.triggerableWithdrawalsGateway, state);
  const validatorExitDelayVerifierAddress = getAddress(Sk.validatorExitDelayVerifier, state);
  const wstETHAddress = getAddress(Sk.wstETH, state);

  const proxyContractsOwner = agentAddress;

  const chainSpec = state[Sk.chainSpec];
  const depositContractAddress = chainSpec.depositContract ?? chainSpec.depositContractAddress;
  if (!depositContractAddress) {
    throw new Error("Deposit contract address is missing in the state file");
  }
  const resealManagerAddress = state[Sk.resealManager].address;

  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

  //
  // Deploy TemporaryAdmin
  //
  const tempAdmin = await deployWithoutProxy(Sk.upgradeTemporaryAdmin, "UpgradeTemporaryAdmin", deployer, [
    agentAddress,
  ]);

  //
  // Deploy Lido new implementation
  //
  await deployImplementation(Sk.appLido, "Lido", deployer);

  //
  // Deploy Accounting & AccountingOracle
  //
  await deployImplementation(Sk.accounting, "Accounting", deployer, [locatorAddress, lidoAddress]);
  await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, [
    locatorAddress,
    Number(chainSpec.secondsPerSlot),
    Number(chainSpec.genesisTime),
  ]);

  //
  // Deploy ValidatorsExitBusOracle
  //
  await deployImplementation(Sk.validatorsExitBusOracle, "ValidatorsExitBusOracle", deployer, [
    Number(chainSpec.secondsPerSlot),
    Number(chainSpec.genesisTime),
    locatorAddress,
  ]);

  //
  // Deploy libraries & StakingRouter
  //
  const beaconChainDepositor = await deployWithoutProxy(Sk.beaconChainDepositor, "BeaconChainDepositor", deployer);
  const minFirstAllocationStrategy = await deployWithoutProxy(
    Sk.minFirstAllocationStrategy,
    "MinFirstAllocationStrategy",
    deployer,
  );
  const srLib = await deployWithoutProxy(Sk.srLib, "SRLib", deployer, [], "address", true, {
    libraries: {
      MinFirstAllocationStrategy: minFirstAllocationStrategy.address,
    },
  });

  await deployImplementation(
    Sk.stakingRouter,
    "StakingRouter",
    deployer,
    [
      depositContractAddress,
      lidoAddress,
      locatorAddress,
      parameters.stakingRouter.maxEBType1,
      parameters.stakingRouter.maxEBType2,
    ],
    {
      libraries: {
        BeaconChainDepositor: beaconChainDepositor.address,
        SRLib: srLib.address,
      },
    },
  );

  //
  // Deploy TopUpGateway
  //
  const topUpGatewayInterface = await ethers.getContractFactory("TopUpGateway");
  const topUpGatewayInitData = topUpGatewayInterface.interface.encodeFunctionData("initialize", [
    tempAdmin.address, // grant DEFAULT_ADMIT role to TemporaryAdmin
    parameters.topUpGateway.maxValidatorsPerTopUp,
    parameters.topUpGateway.minBlockDistance,
    parameters.topUpGateway.maxRootAge,
    parameters.topUpGateway.targetBalanceGwei,
    parameters.topUpGateway.minTopUpGwei,
  ]);

  const topUpGateway = await deployBehindOssifiableProxy(
    Sk.topUpGateway,
    "TopUpGateway",
    proxyContractsOwner,
    deployer,
    [
      locatorAddress,
      parameters.topUpGateway.gIFirstValidatorPrev,
      parameters.topUpGateway.gIFirstValidatorCurr,
      parameters.topUpGateway.pivotSlot,
      chainSpec.slotsPerEpoch,
    ],
    null, // implementation
    true, // withStateFile
    undefined, // factoryOptions
    topUpGatewayInitData,
  );

  //
  // Deploy  DepositSecurityModule
  //
  const depositSecurityModule = await deployWithoutProxy(Sk.depositSecurityModule, "DepositSecurityModule", deployer, [
    lidoAddress,
    depositContractAddress,
    stakingRouterAddress,
    parameters.depositSecurityModule.pauseIntentValidityPeriodBlocks,
    parameters.depositSecurityModule.maxOperatorsPerUnvetting,
  ]);

  //
  // Deploy OracleReportSanityChecker
  //
  const oldSanityChecker = await loadContract<IOracleReportSanityChecker_preV4>(
    "IOracleReportSanityChecker_preV4",
    await locator.oracleReportSanityChecker(),
  );
  const oldCheckerLimits = await oldSanityChecker.getOracleReportLimits();

  // TODO: confirm that old values for some params are correct
  const newCheckerLimits = {
    exitedEthAmountPerDayLimit: parameters.oracleReportSanityChecker.exitedEthAmountPerDayLimit,
    appearedEthAmountPerDayLimit: parameters.oracleReportSanityChecker.appearedEthAmountPerDayLimit,
    annualBalanceIncreaseBPLimit: oldCheckerLimits.annualBalanceIncreaseBPLimit,
    simulatedShareRateDeviationBPLimit: oldCheckerLimits.simulatedShareRateDeviationBPLimit,
    maxBalanceExitRequestedPerReportInEth: parameters.oracleReportSanityChecker.maxBalanceExitRequestedPerReportInEth,
    maxEffectiveBalanceWeightWCType01: parameters.oracleReportSanityChecker.maxEffectiveBalanceWeightWCType01,
    maxEffectiveBalanceWeightWCType02: parameters.oracleReportSanityChecker.maxEffectiveBalanceWeightWCType02,
    maxItemsPerExtraDataTransaction: oldCheckerLimits.maxItemsPerExtraDataTransaction,
    maxNodeOperatorsPerExtraDataItem: oldCheckerLimits.maxNodeOperatorsPerExtraDataItem,
    requestTimestampMargin: oldCheckerLimits.requestTimestampMargin,
    maxPositiveTokenRebase: oldCheckerLimits.maxPositiveTokenRebase,
    maxCLBalanceDecreaseBP: parameters.oracleReportSanityChecker.maxCLBalanceDecreaseBP,
    clBalanceOraclesErrorUpperBPLimit: oldCheckerLimits.clBalanceOraclesErrorUpperBPLimit,
    consolidationEthAmountPerDayLimit: parameters.oracleReportSanityChecker.consolidationEthAmountPerDayLimit,
    exitedValidatorEthAmountLimit: parameters.oracleReportSanityChecker.exitedValidatorEthAmountLimit,
  };

  const newSanityChecker = await deployWithoutProxy(
    Sk.oracleReportSanityChecker,
    "OracleReportSanityChecker",
    deployer,
    [locatorAddress, accountingAddress, agentAddress, newCheckerLimits],
  );

  //
  // Deploy Consolidation Gateway
  //
  const consolidationGateway = await deployWithoutProxy(Sk.consolidationGateway, "ConsolidationGateway", deployer, [
    tempAdmin.address, // grant DEFAULT_ADMIT role to TemporaryAdmin,
    locatorAddress,
    parameters.consolidationGateway.maxConsolidationRequestsLimit,
    parameters.consolidationGateway.consolidationsPerFrame,
    parameters.consolidationGateway.frameDurationInSec,
    parameters.consolidationGateway.gIFirstValidatorPrev,
    parameters.consolidationGateway.gIFirstValidatorCurr,
    parameters.consolidationGateway.pivotSlot,
  ]);

  //
  // Deploy Consolidation Bus
  //
  const consolidationBusInterface = await ethers.getContractFactory("ConsolidationBus");
  const consolidationBusInitData = consolidationBusInterface.interface.encodeFunctionData("initialize", [
    tempAdmin.address, // grant DEFAULT_ADMIT role to TemporaryAdmin
    parameters.consolidationBus.initialBatchSize,
    parameters.consolidationBus.initialMaxGroupsInBatch,
    parameters.consolidationBus.initialExecutionDelay,
  ]);
  const consolidationBus_ = await deployBehindOssifiableProxy(
    Sk.consolidationBus,
    "ConsolidationBus",
    proxyContractsOwner,
    deployer,
    [consolidationGateway.address],
    null, // implementation
    true, // withStateFile
    undefined, // factoryOptions
    consolidationBusInitData,
  );

  const consolidationBus = await loadContract<ConsolidationBus>("ConsolidationBus", consolidationBus_.address);

  //
  // Deploy Consolidation Migrator
  //
  const consolidationMigratorInterface = await ethers.getContractFactory("ConsolidationMigrator");
  const consolidationMigratorInitData = consolidationMigratorInterface.interface.encodeFunctionData("initialize", [
    tempAdmin.address, // grant DEFAULT_ADMIT role to TemporaryAdmin
  ]);

  const consolidationMigrator = await deployBehindOssifiableProxy(
    Sk.consolidationMigrator,
    "ConsolidationMigrator",
    proxyContractsOwner,
    deployer,
    [
      stakingRouterAddress,
      consolidationBus.address,
      parameters.consolidationMigrator.sourceModuleId,
      parameters.consolidationMigrator.targetModuleId,
    ],
    null, // implementation
    true, // withStateFile
    undefined, // factoryOptions
    consolidationMigratorInitData,
  );

  //
  // Deploy Withdrawal Vault implementation
  //
  await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, [
    lidoAddress,
    treasuryAddress,
    triggerableWithdrawalsGatewayAddress,
    consolidationGateway.address,
    parameters.withdrawalVault.withdrawalRequestContract,
    parameters.withdrawalVault.consolidationRequestContract,
  ]);

  //
  // Deploy Lido Locator new implementation
  //
  const locatorConfig: LidoLocator.ConfigStruct = {
    accountingOracle: await locator.accountingOracle(),
    depositSecurityModule: depositSecurityModule.address,
    elRewardsVault: await locator.elRewardsVault(),
    lido: lidoAddress,
    oracleReportSanityChecker: newSanityChecker.address,
    postTokenRebaseReceiver: await locator.postTokenRebaseReceiver(),
    burner: await locator.burner(),
    stakingRouter: stakingRouterAddress,
    treasury: await locator.treasury(),
    validatorsExitBusOracle: await locator.validatorsExitBusOracle(),
    withdrawalQueue: await locator.withdrawalQueue(),
    withdrawalVault: withdrawalVaultAddress,
    oracleDaemonConfig: await locator.oracleDaemonConfig(),
    validatorExitDelayVerifier: validatorExitDelayVerifierAddress,
    triggerableWithdrawalsGateway: triggerableWithdrawalsGatewayAddress,
    consolidationGateway: consolidationGateway.address,
    accounting: accountingAddress,
    predepositGuarantee: await locator.predepositGuarantee(),
    wstETH: wstETHAddress,
    vaultHub: await locator.vaultHub(),
    vaultFactory: await locator.vaultFactory(),
    lazyOracle: await locator.lazyOracle(),
    operatorGrid: await locator.operatorGrid(),
    topUpGateway: topUpGateway.address,
  };

  const lidoLocatorImpl = await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [locatorConfig]);

  //
  // GateSeal
  //

  const gateSealFactory = await loadContract<IGateSealFactory>(
    "IGateSealFactory",
    getAddress(Sk.gateSealFactory, state),
  );

  // Calculate expiryTimestamp as current block timestamp + 1 year (in seconds)
  const latestBlock = await ethers.provider.getBlock("latest");
  const expiryTimestamp = latestBlock!.timestamp + 365 * 24 * 60 * 60;

  const gateSealReceipt = await makeTx(
    gateSealFactory,
    "create_gate_seal",
    [
      parameters.consolidationGatewayGateSeal.sealingCommittee,
      parameters.consolidationGatewayGateSeal.sealDuration,
      [consolidationGateway.address],
      expiryTimestamp,
    ],
    { from: deployer },
  );
  const consolidationGateSealAddress = await findEventsWithInterfaces(gateSealReceipt, "GateSealCreated", [
    gateSealFactory.interface,
  ])[0].args.gate_seal;
  console.log("GateSeal address", consolidationGateSealAddress);

  updateObjectInState(Sk.gateSealConsolidationGW, {
    address: consolidationGateSealAddress,
  });

  //
  // Complete setup: grant all roles to agent, transfer admin
  //
  await makeTx(
    tempAdmin,
    "completeSetup",
    [
      lidoLocatorImpl.address,
      easyTrackAddress,
      resealManagerAddress,
      consolidationMigrator.address,
      parameters.consolidationMigrator.committee,
      consolidationBus.address,
      parameters.consolidationBus.executor,
      consolidationGateSealAddress,
      topUpGateway.address,
      parameters.topUpGateway.depositor,
    ],
    {
      from: deployer,
    },
  );
}
