import { ethers } from "hardhat";

import { Burner, StakingRouter, TriggerableWithdrawalsGateway } from "typechain-types";

import { ether, HASH_CONSENSUS_FAR_FUTURE_EPOCH, impersonate, WithdrawalCredentialsType } from "lib";
import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { streccak } from "lib/keccak";
import { readNetworkState, Sk } from "lib/state-file";

const STAKING_MODULE_MANAGE_ROLE = streccak("STAKING_MODULE_MANAGE_ROLE");
const ZERO_ADDRESS = ethers.ZeroAddress;

const EXTERNAL_ACCESS_CONTROL_ABI = [
  "function RESUME_ROLE() view returns (bytes32)",
  "function PAUSE_ROLE() view returns (bytes32)",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function resume()",
];

const EXTERNAL_HASH_CONSENSUS_ABI = [
  "function getChainConfig() view returns (uint256 slotsPerEpoch, uint256 secondsPerSlot, uint256 genesisTime)",
  "function getFrameConfig() view returns (uint256 initialEpoch, uint256 epochsPerFrame, uint256 fastLaneLengthSlots)",
  "function updateInitialEpoch(uint256 initialEpoch)",
];

const NOR_STAKING_MODULE_STAKE_SHARE_LIMIT_BP = 10000; // 100%
const NOR_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP = 10000; // 100%
const NOR_STAKING_MODULE_MODULE_FEE_BP = 500; // 5%
const NOR_STAKING_MODULE_TREASURY_FEE_BP = 500; // 5%
const NOR_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK = 150;
const NOR_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE = 25;
const NOR_WITHDRAWAL_TYPE = WithdrawalCredentialsType.WC0x01;

const SDVT_STAKING_MODULE_TARGET_SHARE_BP = 400; // 4%
const SDVT_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP = 10000; // 100%
const SDVT_STAKING_MODULE_MODULE_FEE_BP = 800; // 8%
const SDVT_STAKING_MODULE_TREASURY_FEE_BP = 200; // 2%
const SDVT_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK = 150;
const SDVT_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE = 25;
const SDVT_WITHDRAWAL_TYPE = WithdrawalCredentialsType.WC0x01;

const CSM_STAKING_MODULE_NAME = "Community Staking";
const CSM_STAKING_MODULE_TARGET_SHARE_BP = 2000; // 20%
const CSM_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP = 2500; // 25%
const CSM_STAKING_MODULE_MODULE_FEE_BP = 800; // 8%
const CSM_STAKING_MODULE_TREASURY_FEE_BP = 200; // 2%
const CSM_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK = 30;
const CSM_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE = 25;
const CSM_WITHDRAWAL_TYPE = WithdrawalCredentialsType.WC0x01;

const CMV2_STAKING_MODULE_NAME = "curated-onchain-v2";
const CMV2_STAKING_MODULE_TARGET_SHARE_BP = 10000; // 100%
const CMV2_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP = 10000; // 100%
const CMV2_STAKING_MODULE_MODULE_FEE_BP = 400; // 4%
const CMV2_STAKING_MODULE_TREASURY_FEE_BP = 600; // 6%
const CMV2_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK = 150;
const CMV2_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE = 25;
const CMV2_WITHDRAWAL_TYPE = WithdrawalCredentialsType.WC0x02;

type ExternalDeployArtifact = {
  Accounting?: string;
  CSModule?: string;
  CuratedModule?: string;
  Ejector?: string;
  FeeOracle?: string;
  HashConsensus?: string;
  IdentifiedDVTClusterGate?: string;
  Verifier?: string;
  VettedGate?: string;
};

type ExternalModuleSetup = {
  accounting: string;
  ejector: string;
  hashConsensus: string;
  module: string;
  moduleLabel: string;
  pausableContracts: { address: string; label: string }[];
};

function getExternalArtifact(state: ReturnType<typeof readNetworkState>, stateKey: Sk, moduleLabel: string) {
  const artifact = state[stateKey]?.deployArtifact as ExternalDeployArtifact | undefined;
  if (!artifact) {
    throw new Error(`${moduleLabel} deploy artifact is missing in state`);
  }
  return artifact;
}

function requireArtifactAddress(
  artifact: ExternalDeployArtifact,
  field: keyof ExternalDeployArtifact,
  moduleLabel: string,
) {
  const value = artifact[field];
  if (!value || value === ZERO_ADDRESS) {
    throw new Error(`${moduleLabel} deploy artifact does not contain ${field} address`);
  }
  return value;
}

function optionalArtifactAddress(artifact: ExternalDeployArtifact, field: keyof ExternalDeployArtifact) {
  const value = artifact[field];
  return value && value !== ZERO_ADDRESS ? value : null;
}

function getExternalModuleSetup(
  state: ReturnType<typeof readNetworkState>,
  stateKey: Sk,
  moduleLabel: string,
  moduleField: "CSModule" | "CuratedModule",
  extraPausableFields: { field: keyof ExternalDeployArtifact; label: string }[] = [],
): ExternalModuleSetup {
  const artifact = getExternalArtifact(state, stateKey, moduleLabel);
  const module = requireArtifactAddress(artifact, moduleField, moduleLabel);
  const pausableContracts = [
    { address: module, label: moduleLabel },
    { address: requireArtifactAddress(artifact, "Accounting", moduleLabel), label: `${moduleLabel} Accounting` },
    { address: requireArtifactAddress(artifact, "FeeOracle", moduleLabel), label: `${moduleLabel} FeeOracle` },
    { address: requireArtifactAddress(artifact, "Verifier", moduleLabel), label: `${moduleLabel} Verifier` },
    { address: requireArtifactAddress(artifact, "Ejector", moduleLabel), label: `${moduleLabel} Ejector` },
  ];

  for (const { field, label } of extraPausableFields) {
    const address = optionalArtifactAddress(artifact, field);
    if (address) pausableContracts.push({ address, label });
  }

  return {
    accounting: requireArtifactAddress(artifact, "Accounting", moduleLabel),
    ejector: requireArtifactAddress(artifact, "Ejector", moduleLabel),
    hashConsensus: requireArtifactAddress(artifact, "HashConsensus", moduleLabel),
    module,
    moduleLabel,
    pausableContracts,
  };
}

function externalContract(
  name: string,
  address: string,
  abi: string[],
  signer: Awaited<ReturnType<typeof impersonate>>,
) {
  const contract = new ethers.Contract(address, abi, signer);
  return Object.assign(contract, {
    name,
    address,
    contractPath: `external:staking-modules:${name}`,
  });
}

async function getCurrentEpoch(hashConsensus: ReturnType<typeof externalContract>) {
  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Failed to read latest block");

  const [slotsPerEpoch, secondsPerSlot, genesisTime] = await hashConsensus.getChainConfig();
  return (BigInt(latestBlock.timestamp) - BigInt(genesisTime)) / (BigInt(slotsPerEpoch) * BigInt(secondsPerSlot));
}

async function enableExternalModule(
  setup: ExternalModuleSetup,
  state: ReturnType<typeof readNetworkState>,
  deployer: string,
) {
  const agent = state[Sk.appAgent].proxy.address;
  const agentSigner = await impersonate(agent, ether("1"));

  const burner = await loadContract<Burner>("Burner", state[Sk.burner].proxy.address);
  const triggerableWithdrawalsGateway = await loadContract<TriggerableWithdrawalsGateway>(
    "TriggerableWithdrawalsGateway",
    state[Sk.triggerableWithdrawalsGateway].address,
  );

  await makeTx(burner, "grantRole", [await burner.REQUEST_BURN_MY_STETH_ROLE(), setup.accounting], { from: deployer });
  await makeTx(
    triggerableWithdrawalsGateway,
    "grantRole",
    [await triggerableWithdrawalsGateway.ADD_FULL_WITHDRAWAL_REQUEST_ROLE(), setup.ejector],
    { from: deployer },
  );

  const module = externalContract(setup.moduleLabel, setup.module, EXTERNAL_ACCESS_CONTROL_ABI, agentSigner);
  const resumeRole = await module.RESUME_ROLE();
  await makeTx(module, "grantRole", [resumeRole, agent], { from: agent });
  await makeTx(module, "resume", [], { from: agent });
  await makeTx(module, "revokeRole", [resumeRole, agent], { from: agent });

  const hashConsensus = externalContract(
    `${setup.moduleLabel} HashConsensus`,
    setup.hashConsensus,
    EXTERNAL_HASH_CONSENSUS_ABI,
    agentSigner,
  );
  const [initialEpoch] = await hashConsensus.getFrameConfig();
  if (BigInt(initialEpoch) === HASH_CONSENSUS_FAR_FUTURE_EPOCH) {
    await makeTx(hashConsensus, "updateInitialEpoch", [await getCurrentEpoch(hashConsensus)], { from: agent });
  }

  const circuitBreakerAddress = state[Sk.circuitBreaker]?.address;
  if (circuitBreakerAddress) {
    for (const pausable of setup.pausableContracts) {
      const contract = externalContract(pausable.label, pausable.address, EXTERNAL_ACCESS_CONTROL_ABI, agentSigner);
      await makeTx(contract, "grantRole", [await contract.PAUSE_ROLE(), circuitBreakerAddress], { from: agent });
    }
  }
}

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  // Get contract instances
  const stakingRouter = await loadContract<StakingRouter>("StakingRouter", state.stakingRouter.proxy.address);

  // Grant STAKING_MODULE_MANAGE_ROLE to deployer
  await makeTx(stakingRouter, "grantRole", [STAKING_MODULE_MANAGE_ROLE, deployer], { from: deployer });

  // Add staking module to StakingRouter
  await makeTx(
    stakingRouter,
    "addStakingModule",
    [
      state.nodeOperatorsRegistry.deployParameters.stakingModuleName,
      state[Sk.appNodeOperatorsRegistry].proxy.address,
      {
        stakeShareLimit: NOR_STAKING_MODULE_STAKE_SHARE_LIMIT_BP,
        priorityExitShareThreshold: NOR_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP,
        stakingModuleFee: NOR_STAKING_MODULE_MODULE_FEE_BP,
        treasuryFee: NOR_STAKING_MODULE_TREASURY_FEE_BP,
        maxDepositsPerBlock: NOR_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK,
        minDepositBlockDistance: NOR_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE,
        withdrawalCredentialsType: NOR_WITHDRAWAL_TYPE,
      },
    ],
    { from: deployer },
  );

  // Add simple DVT module to StakingRouter
  await makeTx(
    stakingRouter,
    "addStakingModule",
    [
      state.simpleDvt.deployParameters.stakingModuleName,
      state[Sk.appSimpleDvt].proxy.address,
      {
        stakeShareLimit: SDVT_STAKING_MODULE_TARGET_SHARE_BP,
        priorityExitShareThreshold: SDVT_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP,
        stakingModuleFee: SDVT_STAKING_MODULE_MODULE_FEE_BP,
        treasuryFee: SDVT_STAKING_MODULE_TREASURY_FEE_BP,
        maxDepositsPerBlock: SDVT_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK,
        minDepositBlockDistance: SDVT_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE,
        withdrawalCredentialsType: SDVT_WITHDRAWAL_TYPE,
      },
    ],
    { from: deployer },
  );

  if (state[Sk.sm_CSM]?.proxy?.address) {
    const setup = getExternalModuleSetup(state, Sk.sm_CSM, CSM_STAKING_MODULE_NAME, "CSModule", [
      { field: "VettedGate", label: `${CSM_STAKING_MODULE_NAME} VettedGate` },
      { field: "IdentifiedDVTClusterGate", label: `${CSM_STAKING_MODULE_NAME} IdentifiedDVTClusterGate` },
    ]);
    await makeTx(
      stakingRouter,
      "addStakingModule",
      [
        CSM_STAKING_MODULE_NAME,
        state[Sk.sm_CSM].proxy.address,
        {
          stakeShareLimit: CSM_STAKING_MODULE_TARGET_SHARE_BP,
          priorityExitShareThreshold: CSM_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP,
          stakingModuleFee: CSM_STAKING_MODULE_MODULE_FEE_BP,
          treasuryFee: CSM_STAKING_MODULE_TREASURY_FEE_BP,
          maxDepositsPerBlock: CSM_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK,
          minDepositBlockDistance: CSM_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE,
          withdrawalCredentialsType: CSM_WITHDRAWAL_TYPE,
        },
      ],
      { from: deployer },
    );
    await enableExternalModule(setup, state, deployer);
  }

  if (state[Sk.sm_CM]?.proxy?.address) {
    const setup = getExternalModuleSetup(state, Sk.sm_CM, CMV2_STAKING_MODULE_NAME, "CuratedModule");
    await makeTx(
      stakingRouter,
      "addStakingModule",
      [
        CMV2_STAKING_MODULE_NAME,
        state[Sk.sm_CM].proxy.address,
        {
          stakeShareLimit: CMV2_STAKING_MODULE_TARGET_SHARE_BP,
          priorityExitShareThreshold: CMV2_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP,
          stakingModuleFee: CMV2_STAKING_MODULE_MODULE_FEE_BP,
          treasuryFee: CMV2_STAKING_MODULE_TREASURY_FEE_BP,
          maxDepositsPerBlock: CMV2_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK,
          minDepositBlockDistance: CMV2_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE,
          withdrawalCredentialsType: CMV2_WITHDRAWAL_TYPE,
        },
      ],
      { from: deployer },
    );
    await enableExternalModule(setup, state, deployer);
  }

  // Set global per-block top-up ETH cap (LIP-35), required for TopUpGateway-driven top-ups.
  await makeTx(
    stakingRouter,
    "setMaxTopUpPerBlockGwei",
    [state[Sk.stakingRouter].deployParameters.maxTopUpPerBlockGwei],
    { from: deployer },
  );

  // Renounce STAKING_MODULE_MANAGE_ROLE from deployer
  await makeTx(stakingRouter, "renounceRole", [STAKING_MODULE_MANAGE_ROLE, deployer], { from: deployer });

  // assert
  if (await stakingRouter.hasRole(STAKING_MODULE_MANAGE_ROLE, deployer)) {
    throw new Error("Failed to renounce STAKING_MODULE_MANAGE_ROLE");
  }
}
