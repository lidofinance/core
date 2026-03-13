import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { IOracleReportSanityChecker_preV3, LidoLocator } from "typechain-types";

import { loadContract } from "lib/contract";
import { deployImplementation, deployWithoutProxy } from "lib/deploy";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });
  const parameters = readUpgradeParameters();

  const agentAddress = getAddress(Sk.appAgent, state);
  const treasuryAddress = agentAddress;
  const lidoAddress = getAddress(Sk.appLido, state);
  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const stakingRouterAddress = getAddress(Sk.stakingRouter, state);
  const accountingAddress = getAddress(Sk.accounting, state);
  const accountingOracleAddress = getAddress(Sk.accountingOracle, state);
  const withdrawalVaultAddress = getAddress(Sk.withdrawalVault, state);
  const triggerableWithdrawalsGatewayAddress = getAddress(Sk.triggerableWithdrawalsGateway, state);
  const topUpGatewayAddress = getAddress(Sk.topUpGateway, state);
  const validatorExitDelayVerifierAddress = getAddress(Sk.validatorExitDelayVerifier, state);
  const wstETHAddress = getAddress(Sk.wstETH, state);

  const chainSpec = state[Sk.chainSpec];
  const depositContractAddress = chainSpec.depositContract ?? chainSpec.depositContractAddress;
  if (!depositContractAddress) {
    throw new Error("Deposit contract address is missing in the state file");
  }

  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

  await deployImplementation(Sk.appLido, "Lido", deployer);
  await deployImplementation(Sk.accounting, "Accounting", deployer, [locatorAddress, lidoAddress]);
  await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, [
    locatorAddress,
    Number(chainSpec.secondsPerSlot),
    Number(chainSpec.genesisTime),
  ]);

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

  await deployImplementation(Sk.topUpGateway, "TopUpGateway", deployer, [
    locatorAddress,
    parameters.topUpGateway.gIFirstValidatorPrev,
    parameters.topUpGateway.gIFirstValidatorCurr,
    parameters.topUpGateway.pivotSlot,
    chainSpec.slotsPerEpoch,
  ]);

  const oldSanityChecker = await loadContract<IOracleReportSanityChecker_preV3>(
    "IOracleReportSanityChecker_preV3",
    await locator.oracleReportSanityChecker(),
  );
  const oldCheckerLimits = await oldSanityChecker.getOracleReportLimits();
  const newSanityChecker = await deployWithoutProxy(
    Sk.oracleReportSanityChecker,
    "OracleReportSanityChecker",
    deployer,
    [
      locatorAddress,
      accountingOracleAddress,
      accountingAddress,
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
    ],
  );

  const consolidationGateway = await deployWithoutProxy(Sk.consolidationGateway, "ConsolidationGateway", deployer, [
    agentAddress,
    locatorAddress,
    parameters.consolidationGateway.maxConsolidationRequestsLimit,
    parameters.consolidationGateway.consolidationsPerFrame,
    parameters.consolidationGateway.frameDurationInSec,
  ]);

  const consolidationBus = await deployWithoutProxy(Sk.consolidationBus, "ConsolidationBus", deployer, [
    agentAddress,
    consolidationGateway.address,
    parameters.consolidationBus.batchSize,
  ]);

  await deployWithoutProxy(Sk.consolidationMigrator, "ConsolidationMigrator", deployer, [
    agentAddress,
    stakingRouterAddress,
    consolidationBus.address,
    parameters.consolidationMigrator.sourceModuleId,
    parameters.consolidationMigrator.targetModuleId,
  ]);

  await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, [
    lidoAddress,
    treasuryAddress,
    triggerableWithdrawalsGatewayAddress,
    consolidationGateway.address,
  ]);

  const locatorConfig: LidoLocator.ConfigStruct = {
    accountingOracle: await locator.accountingOracle(),
    depositSecurityModule: await locator.depositSecurityModule(),
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
    topUpGateway: topUpGatewayAddress,
  };

  await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [locatorConfig]);
}
