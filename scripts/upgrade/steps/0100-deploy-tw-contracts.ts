import * as dotenv from "dotenv";
import { ethers } from "hardhat";
import { join } from "path";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { LidoLocator } from "typechain-types";

import {
  cy,
  deployImplementation,
  deployWithoutProxy,
  loadContract,
  log,
  persistNetworkState,
  readNetworkState,
  Sk,
} from "lib";
import { getAddress } from "lib/state-file";

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

dotenv.config({ path: join(__dirname, "../../.env") });

function getEnvVariable(name: string, defaultValue?: string) {
  const value = process.env[name];
  if (value === undefined) {
    if (defaultValue === undefined) {
      throw new Error(`Env variable ${name} must be set`);
    }
    return defaultValue;
  } else {
    log(`Using env variable ${name}=${value}`);
    return value;
  }
}

// Must comply with the specification
// https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#time-parameters-1
const SECONDS_PER_SLOT = 12;

// Must match the beacon chain genesis_time: https://beaconstate-mainnet.chainsafe.io/eth/v1/beacon/genesis
// and the current value: https://etherscan.io/address/0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb
const genesisTime = parseInt(getEnvVariable("GENESIS_TIME"));

export async function main() {
  const deployer = ethers.getAddress(getEnvVariable("DEPLOYER"));
  const chainId = (await ethers.provider.getNetwork()).chainId;

  log(cy(`Deploy of contracts on chain ${chainId}`));

  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  const validatorExitDelayVerifierParams = parameters[Sk.validatorExitDelayVerifier].deployParameters;
  const triggerableWithdrawalsGatewayParams = parameters[Sk.triggerableWithdrawalsGateway].deployParameters;
  persistNetworkState(state);

  const chainSpec = state[Sk.chainSpec];

  log(`Chain spec: ${JSON.stringify(chainSpec, null, 2)}`);

  const agent = getAddress(Sk.appAgent, state);
  log(`Using agent: ${agent}`);

  // Read contracts addresses from config
  const locator = await loadContract<LidoLocator>("LidoLocator", state[Sk.lidoLocator].proxy.address);

  const LIDO_PROXY = await locator.lido();
  const TREASURY_PROXY = await locator.treasury();

  // Deploy ValidatorExitBusOracle
  // uint256 secondsPerSlot, uint256 genesisTime, address lidoLocator
  const validatorsExitBusOracleArgs = [SECONDS_PER_SLOT, genesisTime, locator.address];

  const validatorsExitBusOracle = await deployImplementation(
    Sk.validatorsExitBusOracle,
    "ValidatorsExitBusOracle",
    deployer,
    validatorsExitBusOracleArgs,
  );
  log.success(`ValidatorsExitBusOracle address: ${validatorsExitBusOracle.address}`);
  log.emptyLine();

  const triggerableWithdrawalsGateway = await deployImplementation(
    Sk.triggerableWithdrawalsGateway,
    "TriggerableWithdrawalsGateway",
    deployer,
    [agent, locator.address, 13000, 1, 48],
  );
  log.success(`TriggerableWithdrawalsGateway implementation address: ${triggerableWithdrawalsGateway.address}`);
  log.emptyLine();

  //
  // Withdrawal Vault
  //

  const withdrawalVaultArgs = [LIDO_PROXY, TREASURY_PROXY, triggerableWithdrawalsGateway.address];
  const withdrawalVault = await deployImplementation(
    Sk.withdrawalVault,
    "WithdrawalVault",
    deployer,
    withdrawalVaultArgs,
  );
  log.success(`WithdrawalVault address implementation: ${withdrawalVault.address}`);

  const minFirstAllocationStrategyAddress = getAddress(Sk.minFirstAllocationStrategy, state);
  const libraries = {
    MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
  };

  //
  // Staking Router
  //

  const DEPOSIT_CONTRACT_ADDRESS = parameters[Sk.chainSpec].depositContract;
  log(`Deposit contract address: ${DEPOSIT_CONTRACT_ADDRESS}`);
  const stakingRouterAddress = await deployImplementation(
    Sk.stakingRouter,
    "StakingRouter",
    deployer,
    [DEPOSIT_CONTRACT_ADDRESS],
    { libraries },
  );

  log(`StakingRouter implementation address: ${stakingRouterAddress.address}`);

  //
  // Node Operators Registry
  //

  const NOR = await deployImplementation(Sk.appNodeOperatorsRegistry, "NodeOperatorsRegistry", deployer, [], {
    libraries,
  });

  log.success(`NOR implementation address: ${NOR.address}`);
  log.emptyLine();

  //
  // Deploy ValidatorExitDelayVerifier
  //

  const validatorExitDelayVerifier = await deployWithoutProxy(
    Sk.validatorExitDelayVerifier,
    "ValidatorExitDelayVerifier",
    deployer,
    [
      locator.address,
      validatorExitDelayVerifierParams.gIFirstValidatorPrev,
      validatorExitDelayVerifierParams.gIFirstValidatorCurr,
      validatorExitDelayVerifierParams.gIHistoricalSummariesPrev,
      validatorExitDelayVerifierParams.gIHistoricalSummariesCurr,
      validatorExitDelayVerifierParams.firstSupportedSlot,
      validatorExitDelayVerifierParams.pivotSlot,
      chainSpec.slotsPerEpoch,
      chainSpec.secondsPerSlot,
      genesisTime,
      // https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#time-parameters-1
      validatorExitDelayVerifierParams.shardCommitteePeriodInSeconds,
    ],
  );

  //
  // Deploy Triggerable Withdrawals Gateway
  //

  const triggerableWithdrawalsGateway_ = await deployWithoutProxy(
    Sk.triggerableWithdrawalsGateway,
    "TriggerableWithdrawalsGateway",
    deployer,
    [
      deployer,
      locator.address,
      triggerableWithdrawalsGatewayParams.maxExitRequestsLimit,
      triggerableWithdrawalsGatewayParams.exitsPerFrame,
      triggerableWithdrawalsGatewayParams.frameDurationInSec,
    ],
  );
  // TODO: move to voting script
  // await makeTx(
  //   stakingRouter,
  //   "grantRole",
  //   [await stakingRouter.REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE(), triggerableWithdrawalsGateway_.address],
  //   { from: deployer },
  // );
  const triggerableWithdrawalsGateway = await loadContract<TriggerableWithdrawalsGateway>(
    "TriggerableWithdrawalsGateway",
    triggerableWithdrawalsGateway_.address,
  );
  await makeTx(
    triggerableWithdrawalsGateway,
    "grantRole",
    [await triggerableWithdrawalsGateway.ADD_FULL_WITHDRAWAL_REQUEST_ROLE(), await locator.validatorsExitBusOracle()],
    { from: deployer },
  );
  await makeTx(triggerableWithdrawalsGateway, "grantRole", [DEFAULT_ADMIN_ROLE, agentAddress], { from: deployer });
  await makeTx(triggerableWithdrawalsGateway, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });

  // const validatorExitDelayVerifierArgs = [
  //   locator.address,
  //   "0x0000000000000000000000000000000000000000000000000096000000000028", // GIndex gIFirstValidatorPrev,
  //   "0x0000000000000000000000000000000000000000000000000096000000000028", // GIndex gIFirstValidatorCurr,
  //   "0x0000000000000000000000000000000000000000000000000000000000005b00", // GIndex gIHistoricalSummariesPrev,
  //   "0x0000000000000000000000000000000000000000000000000000000000005b00", // GIndex gIHistoricalSummariesCurr,
  //   1, // uint64 firstSupportedSlot,
  //   1, // uint64 pivotSlot,
  //   32, // uint32 slotsPerEpoch,
  //   12, // uint32 secondsPerSlot,
  //   genesisTime, // uint64 genesisTime,
  //   2 ** 8 * 32 * 12, // uint32 shardCommitteePeriodInSeconds
  // ];

  // const validatorExitDelayVerifier = await deployImplementation(
  //   Sk.validatorExitDelayVerifier,
  //   "ValidatorExitDelayVerifier",
  //   deployer,
  //   validatorExitDelayVerifierArgs,
  // );
  log.success(`ValidatorExitDelayVerifier implementation address: ${validatorExitDelayVerifier.address}`);
  log.emptyLine();

  // const accountingOracle = await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, [
  //   locator.address,
  //   await locator.lido(),
  //   await locator.legacyOracle(),
  //   Number(chainSpec.secondsPerSlot),
  //   Number(chainSpec.genesisTime),
  // ]);

  // // fetch contract addresses that will not changed
  // const locatorConfig = [
  //   await locator.accountingOracle(),
  //   await locator.depositSecurityModule(),
  //   await locator.elRewardsVault(),
  //   await locator.legacyOracle(),
  //   await locator.lido(),
  //   await locator.oracleReportSanityChecker(),
  //   await locator.postTokenRebaseReceiver(),
  //   await locator.burner(),
  //   await locator.stakingRouter(),
  //   await locator.treasury(),
  //   await locator.validatorsExitBusOracle(),
  //   await locator.withdrawalQueue(),
  //   await locator.withdrawalVault(),
  //   await locator.oracleDaemonConfig(),
  //   validatorExitDelayVerifier.address,
  //   triggerableWithdrawalsGateway.address,
  // ];

  // const lidoLocator = await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [locatorConfig]);

  //   log(`Configuration for voting script:`);
  //   log(`
  // LIDO_LOCATOR_IMPL = "${lidoLocator.address}"
  // ACCOUNTING_ORACLE = "${accountingOracle.address}"
  // VALIDATORS_EXIT_BUS_ORACLE_IMPL = "${validatorsExitBusOracle.address}"
  // WITHDRAWAL_VAULT_IMPL = "${withdrawalVault.address}"
  // STAKING_ROUTER_IMPL = "${stakingRouterAddress.address}"
  // NODE_OPERATORS_REGISTRY_IMPL = "${NOR.address}"
  // VALIDATOR_EXIT_VERIFIER = "${validatorExitDelayVerifier.address}"
  // TRIGGERABLE_WITHDRAWALS_GATEWAY = "${triggerableWithdrawalsGateway.address}"
  // `);
}
