import { Contract, Log, LogDescription } from "ethers";
import { ethers, network as hardhatNetwork } from "hardhat";
import {
  deployExecutionDelegationFramework,
  EDF_REPO,
  EDF_REPO_BRANCH,
} from "scripts/utils/execution-delegation-framework";

import { cy, getDeployerSigner, log } from "lib";
import { EDFDelegationContract, EDFUpgradeParameters } from "lib/config-schemas";
import { DELEGATION_CONTRACT_ABI, DELEGATION_FACTORY_ABI } from "lib/protocol/helpers/edf";
import { DeploymentState, getAddress, Sk, updateObjectInState } from "lib/state-file";

const ERC1271_INTERFACE_ID = "0x1626ba7e";
const LOCATOR_ABI = ["function depositSecurityModule() view returns (address)"];
const DSM_MEMBERSHIP_ABI = [
  "function getGuardians() view returns (address[])",
  "function getGuardianQuorum() view returns (uint256)",
];
const HASH_CONSENSUS_ABI = [
  "function getMembers() view returns (address[] members, uint256 lastProcessingRefSlot)",
  "function getQuorum() view returns (uint256)",
];

export type StoredDelegationContract = {
  address: string;
  owner: string;
  delegate: string;
  cooldown: number;
  factory?: string;
  deploymentTx?: string;
  runtimeCodeHash?: string;
};

export type DelegationDeploymentPlanItem = {
  id: string;
  action: "deploy" | "reuse";
  address?: string;
  owner?: string;
  delegate?: string;
  cooldown?: number;
};

function mergeConfiguredAddress(manifestAddress: string | undefined, stateAddress: string | undefined, label: string) {
  const manifest = manifestAddress ? ethers.getAddress(manifestAddress) : undefined;
  const state = stateAddress ? ethers.getAddress(stateAddress) : undefined;
  if (manifest && state && manifest !== state) {
    throw new Error(`${label} address mismatch: manifest ${manifest}, state ${state}`);
  }
  return manifest ?? state;
}

function mergeConfiguredValue<T>(
  manifestValue: T | undefined,
  stateValue: T | undefined,
  label: string,
): T | undefined {
  if (manifestValue !== undefined && stateValue !== undefined && manifestValue !== stateValue) {
    throw new Error(`${label} mismatch: manifest ${manifestValue}, state ${stateValue}`);
  }
  return manifestValue ?? stateValue;
}

export function buildDelegationDeploymentPlan(
  manifest: EDFDelegationContract[],
  stored: Record<string, StoredDelegationContract> = {},
): DelegationDeploymentPlanItem[] {
  return manifest.map((entry) => {
    const saved = stored[entry.id];
    const address = mergeConfiguredAddress(entry.address, saved?.address, `Delegation contract ${entry.id}`);
    const owner = mergeConfiguredAddress(entry.owner, saved?.owner, `Delegation contract ${entry.id} owner`);
    const delegate = mergeConfiguredAddress(
      entry.delegate,
      saved?.delegate,
      `Delegation contract ${entry.id} delegate`,
    );
    const cooldown = mergeConfiguredValue(entry.cooldown, saved?.cooldown, `Delegation contract ${entry.id} cooldown`);

    if (address && (!owner || !delegate || cooldown === undefined)) {
      throw new Error(`Delegation contract ${entry.id} has an address but no complete on-chain configuration`);
    }

    return {
      id: entry.id,
      action: address ? "reuse" : "deploy",
      address,
      owner,
      delegate,
      cooldown,
    };
  });
}

async function validateHoodiState(state: DeploymentState, expectedChainId: number) {
  const { chainId } = await ethers.provider.getNetwork();
  const stateChainId = state[Sk.chainId] ?? state[Sk.chainSpec]?.chainId;
  if (chainId !== BigInt(expectedChainId) || stateChainId === undefined || BigInt(stateChainId) !== chainId) {
    throw new Error(`EDF deploy is Hoodi-only: provider chain ID ${chainId}, state chain ID ${stateChainId}`);
  }
}

function addressSetsEqual(actual: string[], expected: string[]) {
  const actualSet = new Set(actual.map((address) => ethers.getAddress(address)));
  const expectedSet = new Set(expected.map((address) => ethers.getAddress(address)));
  return actualSet.size === expectedSet.size && [...actualSet].every((address) => expectedSet.has(address));
}

async function validateMembership(
  label: string,
  actualMembers: string[],
  actualQuorum: bigint,
  expectedMembers: string[],
  expectedQuorum: number,
) {
  if (actualQuorum !== BigInt(expectedQuorum)) {
    throw new Error(`${label} quorum mismatch: expected ${expectedQuorum}, got ${actualQuorum}`);
  }
  if (!addressSetsEqual(actualMembers, expectedMembers)) {
    throw new Error(`${label} members do not match the pre-EDF manifest`);
  }
}

async function validateSourceMembership(state: DeploymentState, parameters: EDFUpgradeParameters) {
  const locator = new ethers.Contract(getAddress(Sk.lidoLocator, state), LOCATOR_ABI, ethers.provider);
  const activeDSMAddress = await locator.depositSecurityModule();
  const dsm = new ethers.Contract(activeDSMAddress, DSM_MEMBERSHIP_ABI, ethers.provider);
  const guardianMappings = parameters.depositSecurityModule.guardianMappings;
  await validateMembership(
    "DepositSecurityModule",
    await dsm.getGuardians(),
    await dsm.getGuardianQuorum(),
    guardianMappings.map(({ oldMember }) => oldMember),
    parameters.depositSecurityModule.quorum,
  );

  for (const committee of parameters.oracleCommittees) {
    const code = await ethers.provider.getCode(committee.consensusContract);
    if (code === "0x") throw new Error(`${committee.id} consensus contract has no bytecode`);
    const consensus = new ethers.Contract(committee.consensusContract, HASH_CONSENSUS_ABI, ethers.provider);
    const [members] = await consensus.getMembers();
    await validateMembership(
      committee.id,
      members,
      await consensus.getQuorum(),
      committee.memberMappings.map(({ oldMember }) => oldMember),
      committee.quorum,
    );
  }
}

async function validateDelegationContract(
  id: string,
  address: string,
  expectedOwner: string,
  expectedDelegate: string,
  expectedCooldown: number,
): Promise<string> {
  const normalizedAddress = ethers.getAddress(address);
  const code = await ethers.provider.getCode(normalizedAddress);
  if (code === "0x") throw new Error(`Delegation contract ${id} at ${normalizedAddress} has no bytecode`);

  const contract = new ethers.Contract(normalizedAddress, DELEGATION_CONTRACT_ABI, ethers.provider);
  const owner = ethers.getAddress(await contract.owner());
  const delegate = ethers.getAddress(await contract.getDelegate());
  const cooldown = await contract.getCooldown();

  if (owner !== ethers.getAddress(expectedOwner)) {
    throw new Error(`Delegation contract ${id} owner mismatch: expected ${expectedOwner}, got ${owner}`);
  }
  if (delegate !== ethers.getAddress(expectedDelegate)) {
    throw new Error(`Delegation contract ${id} delegate mismatch: expected ${expectedDelegate}, got ${delegate}`);
  }
  if (cooldown !== BigInt(expectedCooldown)) {
    throw new Error(`Delegation contract ${id} cooldown mismatch: expected ${expectedCooldown}, got ${cooldown}`);
  }
  if (await contract.isTerminated()) throw new Error(`Delegation contract ${id} is terminated`);
  if (!(await contract.supportsInterface(ERC1271_INTERFACE_ID))) {
    throw new Error(`Delegation contract ${id} does not support ERC-1271`);
  }

  return ethers.keccak256(code);
}

async function deployDelegationContract(
  factory: Contract,
  id: string,
  owner: string,
  delegate: string,
  cooldown: number,
) {
  const tx = await factory.deploy(owner, delegate, cooldown);
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`Delegation contract ${id} deployment transaction has no receipt`);

  const event = receipt.logs
    .filter((entry: Log) => ethers.getAddress(entry.address) === ethers.getAddress(factory.target.toString()))
    .map((entry: Log) => {
      try {
        return factory.interface.parseLog(entry);
      } catch {
        return null;
      }
    })
    .find((entry: LogDescription | null) => entry?.name === "DelegationContractDeployed");
  if (!event) throw new Error(`Delegation contract ${id} deployment event was not emitted`);

  if (
    ethers.getAddress(event.args.owner) !== ethers.getAddress(owner) ||
    ethers.getAddress(event.args.delegate) !== ethers.getAddress(delegate) ||
    event.args.cooldown !== BigInt(cooldown)
  ) {
    throw new Error(`Delegation contract ${id} deployment event configuration mismatch`);
  }

  return {
    address: ethers.getAddress(event.args.instance),
    deploymentTx: receipt.hash,
  };
}

function persistDelegationContract(
  factoryAddress: string,
  contracts: Record<string, StoredDelegationContract>,
  id: string,
  contract: StoredDelegationContract,
) {
  contracts[id] = contract;
  updateObjectInState(Sk.delegationFactory, {
    address: factoryAddress,
    delegationContracts: contracts,
  });
}

export async function deployOrReuseEDFDelegationContracts(
  state: DeploymentState,
  parameters: EDFUpgradeParameters,
): Promise<Record<string, StoredDelegationContract>> {
  await validateHoodiState(state, parameters.chainId);
  const framework = parameters.executionDelegationFramework;
  if (framework.repository !== EDF_REPO || framework.ref !== EDF_REPO_BRANCH) {
    throw new Error(
      `Unsupported EDF source ${framework.repository}@${framework.ref}; expected ${EDF_REPO}@${EDF_REPO_BRANCH}`,
    );
  }

  if (hardhatNetwork.name !== "local") {
    if (!framework.factory.address || !framework.factory.runtimeCodeHash) {
      throw new Error("DelegationFactory address and runtime code hash are required outside the local Hoodi fork");
    }
    const incompleteContract = framework.delegationContracts.find(
      ({ address, owner, delegate, cooldown }) => !address || !owner || !delegate || cooldown === undefined,
    );
    if (incompleteContract) {
      throw new Error(
        `Delegation contract ${incompleteContract.id} requires address, owner, delegate and cooldown outside the local Hoodi fork`,
      );
    }
  }

  await validateSourceMembership(state, parameters);

  const factoryAddress = await deployExecutionDelegationFramework(state, {
    expectedAddress: framework.factory.address,
    expectedRuntimeCodeHash: framework.factory.runtimeCodeHash,
    allowDeploy: hardhatNetwork.name === "local",
  });
  const deployer = await getDeployerSigner();
  const factory = new ethers.Contract(factoryAddress, DELEGATION_FACTORY_ABI, deployer);
  const stored = {
    ...((state[Sk.delegationFactory]?.delegationContracts ?? {}) as Record<string, StoredDelegationContract>),
  };
  const plan = buildDelegationDeploymentPlan(framework.delegationContracts, stored);

  const needsTestConfiguration = plan.some((item) => item.action === "deploy" && (!item.owner || !item.delegate));
  const testSigners = needsTestConfiguration ? await ethers.getSigners() : [];
  if (needsTestConfiguration && hardhatNetwork.name !== "local") {
    throw new Error("Missing delegation contract owner/delegate configuration outside the local Hoodi fork");
  }
  if (needsTestConfiguration && testSigners.length < 2) {
    throw new Error("At least two local signers are required to deploy test delegation contracts");
  }

  for (const [index, item] of plan.entries()) {
    let owner = item.owner;
    let delegate = item.delegate;
    let cooldown = item.cooldown;
    let address = item.address;
    let deploymentTx = stored[item.id]?.deploymentTx;

    if (!owner || !delegate) {
      owner = await deployer.getAddress();
      delegate = await testSigners[(index % (testSigners.length - 1)) + 1].getAddress();
      if (ethers.getAddress(owner) === ethers.getAddress(delegate)) {
        throw new Error(`Generated owner and delegate are equal for ${item.id}`);
      }
      cooldown = 0;
    }
    if (cooldown === undefined) throw new Error(`Delegation contract ${item.id} cooldown is missing`);

    if (item.action === "deploy") {
      const deployed = await deployDelegationContract(factory, item.id, owner, delegate, cooldown);
      address = deployed.address;
      deploymentTx = deployed.deploymentTx;
      log(`Deployed ${item.id}: ${cy(address)}`);
    } else {
      log(`Using ${item.id}: ${cy(address!)}`);
    }

    const runtimeCodeHash = await validateDelegationContract(item.id, address!, owner, delegate, cooldown);
    persistDelegationContract(factoryAddress, stored, item.id, {
      address: address!,
      owner: ethers.getAddress(owner),
      delegate: ethers.getAddress(delegate),
      cooldown,
      factory: factoryAddress,
      deploymentTx,
      runtimeCodeHash,
    });
  }

  return stored;
}

export function getResolvedDelegationContractAddress(state: DeploymentState, id: string): string {
  const entry = state[Sk.delegationFactory]?.delegationContracts?.[id] as StoredDelegationContract | undefined;
  if (!entry?.address) throw new Error(`Delegation contract ${id} is missing in deployment state`);
  return ethers.getAddress(entry.address);
}
