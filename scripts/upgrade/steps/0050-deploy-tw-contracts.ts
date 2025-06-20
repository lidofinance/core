import * as dotenv from "dotenv";
import { ethers } from "hardhat";
import { join } from "path";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { LidoLocator, TriggerableWithdrawalsGateway } from "typechain-types";

import {
  cy,
  deployImplementation,
  deployWithoutProxy,
  loadContract,
  log,
  makeTx,
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

  await deployWithoutProxy(Sk.validatorExitDelayVerifier, "ValidatorExitDelayVerifier", deployer, [
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
  ]);

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
  await makeTx(triggerableWithdrawalsGateway, "grantRole", [DEFAULT_ADMIN_ROLE, agent], { from: deployer });
  await makeTx(triggerableWithdrawalsGateway, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });

  //
  // Withdrawal Vault
  //

  const withdrawalVaultArgs = [LIDO_PROXY, TREASURY_PROXY, triggerableWithdrawalsGateway_.address];
  const withdrawalVault = await deployImplementation(
    Sk.withdrawalVault,
    "WithdrawalVault",
    deployer,
    withdrawalVaultArgs,
  );
  log.success(`WithdrawalVault address implementation: ${withdrawalVault.address}`);
}
