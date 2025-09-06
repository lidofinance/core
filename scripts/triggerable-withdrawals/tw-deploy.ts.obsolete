import * as dotenv from "dotenv";
import { ethers } from "hardhat";
import { join } from "path";

import { LidoLocator } from "typechain-types";

import {
  cy,
  deployImplementation,
  DeploymentState,
  findEvents,
  loadContract,
  log,
  makeTx,
  persistNetworkState,
  readNetworkState,
  Sk,
  updateObjectInState,
} from "lib";

dotenv.config({ path: join(__dirname, "../../.env") });

//--------------------------------------------------------------------------
// Helpers
//--------------------------------------------------------------------------

function requireEnv(variable: string): string {
  const value = process.env[variable];
  if (!value) throw new Error(`Environment variable ${variable} is not set`);
  log(`Using env variable ${variable}=${value}`);
  return value;
}

async function deployGateSeal(
  state: DeploymentState,
  deployer: string,
  sealableContracts: string[],
  sealDuration: number,
  expiryTimestamp: number,
  kind: Sk.gateSeal | Sk.gateSealTW,
): Promise<void> {
  const gateSealFactory = await loadContract("IGateSealFactory", state[Sk.gateSeal].factoryAddress);

  const receipt = await makeTx(
    gateSealFactory,
    "create_gate_seal",
    [state[Sk.gateSeal].sealingCommittee, sealDuration, sealableContracts, expiryTimestamp],
    { from: deployer },
  );

  // Extract and log the new GateSeal address
  const gateSealAddress = await findEvents(receipt, "GateSealCreated")[0].args.gate_seal;
  log(`GateSeal created: ${cy(gateSealAddress)}`);
  log.emptyLine();

  // Update the state with the new GateSeal address
  updateObjectInState(kind, {
    factoryAddress: state[Sk.gateSeal].factoryAddress,
    sealDuration,
    expiryTimestamp,
    sealingCommittee: state[Sk.gateSeal].sealingCommittee,
    address: gateSealAddress,
  });

  return gateSealAddress;
}

//--------------------------------------------------------------------------
// Main
//--------------------------------------------------------------------------

async function main(): Promise<void> {
  // -----------------------------------------------------------------------
  // Environment & chain context
  // -----------------------------------------------------------------------
  const deployer = ethers.getAddress(requireEnv("DEPLOYER"));

  const { chainId } = await ethers.provider.getNetwork();
  const currentBlock = await ethers.provider.getBlock("latest");
  if (!currentBlock) throw new Error("Failed to fetch the latest block");

  log(cy(`Deploying contracts on chain ${chainId}`));

  // -----------------------------------------------------------------------
  // State & configuration
  // -----------------------------------------------------------------------
  const state = readNetworkState();
  persistNetworkState(state);

  const chainSpec = state[Sk.chainSpec] as {
    slotsPerEpoch: number;
    secondsPerSlot: number;
    genesisTime: number;
    depositContractAddress: string; // legacy support
    depositContract?: string;
  };

  log(`Chain spec: ${JSON.stringify(chainSpec, null, 2)}`);

  // Consensus‑spec constants
  const SECONDS_PER_SLOT = chainSpec.secondsPerSlot;
  const SLOTS_PER_EPOCH = chainSpec.slotsPerEpoch;
  const GENESIS_TIME = chainSpec.genesisTime;
  const DEPOSIT_CONTRACT_ADDRESS = chainSpec.depositContractAddress ?? chainSpec.depositContract;
  const SHARD_COMMITTEE_PERIOD_SLOTS = 2 ** 8 * SLOTS_PER_EPOCH; // 8192

  // G‑indices (phase0 spec)
  const VALIDATOR_PREV_GINDEX = "0x0000000000000000000000000000000000000000000000000096000000000028";
  const VALIDATOR_CURR_GINDEX = VALIDATOR_PREV_GINDEX;
  const FIRST_HISTORICAL_SUMMARY_PREV_GINDEX = "0x000000000000000000000000000000000000000000000000000000b600000018";
  const FIRST_HISTORICAL_SUMMARY_CURR_GINDEX = FIRST_HISTORICAL_SUMMARY_PREV_GINDEX;
  const BLOCK_ROOT_IN_SUMMARY_PREV_GINDEX = "0x000000000000000000000000000000000000000000000000000000000040000d";
  const BLOCK_ROOT_IN_SUMMARY_CURR_GINDEX = BLOCK_ROOT_IN_SUMMARY_PREV_GINDEX;

  const FIRST_SUPPORTED_SLOT = 364032 * SLOTS_PER_EPOCH; // https://github.com/ethereum/EIPs/blob/master/EIPS/eip-7600.md#activation
  const PIVOT_SLOT = FIRST_SUPPORTED_SLOT;
  const CAPELLA_SLOT = 194048 * 32; // capellaSlot @see https://github.com/ethereum/consensus-specs/blob/365320e778965631cbef11fd93328e82a746b1f6/specs/capella/fork.md?plain=1#L22
  const SLOTS_PER_HISTORICAL_ROOT = 8192;

  // TriggerableWithdrawalsGateway params
  const TRIGGERABLE_WITHDRAWALS_MAX_LIMIT = 11_200;
  const TRIGGERABLE_WITHDRAWALS_LIMIT_PER_FRAME = 1;
  const TRIGGERABLE_WITHDRAWALS_FRAME_DURATION = 48;

  // GateSeal params
  const GATE_SEAL_EXPIRY_TIMESTAMP = currentBlock.timestamp + 365 * 24 * 60 * 60; // 1 year
  const GATE_SEAL_DURATION_SECONDS = 14 * 24 * 60 * 60; // 14 days

  const agent = state["app:aragon-agent"].proxy.address;
  log(`Using agent: ${agent}`);

  const locator = await loadContract<LidoLocator>("LidoLocator", state[Sk.lidoLocator].proxy.address);

  // -----------------------------------------------------------------------
  // Deployments
  // -----------------------------------------------------------------------

  // 1. ValidatorsExitBusOracle
  const validatorsExitBusOracle = await deployImplementation(
    Sk.validatorsExitBusOracle,
    "ValidatorsExitBusOracle",
    deployer,
    [SECONDS_PER_SLOT, GENESIS_TIME, locator.address],
  );
  log.success(`ValidatorsExitBusOracle: ${validatorsExitBusOracle.address}`);

  // 2. TriggerableWithdrawalsGateway
  const triggerableWithdrawalsGateway = await deployImplementation(
    Sk.triggerableWithdrawalsGateway,
    "TriggerableWithdrawalsGateway",
    deployer,
    [
      agent,
      locator.address,
      TRIGGERABLE_WITHDRAWALS_MAX_LIMIT,
      TRIGGERABLE_WITHDRAWALS_LIMIT_PER_FRAME,
      TRIGGERABLE_WITHDRAWALS_FRAME_DURATION,
    ],
  );
  log.success(`TriggerableWithdrawalsGateway: ${triggerableWithdrawalsGateway.address}`);

  // 3. WithdrawalVault
  const withdrawalVault = await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, [
    await locator.lido(),
    await locator.treasury(),
    triggerableWithdrawalsGateway.address,
  ]);
  log.success(`WithdrawalVault: ${withdrawalVault.address}`);

  // -----------------------------------------------------------------------
  // Shared libraries
  // -----------------------------------------------------------------------
  const minFirstAllocationStrategyAddress = state[Sk.minFirstAllocationStrategy].address;
  const libraries = {
    MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
  } as const;

  // 4. StakingRouter
  const stakingRouter = await deployImplementation(
    Sk.stakingRouter,
    "StakingRouter",
    deployer,
    [DEPOSIT_CONTRACT_ADDRESS],
    { libraries },
  );
  log.success(`StakingRouter: ${stakingRouter.address}`);

  // 5. NodeOperatorsRegistry
  const nor = await deployImplementation(Sk.appNodeOperatorsRegistry, "NodeOperatorsRegistry", deployer, [], {
    libraries,
  });
  log.success(`NodeOperatorsRegistry: ${nor.address}`);

  // 6. ValidatorExitDelayVerifier
  const gIndexes = {
    gIFirstValidatorPrev: VALIDATOR_PREV_GINDEX,
    gIFirstValidatorCurr: VALIDATOR_CURR_GINDEX,
    gIFirstHistoricalSummaryPrev: FIRST_HISTORICAL_SUMMARY_PREV_GINDEX,
    gIFirstHistoricalSummaryCurr: FIRST_HISTORICAL_SUMMARY_CURR_GINDEX,
    gIFirstBlockRootInSummaryPrev: BLOCK_ROOT_IN_SUMMARY_PREV_GINDEX,
    gIFirstBlockRootInSummaryCurr: BLOCK_ROOT_IN_SUMMARY_CURR_GINDEX,
  };

  const validatorExitDelayVerifier = await deployImplementation(
    Sk.validatorExitDelayVerifier,
    "ValidatorExitDelayVerifier",
    deployer,
    [
      locator.address,
      gIndexes,
      FIRST_SUPPORTED_SLOT,
      PIVOT_SLOT,
      CAPELLA_SLOT,
      SLOTS_PER_HISTORICAL_ROOT, // slotsPerHistoricalRoot
      SLOTS_PER_EPOCH,
      SECONDS_PER_SLOT,
      GENESIS_TIME,
      SHARD_COMMITTEE_PERIOD_SLOTS * SECONDS_PER_SLOT, // shardCommitteePeriodInSeconds
    ],
  );
  log.success(`ValidatorExitDelayVerifier: ${validatorExitDelayVerifier.address}`);

  // 7. AccountingOracle
  const accountingOracle = await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, [
    locator.address,
    await locator.lido(),
    await locator.legacyOracle(),
    SECONDS_PER_SLOT,
    GENESIS_TIME,
  ]);
  log.success(`AccountingOracle: ${accountingOracle.address}`);

  // -----------------------------------------------------------------------
  // New LidoLocator (all addresses consolidated)
  // -----------------------------------------------------------------------
  const locatorConfig = [
    await locator.accountingOracle(),
    await locator.depositSecurityModule(),
    await locator.elRewardsVault(),
    await locator.legacyOracle(),
    await locator.lido(),
    await locator.oracleReportSanityChecker(),
    await locator.postTokenRebaseReceiver(),
    await locator.burner(),
    await locator.stakingRouter(),
    await locator.treasury(),
    await locator.validatorsExitBusOracle(),
    await locator.withdrawalQueue(),
    await locator.withdrawalVault(),
    await locator.oracleDaemonConfig(),
    validatorExitDelayVerifier.address,
    triggerableWithdrawalsGateway.address,
  ];

  // 8. Deploy new LidoLocator
  const newLocator = await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [locatorConfig]);
  log.success(`LidoLocator: ${newLocator.address}`);

  const updatedState = readNetworkState();
  persistNetworkState(updatedState);

  // 9. GateSeal for withdrawalQueueERC721
  const WQ_GATE_SEAL = await deployGateSeal(
    updatedState,
    deployer,
    [updatedState[Sk.withdrawalQueueERC721].proxy.address],
    GATE_SEAL_DURATION_SECONDS,
    GATE_SEAL_EXPIRY_TIMESTAMP,
    Sk.gateSeal,
  );

  // 10. GateSeal for Triggerable Withdrawals
  const TW_GATE_SEAL = await deployGateSeal(
    updatedState,
    deployer,
    [updatedState[Sk.triggerableWithdrawalsGateway].implementation.address, await locator.validatorsExitBusOracle()],
    GATE_SEAL_DURATION_SECONDS,
    GATE_SEAL_EXPIRY_TIMESTAMP,
    Sk.gateSealTW,
  );

  // -----------------------------------------------------------------------
  // Governance summary
  // -----------------------------------------------------------------------
  log.emptyLine();
  log(`Configuration for governance script:`);
  log.emptyLine();
  log(`LIDO_LOCATOR_IMPL = "${newLocator.address}"`);
  log(`ACCOUNTING_ORACLE_IMPL = "${accountingOracle.address}"`);
  log(`VALIDATORS_EXIT_BUS_ORACLE_IMPL = "${validatorsExitBusOracle.address}"`);
  log(`WITHDRAWAL_VAULT_IMPL = "${withdrawalVault.address}"`);
  log(`STAKING_ROUTER_IMPL = "${stakingRouter.address}"`);
  log(`NODE_OPERATORS_REGISTRY_IMPL = "${nor.address}"`);
  log(`VALIDATOR_EXIT_DELAY_VERIFIER_IMPL = "${validatorExitDelayVerifier.address}"`);
  log(`TRIGGERABLE_WITHDRAWALS_GATEWAY_IMPL = "${triggerableWithdrawalsGateway.address}"\n`);
  log.emptyLine();
  log(`WQ_GATE_SEAL = "${WQ_GATE_SEAL}"`);
  log(`TW_GATE_SEAL = "${TW_GATE_SEAL}"`);
  log.emptyLine();
}

main().catch((error) => {
  log.error(error);
  process.exitCode = 1;
});
