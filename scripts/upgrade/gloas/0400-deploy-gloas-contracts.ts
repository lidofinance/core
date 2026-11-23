import { readUpgradeParameters } from "scripts/utils/upgrade";

import {
  ConsolidationBus__factory,
  ConsolidationGateway,
  ConsolidationGateway__factory,
  LidoLocatorGloas,
  LidoLocatorGloas__factory,
  PredepositGuarantee__factory,
  TopUpGateway__factory,
  ValidatorExitDelayVerifier__factory,
  WithdrawalVault__factory,
} from "typechain-types";

import {
  ConstructorArgs,
  DEFAULT_ADMIN_ROLE,
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

/**
 * Deploys the Gloas-aware replacements on top of the enacted SRv3 and EDF releases.
 *
 * `ValidatorExitDelayVerifier` and `ConsolidationGateway` are not upgradeable, so both get a fresh
 * address; the rest only need a new implementation behind their existing proxy. `ConsolidationBus`
 * and `WithdrawalVault` are here even though this release does not change their source: both hold
 * the consolidation gateway in an immutable, so replacing the gateway forces them along.
 *
 * @dev No `skip()` on purpose. It would key on state entries that SRv3 already filled, so
 *      `checkArtifactDeployedAndLog` would report the outgoing contracts as deployed and skip the
 *      whole step. The outgoing addresses are read from the live locator rather than from the
 *      state file, which the deployments below overwrite.
 */
export async function main() {
  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  const deployer = (await getDeployerSigner()).address;

  await logScriptHeader("Gloas — Deploy fork-aware verifiers", deployer);

  const chainSpec = state[Sk.chainSpec];
  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const agentAddress = getAddress(Sk.appAgent, state);
  const circuitBreakerAddress = getAddress(Sk.circuitBreaker, state);
  const resealManagerAddress = getAddress(Sk.resealManager, state);
  const consolidationBusAddress = getAddress(Sk.consolidationBus, state);
  const lidoAddress = getAddress(Sk.appLido, state);

  const locator = await loadContract<LidoLocatorGloas>("LidoLocatorGloas", locatorAddress);

  // Everything the new implementations inherit from the live address book.
  const treasuryAddress = await locator.treasury();
  const triggerableWithdrawalsGatewayAddress = await locator.triggerableWithdrawalsGateway();

  const validatorExitDelayVerifierConstructorArgs: ConstructorArgs<ValidatorExitDelayVerifier__factory> = [
    locatorAddress,
    parameters.validatorExitDelayVerifier.firstSupportedSlot,
    parameters.validatorExitDelayVerifier.gloasSlot,
    parameters.validatorExitDelayVerifier.capellaSlot,
    parameters.validatorExitDelayVerifier.slotsPerHistoricalRoot,
    chainSpec.slotsPerEpoch,
    chainSpec.secondsPerSlot,
    chainSpec.genesisTime,
    parameters.validatorExitDelayVerifier.shardCommitteePeriodInSeconds,
  ];

  // The deployer is the admin until the roles are granted below: unlike SRv3 there is no
  // UpgradeTemporaryAdmin, the deployer hands the admin role to the Agent itself.
  const consolidationGatewayConstructorArgs: ConstructorArgs<ConsolidationGateway__factory> = [
    deployer,
    locatorAddress,
    parameters.consolidationGateway.maxConsolidationRequestsLimit,
    parameters.consolidationGateway.consolidationsPerFrame,
    parameters.consolidationGateway.frameDurationInSec,
    parameters.consolidationGateway.gloasSlot,
  ];

  const predepositGuaranteeConstructorArgs: ConstructorArgs<PredepositGuarantee__factory> = [
    parameters.predepositGuarantee.genesisForkVersion,
    parameters.predepositGuarantee.gloasSlot,
  ];

  const topUpGatewayConstructorArgs: ConstructorArgs<TopUpGateway__factory> = [
    locatorAddress,
    parameters.topUpGateway.gloasSlot,
    chainSpec.slotsPerEpoch,
    chainSpec.secondsPerSlot,
    chainSpec.genesisTime,
  ];

  logStartReview();
  await logArgs("ValidatorExitDelayVerifier", validatorExitDelayVerifierConstructorArgs);
  await logArgs("ConsolidationGateway", consolidationGatewayConstructorArgs);
  await logArgs("PredepositGuarantee", predepositGuaranteeConstructorArgs);
  await logArgs("TopUpGateway", topUpGatewayConstructorArgs);
  await logConfirmReview();

  //
  // Deploy the non-upgradeable contracts
  //
  const validatorExitDelayVerifier = await deployWithoutProxy(
    Sk.validatorExitDelayVerifier,
    "ValidatorExitDelayVerifier",
    deployer,
    validatorExitDelayVerifierConstructorArgs,
  );

  const consolidationGateway = await deployWithoutProxy(
    Sk.consolidationGateway,
    "ConsolidationGateway",
    deployer,
    consolidationGatewayConstructorArgs,
  );

  const consolidationGatewayContract = await loadContract<ConsolidationGateway>(
    "ConsolidationGateway",
    consolidationGateway.address,
  );

  await makeTx(
    consolidationGatewayContract,
    "grantRole",
    [await consolidationGatewayContract.PAUSE_ROLE(), circuitBreakerAddress],
    { from: deployer },
  );
  await makeTx(
    consolidationGatewayContract,
    "grantRole",
    [await consolidationGatewayContract.PAUSE_ROLE(), resealManagerAddress],
    { from: deployer },
  );
  await makeTx(
    consolidationGatewayContract,
    "grantRole",
    [await consolidationGatewayContract.RESUME_ROLE(), resealManagerAddress],
    { from: deployer },
  );
  await makeTx(
    consolidationGatewayContract,
    "grantRole",
    [await consolidationGatewayContract.ADD_CONSOLIDATION_REQUEST_ROLE(), consolidationBusAddress],
    { from: deployer },
  );
  await makeTx(consolidationGatewayContract, "grantRole", [DEFAULT_ADMIN_ROLE, agentAddress], { from: deployer });
  await makeTx(consolidationGatewayContract, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });

  //
  // Deploy the Gloas-aware implementations
  //
  await deployImplementation(
    Sk.predepositGuarantee,
    "PredepositGuarantee",
    deployer,
    predepositGuaranteeConstructorArgs,
  );

  await deployImplementation(Sk.topUpGateway, "TopUpGateway", deployer, topUpGatewayConstructorArgs);

  //
  // Deploy the implementations dragged along by the new ConsolidationGateway address
  //
  const consolidationBusConstructorArgs: ConstructorArgs<ConsolidationBus__factory> = [consolidationGateway.address];

  const withdrawalVaultConstructorArgs: ConstructorArgs<WithdrawalVault__factory> = [
    lidoAddress,
    treasuryAddress,
    triggerableWithdrawalsGatewayAddress,
    consolidationGateway.address,
    parameters.withdrawalVault.withdrawalRequestContract,
    parameters.withdrawalVault.consolidationRequestContract,
  ];

  logStartReview();
  await logArgs("ConsolidationBus", consolidationBusConstructorArgs);
  await logArgs("WithdrawalVault", withdrawalVaultConstructorArgs);
  await logConfirmReview();

  await deployImplementation(Sk.consolidationBus, "ConsolidationBus", deployer, consolidationBusConstructorArgs);

  await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, withdrawalVaultConstructorArgs);

  //
  // Deploy the LidoLocator implementation carrying the two new addresses
  //
  const locatorConfig: LidoLocatorGloas.ConfigStruct = {
    accountingOracle: await locator.accountingOracle(),
    depositSecurityModule: await locator.depositSecurityModule(),
    elRewardsVault: await locator.elRewardsVault(),
    lido: await locator.lido(),
    oracleReportSanityChecker: await locator.oracleReportSanityChecker(),
    postTokenRebaseReceiver: await locator.postTokenRebaseReceiver(),
    burner: await locator.burner(),
    stakingRouter: await locator.stakingRouter(),
    treasury: treasuryAddress,
    validatorsExitBusOracle: await locator.validatorsExitBusOracle(),
    withdrawalQueue: await locator.withdrawalQueue(),
    withdrawalVault: await locator.withdrawalVault(),
    oracleDaemonConfig: await locator.oracleDaemonConfig(),
    validatorExitDelayVerifier: validatorExitDelayVerifier.address,
    triggerableWithdrawalsGateway: triggerableWithdrawalsGatewayAddress,
    consolidationGateway: consolidationGateway.address,
    accounting: await locator.accounting(),
    predepositGuarantee: await locator.predepositGuarantee(),
    wstETH: await locator.wstETH(),
    vaultHub: await locator.vaultHub(),
    vaultFactory: await locator.vaultFactory(),
    lazyOracle: await locator.lazyOracle(),
    operatorGrid: await locator.operatorGrid(),
    topUpGateway: await locator.topUpGateway(),
  };

  const lidoLocatorConstructorArgs: ConstructorArgs<LidoLocatorGloas__factory> = [locatorConfig];

  logStartReview();
  await logArgs("LidoLocatorGloas", lidoLocatorConstructorArgs);
  await logConfirmReview();

  await deployImplementation(Sk.lidoLocator, "LidoLocatorGloas", deployer, lidoLocatorConstructorArgs);
}
