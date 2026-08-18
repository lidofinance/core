import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { AccountingOracle, LidoLocator, LidoLocator__factory } from "typechain-types";

import {
  ConstructorArgs,
  deployImplementation,
  deployWithoutProxy,
  getAddress,
  getDeployerSigner,
  loadContract,
  makeTx,
  readNetworkState,
  Sk,
} from "lib";
import { impersonate } from "lib/account";
import { OracleReportSanityCheckerSchema } from "lib/config-schemas";

// The checker currently deployed on the integration-test forks predates LIP-39.
// Keep this ABI local to the test-only upgrade step: the production upgrade scripts
// deliberately use the ABI matching the contract version they upgrade from.
const PRE_LEAN_REBASE_CHECKER_ABI = [
  "function getOracleReportLimits() external view returns ((uint256 exitedEthAmountPerDayLimit, uint256 appearedEthAmountPerDayLimit, uint256 annualBalanceIncreaseBPLimit, uint256 simulatedShareRateDeviationBPLimit, uint256 maxBalanceExitRequestedPerReportInEth, uint256 maxEffectiveBalanceWeightWCType01, uint256 maxEffectiveBalanceWeightWCType02, uint256 maxItemsPerExtraDataTransaction, uint256 maxNodeOperatorsPerExtraDataItem, uint256 requestTimestampMargin, uint256 maxPositiveTokenRebase, uint256 maxCLBalanceDecreaseBP, uint256 clBalanceOraclesErrorUpperBPLimit, uint256 consolidationEthAmountPerDayLimit, uint256 exitedValidatorEthAmountLimit, uint256 externalPendingBalanceCapEth))",
] as const;

/**
 * Test-only upgrade for forks where the SRv3/CMv2 upgrade is already live.
 *
 * The regular SRv3 deployment and enactment steps intentionally skip in that case.
 * This step installs the contracts changed by the lean-rebase draft without changing
 * the production rollout scripts or replaying the already-executed SRv3 upgrade.
 */
export async function main(): Promise<void> {
  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  const deployer = await getDeployerSigner();

  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);
  const agentAddress = getAddress(Sk.appAgent, state);
  const agent = await impersonate(agentAddress, ethers.parseEther("1"));

  // Read every address from the live locator. In particular, this preserves the
  // TokenRateNotifier installed by the preceding NEST mock-upgrade step.
  const liveLocatorConfig = {
    accountingOracle: await locator.accountingOracle(),
    depositSecurityModule: await locator.depositSecurityModule(),
    elRewardsVault: await locator.elRewardsVault(),
    lido: await locator.lido(),
    oracleReportSanityChecker: await locator.oracleReportSanityChecker(),
    postTokenRebaseReceiver: await locator.postTokenRebaseReceiver(),
    burner: await locator.burner(),
    stakingRouter: await locator.stakingRouter(),
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

  const previousChecker = new ethers.Contract(
    liveLocatorConfig.oracleReportSanityChecker,
    PRE_LEAN_REBASE_CHECKER_ABI,
    ethers.provider,
  );
  const previousLimits = await previousChecker.getOracleReportLimits();

  // Preserve unrelated live operational limits while taking all LIP-39 limits from
  // the checked-in upgrade parameters used by the corresponding network.
  const limits = OracleReportSanityCheckerSchema.parse({
    ...parameters.oracleReportSanityChecker,
    simulatedShareRateDeviationBPLimit: Number(previousLimits.simulatedShareRateDeviationBPLimit),
    maxItemsPerExtraDataTransaction: Number(previousLimits.maxItemsPerExtraDataTransaction),
    maxNodeOperatorsPerExtraDataItem: Number(previousLimits.maxNodeOperatorsPerExtraDataItem),
    requestTimestampMargin: Number(previousLimits.requestTimestampMargin),
  });

  // The Agent acts as both admin and committee only on the ephemeral test fork.
  const secondOpinionOracle = await deployWithoutProxy(
    Sk.secondOpinionOracle,
    "SecondOpinionOracle",
    deployer.address,
    [agentAddress, agentAddress],
  );

  const checker = await deployWithoutProxy(
    Sk.oracleReportSanityChecker,
    "OracleReportSanityChecker",
    deployer.address,
    [locatorAddress, liveLocatorConfig.accounting, agentAddress, limits, secondOpinionOracle.address],
  );

  const accountingImplementation = await deployImplementation(Sk.accounting, "Accounting", deployer.address, [
    locatorAddress,
    liveLocatorConfig.lido,
  ]);

  const locatorConstructorArgs: ConstructorArgs<LidoLocator__factory> = [
    {
      ...liveLocatorConfig,
      oracleReportSanityChecker: checker.address,
    },
  ];
  const locatorImplementation = await deployImplementation(
    Sk.lidoLocator,
    "LidoLocator",
    deployer.address,
    locatorConstructorArgs,
  );

  const accountingProxy = await loadContract("OssifiableProxy", liveLocatorConfig.accounting, agent);
  await makeTx(accountingProxy, "proxy__upgradeTo", [accountingImplementation.address], { from: agentAddress });

  const locatorProxy = await loadContract("OssifiableProxy", locatorAddress, agent);
  await makeTx(locatorProxy, "proxy__upgradeTo", [locatorImplementation.address], { from: agentAddress });

  // Direct settlement changes report construction while keeping the ReportData ABI.
  // Bump the consensus version so fork tests build reports with the new rules.
  const accountingOracle = await loadContract<AccountingOracle>(
    "AccountingOracle",
    liveLocatorConfig.accountingOracle,
    agent,
  );
  const consensusVersion = await accountingOracle.getConsensusVersion();
  const targetConsensusVersion = BigInt(parameters.accountingOracle.consensusVersion);
  if (consensusVersion === targetConsensusVersion) return;

  const manageConsensusVersionRole = await accountingOracle.MANAGE_CONSENSUS_VERSION_ROLE();
  const agentAlreadyManagesConsensusVersion = await accountingOracle.hasRole(manageConsensusVersionRole, agentAddress);
  if (!agentAlreadyManagesConsensusVersion) {
    await makeTx(accountingOracle, "grantRole", [manageConsensusVersionRole, agentAddress], { from: agentAddress });
  }
  await makeTx(accountingOracle, "setConsensusVersion", [targetConsensusVersion], { from: agentAddress });
  if (!agentAlreadyManagesConsensusVersion) {
    await makeTx(accountingOracle, "revokeRole", [manageConsensusVersionRole, agentAddress], { from: agentAddress });
  }
}
