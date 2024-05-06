import { ethers } from "hardhat";

import { getContractPath } from "lib/contract";
import {
  deployBehindOssifiableProxy,
  deployContract,
  deployImplementation,
  deployWithoutProxy,
  updateProxyImplementation,
} from "lib/deploy";
import { log, logWideSplitter } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

async function main() {
  log.scriptStart(__filename);
  const deployer = (await ethers.provider.getSigner()).address;
  let state = readNetworkState({ deployer });

  const lidoAddress = state[Sk.appLido].proxy.address;
  const legacyOracleAddress = state[Sk.appOracle].proxy.address;
  const votingAddress = state[Sk.appVoting].proxy.address;
  const agentAddress = state[Sk.appAgent].proxy.address;
  const treasuryAddress = agentAddress;
  const chainSpec = state[Sk.chainSpec];
  const depositSecurityModuleParams = state[Sk.depositSecurityModule].deployParameters;
  const burnerParams = state[Sk.burner].deployParameters;
  const hashConsensusForAccountingParams = state[Sk.hashConsensusForAccountingOracle].deployParameters;
  const hashConsensusForExitBusParams = state[Sk.hashConsensusForValidatorsExitBusOracle].deployParameters;
  const withdrawalQueueERC721Params = state[Sk.withdrawalQueueERC721].deployParameters;

  const proxyContractsOwner = deployer;
  const admin = deployer;

  const sanityChecks = state["oracleReportSanityChecker"].deployParameters;
  logWideSplitter();

  if (!chainSpec.depositContract) {
    throw new Error(`please specify deposit contract address in state file at /chainSpec/depositContract`);
  }
  const depositContract = state.chainSpec.depositContract;

  //
  // === OracleDaemonConfig ===
  //
  const oracleDaemonConfigArgs = [admin, []];
  const oracleDaemonConfig = await deployWithoutProxy(
    Sk.oracleDaemonConfig,
    "OracleDaemonConfig",
    deployer,
    oracleDaemonConfigArgs,
  );
  logWideSplitter();

  //
  // === DummyEmptyContract ===
  //
  const dummyContract = await deployWithoutProxy(Sk.dummyEmptyContract, "DummyEmptyContract", deployer);

  //
  // === LidoLocator: dummy invalid implementation ===
  //
  const locator = await deployBehindOssifiableProxy(
    Sk.lidoLocator,
    "DummyEmptyContract",
    proxyContractsOwner,
    deployer,
    [],
    dummyContract.address,
  );
  logWideSplitter();

  //
  // === OracleReportSanityChecker ===
  //
  const oracleReportSanityCheckerArgs = [
    locator.address,
    admin,
    [
      sanityChecks.churnValidatorsPerDayLimit,
      sanityChecks.oneOffCLBalanceDecreaseBPLimit,
      sanityChecks.annualBalanceIncreaseBPLimit,
      sanityChecks.simulatedShareRateDeviationBPLimit,
      sanityChecks.maxValidatorExitRequestsPerReport,
      sanityChecks.maxAccountingExtraDataListItemsCount,
      sanityChecks.maxNodeOperatorsPerExtraDataItemCount,
      sanityChecks.requestTimestampMargin,
      sanityChecks.maxPositiveTokenRebase,
    ],
    [[], [], [], [], [], [], [], [], [], []],
  ];
  const oracleReportSanityChecker = await deployWithoutProxy(
    Sk.oracleReportSanityChecker,
    "OracleReportSanityChecker",
    deployer,
    oracleReportSanityCheckerArgs,
  );
  logWideSplitter();

  //
  // === EIP712StETH ===
  //
  await deployWithoutProxy(Sk.eip712StETH, "EIP712StETH", deployer, [lidoAddress]);
  logWideSplitter();

  //
  // === WstETH ===
  //
  const wstETH = await deployWithoutProxy(Sk.wstETH, "WstETH", deployer, [lidoAddress]);
  logWideSplitter();

  //
  // === WithdrawalQueueERC721 ===
  //
  const withdrawalQueueERC721Args = [
    wstETH.address,
    withdrawalQueueERC721Params.name,
    withdrawalQueueERC721Params.symbol,
  ];
  const withdrawalQueueERC721 = await deployBehindOssifiableProxy(
    Sk.withdrawalQueueERC721,
    "WithdrawalQueueERC721",
    proxyContractsOwner,
    deployer,
    withdrawalQueueERC721Args,
  );
  logWideSplitter();

  //
  // === LidoExecutionLayerRewardsVault ===
  //
  const elRewardsVault = await deployWithoutProxy(
    Sk.executionLayerRewardsVault,
    "LidoExecutionLayerRewardsVault",
    deployer,
    [lidoAddress, treasuryAddress],
  );
  logWideSplitter();

  //
  // === StakingRouter ===
  //
  const stakingRouter = await deployBehindOssifiableProxy(
    Sk.stakingRouter,
    "StakingRouter",
    proxyContractsOwner,
    deployer,
    [depositContract],
  );

  //
  // === DepositSecurityModule ===
  //
  let depositSecurityModuleAddress = depositSecurityModuleParams.usePredefinedAddressInstead;
  if (depositSecurityModuleAddress === null) {
    const { maxDepositsPerBlock, minDepositBlockDistance, pauseIntentValidityPeriodBlocks } =
      depositSecurityModuleParams;
    const depositSecurityModuleArgs = [
      lidoAddress,
      depositContract,
      stakingRouter.address,
      maxDepositsPerBlock,
      minDepositBlockDistance,
      pauseIntentValidityPeriodBlocks,
    ];
    depositSecurityModuleAddress = (
      await deployWithoutProxy(Sk.depositSecurityModule, "DepositSecurityModule", deployer, depositSecurityModuleArgs)
    ).address;
  } else {
    log(
      `NB: skipping deployment of DepositSecurityModule - using the predefined address ${depositSecurityModuleAddress} instead`,
    );
  }
  logWideSplitter();

  //
  // === AccountingOracle ===
  //
  const accountingOracleArgs = [
    locator.address,
    lidoAddress,
    legacyOracleAddress,
    Number(chainSpec.secondsPerSlot),
    Number(chainSpec.genesisTime),
  ];
  const accountingOracle = await deployBehindOssifiableProxy(
    Sk.accountingOracle,
    "AccountingOracle",
    proxyContractsOwner,
    deployer,
    accountingOracleArgs,
  );
  logWideSplitter();

  //
  // === HashConsensus for AccountingOracle ===
  //
  const hashConsensusForAccountingArgs = [
    chainSpec.slotsPerEpoch,
    chainSpec.secondsPerSlot,
    chainSpec.genesisTime,
    hashConsensusForAccountingParams.epochsPerFrame,
    hashConsensusForAccountingParams.fastLaneLengthSlots,
    admin, // admin
    accountingOracle.address, // reportProcessor
  ];
  await deployWithoutProxy(
    Sk.hashConsensusForAccountingOracle,
    "HashConsensus",
    deployer,
    hashConsensusForAccountingArgs,
  );
  logWideSplitter();

  //
  // === ValidatorsExitBusOracle ===
  //
  const validatorsExitBusOracleArgs = [chainSpec.secondsPerSlot, chainSpec.genesisTime, locator.address];
  const validatorsExitBusOracle = await deployBehindOssifiableProxy(
    Sk.validatorsExitBusOracle,
    "ValidatorsExitBusOracle",
    proxyContractsOwner,
    deployer,
    validatorsExitBusOracleArgs,
  );
  logWideSplitter();

  //
  // === HashConsensus for ValidatorsExitBusOracle ===
  //
  const hashConsensusForExitBusArgs = [
    chainSpec.slotsPerEpoch,
    chainSpec.secondsPerSlot,
    chainSpec.genesisTime,
    hashConsensusForExitBusParams.epochsPerFrame,
    hashConsensusForExitBusParams.fastLaneLengthSlots,
    admin, // admin
    validatorsExitBusOracle.address, // reportProcessor
  ];
  await deployWithoutProxy(
    Sk.hashConsensusForValidatorsExitBusOracle,
    "HashConsensus",
    deployer,
    hashConsensusForExitBusArgs,
  );
  logWideSplitter();

  //
  // === TriggerableExitMock ===
  //
  const triggerableExitMock = await deployWithoutProxy(Sk.triggerableExitMock, "TriggerableExitMock", deployer);
  logWideSplitter();

  //
  // === WithdrawalVault ===
  //
  const withdrawalVaultImpl = await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, [
    lidoAddress,
    treasuryAddress,
    validatorsExitBusOracle.address,
    triggerableExitMock.address,
  ]);
  state = readNetworkState();
  const withdrawalsManagerProxyConstructorArgs = [votingAddress, withdrawalVaultImpl.address];
  const withdrawalsManagerProxy = await deployContract(
    "WithdrawalsManagerProxy",
    withdrawalsManagerProxyConstructorArgs,
    deployer,
  );
  const withdrawalVaultAddress = withdrawalsManagerProxy.address;
  updateObjectInState(Sk.withdrawalVault, {
    proxy: {
      contract: await getContractPath("WithdrawalsManagerProxy"),
      address: withdrawalsManagerProxy.address,
      constructorArgs: withdrawalsManagerProxyConstructorArgs,
    },
    address: withdrawalsManagerProxy.address,
  });
  logWideSplitter();

  //
  // === Burner ===
  //
  const burnerArgs = [
    admin,
    treasuryAddress,
    lidoAddress,
    burnerParams.totalCoverSharesBurnt,
    burnerParams.totalNonCoverSharesBurnt,
  ];
  const burner = await deployWithoutProxy(Sk.burner, "Burner", deployer, burnerArgs);
  logWideSplitter();

  //
  // === LidoLocator: update to valid implementation ===
  //
  const postTokenRebaseReceiver = legacyOracleAddress;
  const locatorConfig: string[] = [
    accountingOracle.address,
    depositSecurityModuleAddress,
    elRewardsVault.address,
    legacyOracleAddress,
    lidoAddress,
    oracleReportSanityChecker.address,
    postTokenRebaseReceiver,
    burner.address,
    stakingRouter.address,
    treasuryAddress,
    validatorsExitBusOracle.address,
    withdrawalQueueERC721.address,
    withdrawalVaultAddress,
    oracleDaemonConfig.address,
  ];
  await updateProxyImplementation(Sk.lidoLocator, "LidoLocator", locator.address, proxyContractsOwner, [locatorConfig]);

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
