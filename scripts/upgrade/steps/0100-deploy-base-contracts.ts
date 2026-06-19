import { ethers } from "hardhat";
import { checkArtifactDeployedAndLog, readUpgradeParameters } from "scripts/utils/upgrade";

import {
  Accounting__factory,
  AccountingOracle__factory,
  ConsolidationBus,
  ConsolidationBus__factory,
  ConsolidationGateway__factory,
  ConsolidationMigrator,
  ConsolidationMigrator__factory,
  DepositSecurityModule,
  DepositSecurityModule__factory,
  IOracleReportSanityChecker_preV4,
  Lido__factory,
  LidoLocator,
  LidoLocator__factory,
  OracleReportSanityChecker__factory,
  StakingRouter__factory,
  TopUpGateway,
  TopUpGateway__factory,
  UpgradeTemporaryAdmin,
  UpgradeTemporaryAdmin__factory,
  ValidatorsExitBusOracle__factory,
  WithdrawalVault__factory,
} from "typechain-types";

import {
  ConstructorArgs,
  deployBehindOssifiableProxy,
  deployImplementation,
  deployWithoutProxy,
  encodeFunctionCall,
  getAddress,
  InitializeArgs,
  loadContract,
  logArgs,
  logConfirmReview as logConfirmReview,
  logScriptHeader,
  logStartReview as logStartReview,
  makeTx,
  MethodArgs,
  readNetworkState,
  Sk,
} from "lib";

export async function skip(): Promise<boolean> {
  return await checkArtifactDeployedAndLog(Sk.upgradeTemporaryAdmin);
}

export async function main() {
  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  const deployer = (await ethers.provider.getSigner()).address;

  await logScriptHeader("SRv3/CMv2 — Deploy & setup Base Contracts", deployer);

  //
  //  Collect all param values
  //
  const chainSpec = state[Sk.chainSpec];
  const depositContractAddress = chainSpec.depositContract ?? chainSpec.depositContractAddress;
  if (!depositContractAddress) {
    throw new Error("Deposit contract address is missing in the state file");
  }

  const agentAddress = getAddress(Sk.appAgent, state);
  const easyTrackAddress = getAddress(Sk.easyTrack, state);
  const resealManagerAddress = getAddress(Sk.resealManager, state);
  const circuitBreakerAddress = getAddress(Sk.circuitBreaker, state);
  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

  const lidoAddress = await locator.lido();
  const stakingRouterAddress = await locator.stakingRouter();
  const accountingAddress = await locator.accounting();
  const triggerableWithdrawalsGatewayAddress = await locator.triggerableWithdrawalsGateway();

  const treasuryAddress = agentAddress;
  const proxyContractsOwner = agentAddress;

  // old sanity checker
  const oldSanityChecker = await loadContract<IOracleReportSanityChecker_preV4>(
    "IOracleReportSanityChecker_preV4",
    await locator.oracleReportSanityChecker(),
  );
  const oldCheckerLimits = await oldSanityChecker.getOracleReportLimits();
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
    externalPendingBalanceCapEth: parameters.oracleReportSanityChecker.externalPendingBalanceCapEth,
  };

  //
  // Deploy TemporaryAdmin
  //
  const tempAdminConstructorArgs: ConstructorArgs<UpgradeTemporaryAdmin__factory> = [agentAddress];
  logStartReview();
  await logArgs("UpgradeTemporaryAdmin", tempAdminConstructorArgs);
  await logConfirmReview();

  const tempAdmin = await deployWithoutProxy(
    Sk.upgradeTemporaryAdmin,
    "UpgradeTemporaryAdmin",
    deployer,
    tempAdminConstructorArgs,
  );

  const constructorArgs: {
    Lido: ConstructorArgs<Lido__factory>;
    Accounting: ConstructorArgs<Accounting__factory>;
    AccountingOracle: ConstructorArgs<AccountingOracle__factory>;
    ValidatorsExitBusOracle: ConstructorArgs<ValidatorsExitBusOracle__factory>;
    StakingRouter: ConstructorArgs<StakingRouter__factory>;
    TopUpGateway: ConstructorArgs<TopUpGateway__factory>;
    DepositSecurityModule: ConstructorArgs<DepositSecurityModule__factory>;
    OracleReportSanityChecker: ConstructorArgs<OracleReportSanityChecker__factory>;
    ConsolidationGateway: ConstructorArgs<ConsolidationGateway__factory>;
  } = {
    Lido: [],
    Accounting: [locatorAddress, lidoAddress],
    AccountingOracle: [locatorAddress, Number(chainSpec.secondsPerSlot), Number(chainSpec.genesisTime)],
    ValidatorsExitBusOracle: [Number(chainSpec.secondsPerSlot), Number(chainSpec.genesisTime), locatorAddress],
    StakingRouter: [
      depositContractAddress,
      lidoAddress,
      locatorAddress,
      parameters.stakingRouter.maxEBType1,
      parameters.stakingRouter.maxEBType2,
    ],
    TopUpGateway: [
      locatorAddress,
      parameters.topUpGateway.gIFirstValidatorPrev,
      parameters.topUpGateway.gIFirstValidatorCurr,
      parameters.topUpGateway.pivotSlot,
      chainSpec.slotsPerEpoch,
    ],
    DepositSecurityModule: [
      lidoAddress,
      depositContractAddress,
      stakingRouterAddress,
      parameters.depositSecurityModule.pauseIntentValidityPeriodBlocks,
      parameters.depositSecurityModule.maxOperatorsPerUnvetting,
    ],
    OracleReportSanityChecker: [locatorAddress, accountingAddress, agentAddress, newCheckerLimits],
    ConsolidationGateway: [
      tempAdmin.address, // grant DEFAULT_ADMIT role to TemporaryAdmin,
      locatorAddress,
      parameters.consolidationGateway.maxConsolidationRequestsLimit,
      parameters.consolidationGateway.consolidationsPerFrame,
      parameters.consolidationGateway.frameDurationInSec,
      parameters.consolidationGateway.gIFirstValidatorPrev,
      parameters.consolidationGateway.gIFirstValidatorCurr,
      parameters.consolidationGateway.pivotSlot,
    ],
  };

  const topUpGatewayInitArgs: InitializeArgs<TopUpGateway> = [
    tempAdmin.address, // grant DEFAULT_ADMIT role to TemporaryAdmin
    parameters.topUpGateway.maxValidatorsPerTopUp,
    parameters.topUpGateway.minBlockDistance,
    parameters.topUpGateway.maxRootAge,
    parameters.topUpGateway.targetBalanceGwei,
    parameters.topUpGateway.minTopUpGwei,
  ];

  logStartReview();
  await logArgs("Lido", constructorArgs.Lido);
  await logArgs("Accounting", constructorArgs.Accounting);
  await logArgs("AccountingOracle", constructorArgs.AccountingOracle);
  await logArgs("ValidatorsExitBusOracle", constructorArgs.ValidatorsExitBusOracle);
  await logArgs("StakingRouter", constructorArgs.StakingRouter);
  await logArgs("TopUpGateway", constructorArgs.TopUpGateway);
  await logArgs("TopUpGateway", topUpGatewayInitArgs, "initialize", "proxy init.");
  await logArgs("DepositSecurityModule", constructorArgs.DepositSecurityModule);
  await logArgs("OracleReportSanityChecker", constructorArgs.OracleReportSanityChecker);
  await logArgs("ConsolidationGateway", constructorArgs.ConsolidationGateway);
  await logConfirmReview();

  //
  // Deploy Lido new implementation
  //
  await deployImplementation(Sk.appLido, "Lido", deployer, constructorArgs.Lido);

  //
  // Deploy Accounting & AccountingOracle
  //
  await deployImplementation(Sk.accounting, "Accounting", deployer, constructorArgs.Accounting);
  await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, constructorArgs.AccountingOracle);

  //
  // Deploy ValidatorsExitBusOracle
  //
  await deployImplementation(
    Sk.validatorsExitBusOracle,
    "ValidatorsExitBusOracle",
    deployer,
    constructorArgs.ValidatorsExitBusOracle,
  );

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

  await deployImplementation(Sk.stakingRouter, "StakingRouter", deployer, constructorArgs.StakingRouter, {
    libraries: {
      BeaconChainDepositor: beaconChainDepositor.address,
      SRLib: srLib.address,
    },
  });

  //
  // Deploy TopUpGateway
  //
  const topUpGateway = await deployBehindOssifiableProxy(
    Sk.topUpGateway,
    "TopUpGateway",
    proxyContractsOwner,
    deployer,
    constructorArgs.TopUpGateway,
    null, // implementation
    true, // withStateFile
    undefined, // factoryOptions
    await encodeFunctionCall<InitializeArgs<TopUpGateway>>("TopUpGateway", "initialize", topUpGatewayInitArgs),
  );

  //
  // Deploy  DepositSecurityModule
  //
  const depositSecurityModule_ = await deployWithoutProxy(
    Sk.depositSecurityModule,
    "DepositSecurityModule",
    deployer,
    constructorArgs.DepositSecurityModule,
  );
  const depositSecurityModule = await loadContract<DepositSecurityModule>(
    "DepositSecurityModule",
    depositSecurityModule_.address,
  );
  await depositSecurityModule.setOwner(tempAdmin.address);

  //
  // Deploy OracleReportSanityChecker
  //
  const oracleReportSanityChecker = await deployWithoutProxy(
    Sk.oracleReportSanityChecker,
    "OracleReportSanityChecker",
    deployer,
    constructorArgs.OracleReportSanityChecker,
  );

  //
  // Deploy Consolidation Gateway
  //
  const consolidationGateway = await deployWithoutProxy(
    Sk.consolidationGateway,
    "ConsolidationGateway",
    deployer,
    constructorArgs.ConsolidationGateway,
  );

  //
  // Deploy Consolidation Bus
  //
  const consolidationBusConstructorArgs: ConstructorArgs<ConsolidationBus__factory> = [consolidationGateway.address];
  const consolidationBusInitArgs: InitializeArgs<ConsolidationBus> = [
    tempAdmin.address, // grant DEFAULT_ADMIT role to TemporaryAdmin
    parameters.consolidationBus.initialBatchSize,
    parameters.consolidationBus.initialMaxGroupsInBatch,
    parameters.consolidationBus.initialExecutionDelay,
  ];

  logStartReview();
  await logArgs("ConsolidationBus", consolidationBusConstructorArgs);
  await logArgs("ConsolidationBus", consolidationBusInitArgs, "initialize", "proxy init.");
  await logConfirmReview();

  const consolidationBus = await deployBehindOssifiableProxy(
    Sk.consolidationBus,
    "ConsolidationBus",
    proxyContractsOwner,
    deployer,
    consolidationBusConstructorArgs,
    null, // implementation
    true, // withStateFile
    undefined, // factoryOptions
    await encodeFunctionCall<InitializeArgs<ConsolidationBus>>(
      "ConsolidationBus",
      "initialize",
      consolidationBusInitArgs,
    ),
  );

  //
  // Deploy Consolidation Migrator
  //
  const consolidationMigratorConstructorArgs: ConstructorArgs<ConsolidationMigrator__factory> = [
    stakingRouterAddress,
    consolidationBus.address,
    parameters.consolidationMigrator.sourceModuleId,
    parameters.consolidationMigrator.targetModuleId,
  ];
  const consolidationMigratorInitArgs: InitializeArgs<ConsolidationMigrator> = [
    tempAdmin.address, // grant DEFAULT_ADMIT role to TemporaryAdmin
  ];

  logStartReview();
  await logArgs("ConsolidationMigrator", consolidationMigratorConstructorArgs);
  await logArgs("ConsolidationMigrator", consolidationMigratorInitArgs, "initialize", "proxy init.");
  await logConfirmReview();

  const consolidationMigrator = await deployBehindOssifiableProxy(
    Sk.consolidationMigrator,
    "ConsolidationMigrator",
    proxyContractsOwner,
    deployer,
    consolidationMigratorConstructorArgs,
    null, // implementation
    true, // withStateFile
    undefined, // factoryOptions
    await encodeFunctionCall<InitializeArgs<ConsolidationMigrator>>(
      "ConsolidationMigrator",
      "initialize",
      consolidationMigratorInitArgs,
    ),
  );

  //
  // Deploy Withdrawal Vault implementation
  //
  const withdrawalVaultConstructorArgs: ConstructorArgs<WithdrawalVault__factory> = [
    lidoAddress,
    treasuryAddress,
    triggerableWithdrawalsGatewayAddress,
    consolidationGateway.address,
    parameters.withdrawalVault.withdrawalRequestContract,
    parameters.withdrawalVault.consolidationRequestContract,
  ];

  logStartReview();
  await logArgs("WithdrawalVault", withdrawalVaultConstructorArgs);
  await logConfirmReview();

  await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, withdrawalVaultConstructorArgs);

  // todo match locator vs state
  //
  // Deploy Lido Locator new implementation
  //
  const locatorConfig: LidoLocator.ConfigStruct = {
    accountingOracle: await locator.accountingOracle(),
    depositSecurityModule: depositSecurityModule.address,
    elRewardsVault: await locator.elRewardsVault(),
    lido: lidoAddress,
    oracleReportSanityChecker: oracleReportSanityChecker.address,
    postTokenRebaseReceiver: await locator.postTokenRebaseReceiver(),
    burner: await locator.burner(),
    stakingRouter: stakingRouterAddress,
    treasury: await locator.treasury(),
    validatorsExitBusOracle: await locator.validatorsExitBusOracle(),
    withdrawalQueue: await locator.withdrawalQueue(),
    withdrawalVault: await locator.withdrawalVault(),
    oracleDaemonConfig: await locator.oracleDaemonConfig(),
    validatorExitDelayVerifier: await locator.validatorExitDelayVerifier(),
    triggerableWithdrawalsGateway: triggerableWithdrawalsGatewayAddress,
    consolidationGateway: consolidationGateway.address,
    accounting: accountingAddress,
    predepositGuarantee: await locator.predepositGuarantee(),
    wstETH: await locator.wstETH(),
    vaultHub: await locator.vaultHub(),
    vaultFactory: await locator.vaultFactory(),
    lazyOracle: await locator.lazyOracle(),
    operatorGrid: await locator.operatorGrid(),
    topUpGateway: topUpGateway.address,
  };

  const lidoLocatorConstructorArgs: ConstructorArgs<LidoLocator__factory> = [locatorConfig];

  logStartReview();
  await logArgs("LidoLocator", lidoLocatorConstructorArgs);
  await logConfirmReview();

  const lidoLocatorImpl = await deployImplementation(
    Sk.lidoLocator,
    "LidoLocator",
    deployer,
    lidoLocatorConstructorArgs,
  );

  //
  // Complete setup: grant all roles to agent, transfer admin
  //
  const tempAdminCompleteSetupArgs: MethodArgs<UpgradeTemporaryAdmin, "completeSetup"> = [
    lidoLocatorImpl.address,
    easyTrackAddress,
    resealManagerAddress,
    circuitBreakerAddress,
    consolidationMigrator.address,
    parameters.consolidationMigrator.committee!,
    consolidationBus.address,
    parameters.topUpGateway.depositor!,
    await locator.depositSecurityModule(),
  ];

  logStartReview();
  await logArgs("UpgradeTemporaryAdmin", tempAdminCompleteSetupArgs, "completeSetup", "complete initial setup");
  await logConfirmReview();

  await makeTx(
    tempAdmin,
    "completeSetup",
    [
      lidoLocatorImpl.address,
      easyTrackAddress,
      resealManagerAddress,
      circuitBreakerAddress,
      consolidationMigrator.address,
      parameters.consolidationMigrator.committee!,
      consolidationBus.address,
      parameters.topUpGateway.depositor!,
      await locator.depositSecurityModule(),
    ],
    {
      from: deployer,
    },
  );
}
