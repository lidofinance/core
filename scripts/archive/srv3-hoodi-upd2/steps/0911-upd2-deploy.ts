import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import {
  DepositSecurityModule,
  DepositSecurityModule__factory,
  LidoLocator,
  LidoLocator__factory,
  OracleReportSanityChecker,
  OracleReportSanityChecker__factory,
} from "typechain-types";

import {
  ConstructorArgs,
  deployImplementation,
  deployWithoutProxy,
  getAddress,
  loadContract,
  logArgs,
  logConfirmReview as logConfirmReview,
  logScriptHeader,
  logStartReview as logStartReview,
  makeTx,
  readNetworkState,
  Sk,
} from "lib";
import { OracleReportSanityCheckerSchema } from "lib/config-schemas";

export async function main() {
  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  const deployer = (await ethers.provider.getSigner()).address;

  await logScriptHeader("SRv3/CMv2 — Deploy & setup Base Contracts (Update 1)", deployer);

  //
  //  Collect all param values
  //
  const chainSpec = state[Sk.chainSpec];
  const depositContractAddress = chainSpec.depositContract ?? chainSpec.depositContractAddress;
  if (!depositContractAddress) {
    throw new Error("Deposit contract address is missing in the state file");
  }

  const agentAddress = getAddress(Sk.appAgent, state);
  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

  const stakingRouterAddress = await locator.stakingRouter();
  const accountingAddress = await locator.accounting();

  const oldDepositSecurityModule = await loadContract<DepositSecurityModule>(
    "DepositSecurityModule",
    await locator.depositSecurityModule(),
  );
  const oldSanityChecker = await loadContract<OracleReportSanityChecker>(
    "OracleReportSanityChecker",
    await locator.oracleReportSanityChecker(),
  );

  const oldCheckerLimits = await oldSanityChecker.getOracleReportLimits();
  // const sanityCheckerLimits = OracleReportSanityCheckerSchema.parse({
  //   ...(await oldSanityChecker.getOracleReportLimits()), // get some values from current SanityCheckerLimits
  //   ...parameters.oracleReportSanityChecker, // apply new items
  // });
  const sanityCheckerLimits = OracleReportSanityCheckerSchema.parse({
    annualBalanceIncreaseBPLimit: Number(oldCheckerLimits.annualBalanceIncreaseBPLimit),
    simulatedShareRateDeviationBPLimit: Number(oldCheckerLimits.simulatedShareRateDeviationBPLimit),
    maxItemsPerExtraDataTransaction: Number(oldCheckerLimits.maxItemsPerExtraDataTransaction),
    maxNodeOperatorsPerExtraDataItem: Number(oldCheckerLimits.maxNodeOperatorsPerExtraDataItem),
    requestTimestampMargin: Number(oldCheckerLimits.requestTimestampMargin),
    maxPositiveTokenRebase: Number(oldCheckerLimits.maxPositiveTokenRebase),
    clBalanceOraclesErrorUpperBPLimit: Number(oldCheckerLimits.clBalanceOraclesErrorUpperBPLimit),
    ...parameters.oracleReportSanityChecker,
  });

  // DepositSecurityModule
  // setup: migrate guardians
  // vote: swap role in SR
  const dsmConstructorArgs: ConstructorArgs<DepositSecurityModule__factory> = [
    depositContractAddress,
    stakingRouterAddress,
    parameters.depositSecurityModule.pauseIntentValidityPeriodBlocks,
    parameters.depositSecurityModule.maxOperatorsPerUnvetting,
  ];
  logStartReview();
  await logArgs("DepositSecurityModule", dsmConstructorArgs);
  await logConfirmReview();
  const depositSecurityModule = await deployWithoutProxy(
    Sk.depositSecurityModule,
    "DepositSecurityModule",
    deployer,
    dsmConstructorArgs,
  );
  // migrate guardians
  const guardians = await oldDepositSecurityModule.getGuardians();
  const quorum = await oldDepositSecurityModule.getGuardianQuorum();
  await makeTx(depositSecurityModule, "addGuardians", [[...guardians], quorum], {
    from: deployer,
  });
  await makeTx(depositSecurityModule, "setOwner", [agentAddress], {
    from: deployer,
  });

  // OracleReportSanityChecker
  const oscConstructorArgs: ConstructorArgs<OracleReportSanityChecker__factory> = [
    locatorAddress,
    accountingAddress,
    agentAddress,
    sanityCheckerLimits,
  ];
  logStartReview();
  await logArgs("OracleReportSanityChecker", oscConstructorArgs);
  await logConfirmReview();
  const oracleReportSanityChecker = await deployWithoutProxy(
    Sk.oracleReportSanityChecker,
    "OracleReportSanityChecker",
    deployer,
    oscConstructorArgs,
  );
  // seed report data
  // await makeTx(oracleReportSanityChecker, "migrateBaselineSnapshot", [], {
  //   from: deployer,
  // });

  // LidoLocator
  // vote: upgrade locator
  const lidoLocatorConstructorArgs: ConstructorArgs<LidoLocator__factory> = [
    {
      accountingOracle: await locator.accountingOracle(),
      depositSecurityModule: depositSecurityModule.address,
      elRewardsVault: await locator.elRewardsVault(),
      lido: await locator.lido(),
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
      triggerableWithdrawalsGateway: await locator.triggerableWithdrawalsGateway(),
      consolidationGateway: await locator.consolidationGateway(),
      accounting: accountingAddress,
      predepositGuarantee: await locator.predepositGuarantee(),
      wstETH: await locator.wstETH(),
      vaultHub: await locator.vaultHub(),
      vaultFactory: await locator.vaultFactory(),
      lazyOracle: await locator.lazyOracle(),
      operatorGrid: await locator.operatorGrid(),
      topUpGateway: await locator.topUpGateway(),
    },
  ];

  logStartReview();
  await logArgs("LidoLocator", lidoLocatorConstructorArgs);
  await logConfirmReview();
  await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, lidoLocatorConstructorArgs);
}
