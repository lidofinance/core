import * as dotenv from "dotenv";
import { ethers } from "hardhat";
import { join } from "path";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { ConsolidationGateway, LidoLocator, TriggerableWithdrawalsGateway } from "typechain-types";

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
import {
  CAPELLA_SLOT,
  FIRST_SUPPORTED_SLOT,
  PIVOT_SLOT,
  SLOTS_PER_HISTORICAL_ROOT,
} from "scripts/scratch/steps/0083-deploy-core";

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
  const validatorExitDelayVerifierParams = parameters.validatorExitDelayVerifier;
  const triggerableWithdrawalsGatewayParams = parameters.triggerableWithdrawalsGateway;
  const consolidationGatewayParams = parameters.consolidationGateway;
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

  //
  // Staking Router
  //

  // deploy beacon chain depositor
  const beaconChainDepositor = await deployWithoutProxy(Sk.beaconChainDepositor, "BeaconChainDepositor", deployer);

  // deploy SRLib
  const srLib = await deployWithoutProxy(Sk.srLib, "SRLib", deployer);

  const depositContract = parameters.chainSpec.depositContract;
  log(`Deposit contract address: ${depositContract}`);
  const stakingRouterAddress = await deployImplementation(
    Sk.stakingRouter,
    "StakingRouter",
    deployer,
    [depositContract, chainSpec.secondsPerSlot, chainSpec.genesisTime],
    {
      libraries: {
        // DepositsTracker: depositsTracker.address,
        BeaconChainDepositor: beaconChainDepositor.address,
        SRLib: srLib.address,
      },
    },
  );

  log(`BeaconChainDepositor library address: ${beaconChainDepositor.address}`);
  log(`SRLib library address: ${srLib.address}`);
  log(`StakingRouter implementation address: ${stakingRouterAddress.address}`);

  //
  // Node Operators Registry
  //

  const minFirstAllocationStrategyAddress = getAddress(Sk.minFirstAllocationStrategy, state);
  const NOR = await deployImplementation(Sk.appNodeOperatorsRegistry, "NodeOperatorsRegistry", deployer, [], {
    libraries: {
      MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
    },
  });

  log.success(`NOR implementation address: ${NOR.address}`);
  log.emptyLine();

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
    FIRST_SUPPORTED_SLOT, // uint64 firstSupportedSlot,
    PIVOT_SLOT, // uint64 pivotSlot,
    // TODO: update this to the actual Capella slot for e2e testing in mainnet-fork
    CAPELLA_SLOT, // uint64 capellaSlot,
    SLOTS_PER_HISTORICAL_ROOT, // uint64 slotsPerHistoricalRoot,
    chainSpec.slotsPerEpoch, // uint32 slotsPerEpoch,
    chainSpec.secondsPerSlot, // uint32 secondsPerSlot,
    // parseInt(getEnvVariable("GENESIS_TIME")), // uint64 genesisTime,
    chainSpec.genesisTime,
    // https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#time-parameters-1
    2 ** 8 * 32 * 12, // uint32 shardCommitteePeriodInSeconds
  ];
  await deployWithoutProxy(
    Sk.validatorExitDelayVerifier,
    "ValidatorExitDelayVerifier",
    deployer,
    validatorExitDelayVerifierCtorArgs,
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
  // Deploy Consolidation Gateway
  //

  const consolidationGateway_ = await deployWithoutProxy(Sk.consolidationGateway, "ConsolidationGateway", deployer, [
    deployer,
    locator.address,
    consolidationGatewayParams.maxConsolidationRequestsLimit,
    consolidationGatewayParams.consolidationsPerFrame,
    consolidationGatewayParams.frameDurationInSec,
  ]);

  const consolidationGateway = await loadContract<ConsolidationGateway>(
    "ConsolidationGateway",
    consolidationGateway_.address,
  );

  // ToDo: Grant ADD_CONSOLIDATION_REQUEST_ROLE to MessageBus address instead of deployer
  // ADD_CONSOLIDATION_REQUEST_ROLE granted to deployer for testing convenience
  await makeTx(
    consolidationGateway,
    "grantRole",
    [await consolidationGateway.ADD_CONSOLIDATION_REQUEST_ROLE(), deployer],
    { from: deployer },
  );
  await makeTx(consolidationGateway, "grantRole", [DEFAULT_ADMIN_ROLE, agent], { from: deployer });
  await makeTx(consolidationGateway, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });

  //
  // Withdrawal Vault
  //

  const withdrawalVaultArgs = [
    LIDO_PROXY,
    TREASURY_PROXY,
    triggerableWithdrawalsGateway.address,
    consolidationGateway.address,
  ];

  const withdrawalVault = await deployImplementation(
    Sk.withdrawalVault,
    "WithdrawalVault",
    deployer,
    withdrawalVaultArgs,
  );
  log.success(`WithdrawalVault address implementation: ${withdrawalVault.address}`);
}
