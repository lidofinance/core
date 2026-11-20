import { readUpgradeParameters } from "scripts/utils/upgrade";

import {
  DepositSecurityModule,
  DepositSecurityModule__factory,
  LidoLocator,
  LidoLocator__factory,
  StakingRouter__factory,
  TriggerableWithdrawalsBus,
  TriggerableWithdrawalsBus__factory,
  TriggerableWithdrawalsGateway__factory,
  WithdrawalsOracle,
  WithdrawalsOracle__factory,
  WithdrawalVault__factory,
} from "typechain-types";

import {
  ConstructorArgs,
  deployBehindOssifiableProxy,
  deployImplementation,
  deployWithoutProxy,
  getAddress,
  getDeployerSigner,
  loadContract,
  log,
  logArgs,
  logConfirmReview,
  logScriptHeader,
  logStartReview,
  makeTx,
  readNetworkState,
  Sk,
} from "lib";
import { encodeFunctionCall, InitializeArgs } from "lib/contract";

/**
 * Deploys the SR phase 2 (LIP-38) contracts on top of the enacted Gloas upgrade.
 *
 * `TriggerableWithdrawalsGateway` is not upgradeable, so it gets a fresh address, and the new
 * `TriggerableWithdrawalsBus` is deployed behind a proxy. `WithdrawalVault` holds the gateway in an
 * immutable and `LidoLocator` lists it, so both get a new implementation; `StakingRouter` gets one
 * without the exit hooks, and `WithdrawalsOracle` one that publishes its reports to the bus.
 *
 * `DepositSecurityModule` is not upgradeable either: the new one adds optimistic top-ups. It copies the
 * guardians and the quorum of the live DSM, takes the top-up caller from the parameters, and is handed
 * to the Agent before the vote. On mainnet the operator sends these deployer transactions.
 *
 * @dev No `skip()`: the state entries touched here are already filled by earlier releases. The outgoing
 *      addresses are read from the live locator rather than from the state file, which this step overwrites.
 */
export async function main() {
  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  const deployer = (await getDeployerSigner()).address;

  await logScriptHeader("SR phase 2 (LIP-38) — Deploy contracts", deployer);

  const chainSpec = state[Sk.chainSpec];
  const depositContractAddress = chainSpec.depositContract ?? chainSpec.depositContractAddress;
  if (!depositContractAddress) throw new Error("Deposit contract address is missing in the state file");

  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const agentAddress = getAddress(Sk.appAgent, state);

  // Only the members both the live and the new locator share are read through this type
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);
  const lidoAddress = await locator.lido();
  const treasuryAddress = await locator.treasury();
  const consolidationGatewayAddress = await locator.consolidationGateway();

  //
  // DepositSecurityModule with optimistic top-ups: a copy of the live DSM, owned by the Agent
  //
  const liveDsm = await loadContract<DepositSecurityModule>(
    "DepositSecurityModule",
    await locator.depositSecurityModule(),
  );
  // A plain copy: ethers rejects its read-only `Result` as a call argument
  const guardians = [...(await liveDsm.getGuardians())];
  const quorum = await liveDsm.getGuardianQuorum();
  const { topUpDepositor } = parameters.depositSecurityModule;

  const dsmConstructorArgs: ConstructorArgs<DepositSecurityModule__factory> = [
    await liveDsm.DEPOSIT_CONTRACT(),
    await locator.stakingRouter(),
    parameters.depositSecurityModule.pauseIntentValidityPeriodBlocks,
    parameters.depositSecurityModule.maxOperatorsPerUnvetting,
    topUpDepositor,
  ];

  logStartReview();
  await logArgs("DepositSecurityModule", dsmConstructorArgs);
  log("DepositSecurityModule guardians, copied from the live DSM:", guardians.join(", "));
  log("DepositSecurityModule quorum, copied from the live DSM:", quorum.toString());
  log("DepositSecurityModule owner after the setup:", agentAddress);
  await logConfirmReview();

  const dsmDeployment = await deployWithoutProxy(
    Sk.depositSecurityModule,
    "DepositSecurityModule",
    deployer,
    dsmConstructorArgs,
  );
  const dsm = await loadContract<DepositSecurityModule>("DepositSecurityModule", dsmDeployment.address);
  await makeTx(dsm, "addGuardians", [guardians, quorum], { from: deployer });
  await makeTx(dsm, "setOwner", [agentAddress], { from: deployer });

  //
  // TriggerableWithdrawalsGateway and TriggerableWithdrawalsBus
  //

  // The Agent is the admin from birth: the vote itself executes as the Agent, grants the remaining roles
  // and sets the consumer limits.
  const gatewayConstructorArgs: ConstructorArgs<TriggerableWithdrawalsGateway__factory> = [
    agentAddress,
    locatorAddress,
  ];
  const busConstructorArgs: ConstructorArgs<TriggerableWithdrawalsBus__factory> = [locatorAddress];

  logStartReview();
  await logArgs("TriggerableWithdrawalsGateway", gatewayConstructorArgs);
  await logArgs("TriggerableWithdrawalsBus", busConstructorArgs);
  log("TriggerableWithdrawalsBus proxy admin and DEFAULT_ADMIN_ROLE holder:", agentAddress);
  await logConfirmReview();

  const gateway = await deployWithoutProxy(
    Sk.triggerableWithdrawalsGateway,
    "TriggerableWithdrawalsGateway",
    deployer,
    gatewayConstructorArgs,
  );

  const bus = await deployBehindOssifiableProxy(
    Sk.triggerableWithdrawalsBus,
    "TriggerableWithdrawalsBus",
    agentAddress,
    deployer,
    busConstructorArgs,
    null,
    true,
    undefined,
    await encodeFunctionCall<InitializeArgs<TriggerableWithdrawalsBus>>("TriggerableWithdrawalsBus", "initialize", [
      agentAddress,
    ]),
  );

  //
  // WithdrawalVault: only the TRIGGERABLE_WITHDRAWALS_GATEWAY immutable changes
  //
  const withdrawalVaultConstructorArgs: ConstructorArgs<WithdrawalVault__factory> = [
    lidoAddress,
    treasuryAddress,
    gateway.address,
    consolidationGatewayAddress,
    parameters.withdrawalVault.withdrawalRequestContract,
    parameters.withdrawalVault.consolidationRequestContract,
  ];

  //
  // StakingRouter without the exit hooks, linked to a fresh SRLib
  //
  const stakingRouterConstructorArgs: ConstructorArgs<StakingRouter__factory> = [
    depositContractAddress,
    lidoAddress,
    locatorAddress,
    parameters.stakingRouter.maxEBType1,
    parameters.stakingRouter.maxEBType2,
  ];
  const minFirstAllocationStrategyAddress = getAddress(Sk.minFirstAllocationStrategy, state);
  const beaconChainDepositorAddress = getAddress(Sk.beaconChainDepositor, state);

  logStartReview();
  await logArgs("WithdrawalVault", withdrawalVaultConstructorArgs);
  log.info("SRLib linked libraries", { MinFirstAllocationStrategy: minFirstAllocationStrategyAddress });
  log.info("StakingRouter linked libraries", { BeaconChainDepositor: beaconChainDepositorAddress });
  await logArgs("SRLib", []);
  await logArgs("StakingRouter", stakingRouterConstructorArgs);
  await logConfirmReview();

  await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, withdrawalVaultConstructorArgs);

  const srLib = await deployWithoutProxy(Sk.srLib, "SRLib", deployer, [], "address", true, {
    libraries: { MinFirstAllocationStrategy: minFirstAllocationStrategyAddress },
  });

  await deployImplementation(Sk.stakingRouter, "StakingRouter", deployer, stakingRouterConstructorArgs, {
    libraries: { BeaconChainDepositor: beaconChainDepositorAddress, SRLib: srLib.address },
  });

  //
  // WithdrawalsOracle: the chain spec of the live oracle, the record cap in an immutable
  //
  const liveWithdrawalsOracle = await loadContract<WithdrawalsOracle>(
    "WithdrawalsOracle",
    await locator.validatorsExitBusOracle(),
  );
  const withdrawalsOracleConstructorArgs: ConstructorArgs<WithdrawalsOracle__factory> = [
    await liveWithdrawalsOracle.SECONDS_PER_SLOT(),
    await liveWithdrawalsOracle.GENESIS_TIME(),
    locatorAddress,
    parameters.withdrawalsOracle.maxRequestsPerReport,
  ];

  logStartReview();
  await logArgs("WithdrawalsOracle", withdrawalsOracleConstructorArgs);
  await logConfirmReview();

  await deployImplementation(Sk.withdrawalsOracle, "WithdrawalsOracle", deployer, withdrawalsOracleConstructorArgs);

  //
  // LidoLocator: the new DSM, gateway and bus, no ValidatorExitDelayVerifier, no TopUpGateway
  //
  const locatorConfig: LidoLocator.ConfigStruct = {
    accountingOracle: await locator.accountingOracle(),
    depositSecurityModule: dsm.address,
    elRewardsVault: await locator.elRewardsVault(),
    lido: lidoAddress,
    oracleReportSanityChecker: await locator.oracleReportSanityChecker(),
    postTokenRebaseReceiver: await locator.postTokenRebaseReceiver(),
    burner: await locator.burner(),
    stakingRouter: await locator.stakingRouter(),
    treasury: treasuryAddress,
    withdrawalsOracle: await locator.validatorsExitBusOracle(),
    withdrawalQueue: await locator.withdrawalQueue(),
    withdrawalVault: await locator.withdrawalVault(),
    oracleDaemonConfig: await locator.oracleDaemonConfig(),
    triggerableWithdrawalsGateway: gateway.address,
    triggerableWithdrawalsBus: bus.address,
    consolidationGateway: consolidationGatewayAddress,
    accounting: await locator.accounting(),
    predepositGuarantee: await locator.predepositGuarantee(),
    wstETH: await locator.wstETH(),
    vaultHub: await locator.vaultHub(),
    vaultFactory: await locator.vaultFactory(),
    lazyOracle: await locator.lazyOracle(),
    operatorGrid: await locator.operatorGrid(),
  };

  const lidoLocatorConstructorArgs: ConstructorArgs<LidoLocator__factory> = [locatorConfig];

  logStartReview();
  await logArgs("LidoLocator", lidoLocatorConstructorArgs);
  await logConfirmReview();

  await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, lidoLocatorConstructorArgs);
}
