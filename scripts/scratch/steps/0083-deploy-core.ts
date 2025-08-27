import { ethers } from "hardhat";

import { StakingRouter, TriggerableWithdrawalsGateway } from "typechain-types";

import { getContractPath, loadContract } from "lib/contract";
import {
  deployBehindOssifiableProxy,
  deployContract,
  deployImplementation,
  deployWithoutProxy,
  makeTx,
} from "lib/deploy";
import { log } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";
import { en0x } from "lib/string";

import { ACTIVE_VALIDATOR_PROOF } from "test/0.8.25/validatorState";

const ZERO_LAST_PROCESSING_REF_SLOT = 0;

// These exports are kept for compatibility with other modules that might import them
export const FIRST_SUPPORTED_SLOT = ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot;
export const PIVOT_SLOT = ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot;
export const CAPELLA_SLOT = ACTIVE_VALIDATOR_PROOF.beaconBlockHeader.slot;
export const SLOTS_PER_HISTORICAL_ROOT = 8192;

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  let state = readNetworkState({ deployer });

  // Extract necessary addresses and parameters from the state
  const lidoAddress = state[Sk.appLido].proxy.address;
  const treasuryAddress = state[Sk.appAgent].proxy.address;
  const chainSpec = state[Sk.chainSpec];
  const depositSecurityModuleParams = state[Sk.depositSecurityModule].deployParameters;
  const hashConsensusForAccountingParams = state[Sk.hashConsensusForAccountingOracle].deployParameters;
  const hashConsensusForExitBusParams = state[Sk.hashConsensusForValidatorsExitBusOracle].deployParameters;
  const withdrawalQueueERC721Params = state[Sk.withdrawalQueueERC721].deployParameters;
  const minFirstAllocationStrategyAddress = state[Sk.minFirstAllocationStrategy].address;
  const validatorExitDelayVerifierParams = state[Sk.validatorExitDelayVerifier].deployParameters;

  const proxyContractsOwner = deployer;
  const admin = deployer;

  if (!chainSpec.depositContract) {
    throw new Error(`please specify deposit contract address in state file at /chainSpec/depositContract`);
  }

  const depositContract = state.chainSpec.depositContract;

  //
  // Deploy dummy implementation

  const dummyContract = await deployWithoutProxy(Sk.dummyEmptyContract, "DummyEmptyContract", deployer);

  //
  // Deploy LidoLocator with dummy implementation
  //

  const locator = await deployBehindOssifiableProxy(
    Sk.lidoLocator,
    "DummyEmptyContract",
    proxyContractsOwner,
    deployer,
    [],
    dummyContract.address,
  );

  //
  // Deploy EIP712StETH
  //

  await deployWithoutProxy(Sk.eip712StETH, "EIP712StETH", deployer, [lidoAddress]);

  //
  // Deploy OracleDaemonConfig
  //

  const oracleDaemonConfig_ = await deployWithoutProxy(Sk.oracleDaemonConfig, "OracleDaemonConfig", deployer, [
    admin,
    [],
  ]);
  const oracleDaemonConfig = await loadContract("OracleDaemonConfig", oracleDaemonConfig_.address);
  const CONFIG_MANAGER_ROLE = await oracleDaemonConfig.getFunction("CONFIG_MANAGER_ROLE")();

  await makeTx(oracleDaemonConfig, "grantRole", [CONFIG_MANAGER_ROLE, deployer], { from: deployer });
  for (const [key, value] of Object.entries(state.oracleDaemonConfig.deployParameters)) {
    await makeTx(oracleDaemonConfig, "set", [key, en0x(value as number)], { from: deployer });
  }
  await makeTx(oracleDaemonConfig, "renounceRole", [CONFIG_MANAGER_ROLE, deployer], { from: deployer });

  //
  // Deploy WstETH
  //

  const wstETH = await deployWithoutProxy(Sk.wstETH, "WstETH", deployer, [lidoAddress]);

  //
  // Deploy WithdrawalQueueERC721
  //

  const withdrawalQueue_ = await deployBehindOssifiableProxy(
    Sk.withdrawalQueueERC721,
    "WithdrawalQueueERC721",
    proxyContractsOwner,
    deployer,
    [wstETH.address, withdrawalQueueERC721Params.name, withdrawalQueueERC721Params.symbol],
  );
  const withdrawalQueue = await loadContract("WithdrawalQueueERC721", withdrawalQueue_.address);
  const withdrawalQueueAdmin = deployer;
  await makeTx(withdrawalQueue, "initialize", [withdrawalQueueAdmin], { from: deployer });

  const withdrawalQueueBaseUri = state["withdrawalQueueERC721"].deployParameters.baseUri;
  if (withdrawalQueueBaseUri !== null && withdrawalQueueBaseUri !== "") {
    const MANAGE_TOKEN_URI_ROLE = await withdrawalQueue.getFunction("MANAGE_TOKEN_URI_ROLE")();
    await makeTx(withdrawalQueue, "grantRole", [MANAGE_TOKEN_URI_ROLE, deployer], { from: deployer });
    await makeTx(withdrawalQueue, "setBaseURI", [withdrawalQueueBaseUri], { from: deployer });
    await makeTx(withdrawalQueue, "renounceRole", [MANAGE_TOKEN_URI_ROLE, deployer], { from: deployer });
  }

  //
  // Deploy LidoExecutionLayerRewardsVault
  //

  await deployWithoutProxy(Sk.executionLayerRewardsVault, "LidoExecutionLayerRewardsVault", deployer, [
    lidoAddress,
    treasuryAddress,
  ]);

  // TODO: modify WMP to remove LIDO_VOTING
  const withdrawalsManagerProxyConstructorArgs = [deployer, dummyContract.address];
  const withdrawalsManagerProxy = await deployContract(
    "WithdrawalsManagerProxy",
    withdrawalsManagerProxyConstructorArgs,
    deployer,
  );

  state = updateObjectInState(Sk.withdrawalVault, {
    proxy: {
      contract: await getContractPath("WithdrawalsManagerProxy"),
      address: withdrawalsManagerProxy.address,
      constructorArgs: withdrawalsManagerProxyConstructorArgs,
    },
    address: withdrawalsManagerProxy.address,
  });

  //
  // Deploy StakingRouter
  //

  const stakingRouter_ = await deployBehindOssifiableProxy(
    Sk.stakingRouter,
    "StakingRouter",
    proxyContractsOwner,
    deployer,
    [depositContract],
    null,
    true,
    {
      libraries: { MinFirstAllocationStrategy: minFirstAllocationStrategyAddress },
    },
  );
  const withdrawalCredentials = `0x010000000000000000000000${withdrawalsManagerProxy.address.slice(2)}`;
  const stakingRouterAdmin = deployer;
  const stakingRouter = await loadContract<StakingRouter>("StakingRouter", stakingRouter_.address);
  await makeTx(stakingRouter, "initialize", [stakingRouterAdmin, lidoAddress, withdrawalCredentials], {
    from: deployer,
  });

  //
  // Deploy or use predefined DepositSecurityModule
  //

  let depositSecurityModuleAddress = depositSecurityModuleParams.usePredefinedAddressInstead;
  if (depositSecurityModuleAddress === null) {
    depositSecurityModuleAddress = (
      await deployWithoutProxy(Sk.depositSecurityModule, "DepositSecurityModule", deployer, [
        lidoAddress,
        depositContract,
        stakingRouter.address,
        depositSecurityModuleParams.pauseIntentValidityPeriodBlocks,
        depositSecurityModuleParams.maxOperatorsPerUnvetting,
      ])
    ).address;
  } else {
    log(
      `NB: skipping deployment of DepositSecurityModule - using the predefined address ${depositSecurityModuleAddress} instead`,
    );
  }

  //
  // Deploy Accounting
  //

  const accounting = await deployBehindOssifiableProxy(Sk.accounting, "Accounting", proxyContractsOwner, deployer, [
    locator.address,
    lidoAddress,
  ]);

  //
  // Deploy AccountingOracle and its HashConsensus
  //

  const accountingOracleParams = state[Sk.accountingOracle].deployParameters;

  const accountingOracle = await deployBehindOssifiableProxy(
    Sk.accountingOracle,
    "AccountingOracle",
    proxyContractsOwner,
    deployer,
    [locator.address, Number(chainSpec.secondsPerSlot), Number(chainSpec.genesisTime)],
  );

  const hashConsensusForAO = await deployWithoutProxy(Sk.hashConsensusForAccountingOracle, "HashConsensus", deployer, [
    chainSpec.slotsPerEpoch,
    chainSpec.secondsPerSlot,
    chainSpec.genesisTime,
    hashConsensusForAccountingParams.epochsPerFrame,
    hashConsensusForAccountingParams.fastLaneLengthSlots,
    admin, // admin
    accountingOracle.address, // reportProcessor
  ]);

  await makeTx(
    await loadContract("AccountingOracle", accountingOracle.address),
    "initialize",
    [admin, hashConsensusForAO.address, accountingOracleParams.consensusVersion, ZERO_LAST_PROCESSING_REF_SLOT],
    { from: deployer },
  );

  //
  // Deploy ValidatorsExitBusOracle and its HashConsensus
  //

  const validatorsExitBusOracleParams = state[Sk.validatorsExitBusOracle].deployParameters;
  const validatorsExitBusOracle = await deployBehindOssifiableProxy(
    Sk.validatorsExitBusOracle,
    "ValidatorsExitBusOracle",
    proxyContractsOwner,
    deployer,
    [chainSpec.secondsPerSlot, chainSpec.genesisTime, locator.address],
  );

  const hashConsensusForVebo = await deployWithoutProxy(
    Sk.hashConsensusForValidatorsExitBusOracle,
    "HashConsensus",
    deployer,
    [
      chainSpec.slotsPerEpoch,
      chainSpec.secondsPerSlot,
      chainSpec.genesisTime,
      hashConsensusForExitBusParams.epochsPerFrame,
      hashConsensusForExitBusParams.fastLaneLengthSlots,
      admin, // admin
      validatorsExitBusOracle.address, // reportProcessor
    ],
  );

  await makeTx(
    await loadContract("ValidatorsExitBusOracle", validatorsExitBusOracle.address),
    "initialize",
    [
      admin,
      hashConsensusForVebo.address,
      validatorsExitBusOracleParams.consensusVersion,
      ZERO_LAST_PROCESSING_REF_SLOT,
      validatorsExitBusOracleParams.maxValidatorsPerRequest,
      validatorsExitBusOracleParams.maxExitRequestsLimit,
      validatorsExitBusOracleParams.exitsPerFrame,
      validatorsExitBusOracleParams.frameDurationInSec,
    ],
    { from: deployer },
  );

  //
  // Deploy Triggerable Withdrawals Gateway
  //

  const triggerableWithdrawalsGateway_ = await deployWithoutProxy(
    Sk.triggerableWithdrawalsGateway,
    "TriggerableWithdrawalsGateway",
    deployer,
    [
      admin,
      locator.address,
      validatorsExitBusOracleParams.maxExitRequestsLimit,
      validatorsExitBusOracleParams.exitsPerFrame,
      validatorsExitBusOracleParams.frameDurationInSec,
    ],
  );
  await makeTx(
    stakingRouter,
    "grantRole",
    [await stakingRouter.REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE(), triggerableWithdrawalsGateway_.address],
    { from: deployer },
  );
  const triggerableWithdrawalsGateway = await loadContract<TriggerableWithdrawalsGateway>(
    "TriggerableWithdrawalsGateway",
    triggerableWithdrawalsGateway_.address,
  );
  await makeTx(
    triggerableWithdrawalsGateway,
    "grantRole",
    [await triggerableWithdrawalsGateway.ADD_FULL_WITHDRAWAL_REQUEST_ROLE(), validatorsExitBusOracle.address],
    { from: deployer },
  );

  //
  // Deploy ValidatorExitDelayVerifier
  //

  const validatorExitDelayVerifierCtorArgs = [
    locator.address,
    {
      gIFirstValidatorPrev: validatorExitDelayVerifierParams.gIFirstValidatorPrev,
      gIFirstValidatorCurr: validatorExitDelayVerifierParams.gIFirstValidatorCurr,
      gIFirstHistoricalSummaryPrev: validatorExitDelayVerifierParams.gIFirstHistoricalSummaryPrev,
      gIFirstHistoricalSummaryCurr: validatorExitDelayVerifierParams.gIFirstHistoricalSummaryCurr,
      gIFirstBlockRootInSummaryPrev: validatorExitDelayVerifierParams.gIFirstBlockRootInSummaryPrev,
      gIFirstBlockRootInSummaryCurr: validatorExitDelayVerifierParams.gIFirstBlockRootInSummaryCurr,
    },
    validatorExitDelayVerifierParams.firstSupportedSlot,
    validatorExitDelayVerifierParams.pivotSlot,
    validatorExitDelayVerifierParams.capellaSlot,
    validatorExitDelayVerifierParams.slotsPerHistoricalRoot,
    chainSpec.slotsPerEpoch,
    chainSpec.secondsPerSlot,
    chainSpec.genesisTime,
    validatorExitDelayVerifierParams.shardCommitteePeriodInSeconds,
  ];
  await deployWithoutProxy(
    Sk.validatorExitDelayVerifier,
    "ValidatorExitDelayVerifier",
    deployer,
    validatorExitDelayVerifierCtorArgs,
  );

  //
  // Deploy WithdrawalVault
  //

  const withdrawalVaultImpl = await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, [
    lidoAddress,
    treasuryAddress,
    triggerableWithdrawalsGateway.address,
  ]);

  await makeTx(withdrawalsManagerProxy, "proxy_upgradeTo", [withdrawalVaultImpl.address, "0x"], { from: deployer });

  //
  // Deploy Burner
  //

  const burner_ = await deployBehindOssifiableProxy(Sk.burner, "Burner", proxyContractsOwner, deployer, [
    locator.address,
    lidoAddress,
  ]);
  const isMigrationAllowed = false;
  const burner = await loadContract("Burner", burner_.address);
  await makeTx(burner, "initialize", [deployer, isMigrationAllowed], { from: deployer });

  //
  // Deploy OracleReportSanityChecker
  //

  const sanityCheckerParams = state["oracleReportSanityChecker"].deployParameters;
  const oracleReportSanityCheckerArgs = [
    locator.address,
    accountingOracle.address,
    accounting.address,
    admin,
    [
      sanityCheckerParams.exitedValidatorsPerDayLimit,
      sanityCheckerParams.appearedValidatorsPerDayLimit,
      sanityCheckerParams.annualBalanceIncreaseBPLimit,
      sanityCheckerParams.simulatedShareRateDeviationBPLimit,
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

  await deployWithoutProxy(
    Sk.oracleReportSanityChecker,
    "OracleReportSanityChecker",
    deployer,
    oracleReportSanityCheckerArgs,
  );
}
