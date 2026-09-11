import { getResolvedDelegationContractAddress } from "scripts/utils/edf-upgrade";
import { readEDFUpgradeParameters } from "scripts/utils/upgrade";

import { DepositSecurityModule__factory, LidoLocator, LidoLocator__factory } from "typechain-types";

import {
  ConstructorArgs,
  deployImplementation,
  deployWithoutProxy,
  getAddress,
  getDeployerSigner,
  loadContract,
  logArgs,
  logConfirmReview,
  logScriptHeader,
  logStartReview,
  makeTx,
  readNetworkState,
  Sk,
} from "lib";

export async function main() {
  const state = readNetworkState();
  const parameters = readEDFUpgradeParameters();
  const deployer = (await getDeployerSigner()).address;

  await logScriptHeader("EDF/DSM v5 — Deploy & setup Base Contracts", deployer);

  const chainSpec = state[Sk.chainSpec];
  const depositContractAddress = chainSpec.depositContract ?? chainSpec.depositContractAddress;
  if (!depositContractAddress) {
    throw new Error("Deposit contract address is missing in the state file");
  }

  const agentAddress = getAddress(Sk.appAgent, state);
  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);
  const stakingRouterAddress = await locator.stakingRouter();

  const guardians = parameters.depositSecurityModule.guardianMappings.map(({ delegationContractId }) =>
    getResolvedDelegationContractAddress(state, delegationContractId),
  );
  const quorum = parameters.depositSecurityModule.quorum;

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
  await makeTx(depositSecurityModule, "addGuardians", [[...guardians], quorum], { from: deployer });
  await makeTx(depositSecurityModule, "setOwner", [agentAddress], { from: deployer });

  const locatorConfig: LidoLocator.ConfigStruct = {
    accountingOracle: await locator.accountingOracle(),
    depositSecurityModule: depositSecurityModule.address,
    elRewardsVault: await locator.elRewardsVault(),
    lido: await locator.lido(),
    oracleReportSanityChecker: await locator.oracleReportSanityChecker(),
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
    accounting: await locator.accounting(),
    predepositGuarantee: await locator.predepositGuarantee(),
    wstETH: await locator.wstETH(),
    vaultHub: await locator.vaultHub(),
    vaultFactory: await locator.vaultFactory(),
    lazyOracle: await locator.lazyOracle(),
    operatorGrid: await locator.operatorGrid(),
    topUpGateway: await locator.topUpGateway(),
  };
  const locatorConstructorArgs: ConstructorArgs<LidoLocator__factory> = [locatorConfig];
  logStartReview();
  await logArgs("LidoLocator", locatorConstructorArgs);
  await logConfirmReview();
  await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, locatorConstructorArgs);
}
