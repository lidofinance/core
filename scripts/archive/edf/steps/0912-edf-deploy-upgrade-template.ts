import { ethers, network as hardhatNetwork } from "hardhat";
import { getResolvedDelegationContractAddress, StoredDelegationContract } from "scripts/utils/edf-upgrade";
import { readEDFUpgradeParameters } from "scripts/utils/upgrade";

import {
  DepositSecurityModule__factory,
  EDFUpgradeTemplate__factory,
  LidoLocator,
  OssifiableProxy__factory,
} from "typechain-types";
import { EDFUpgradeParametersStruct } from "typechain-types/contracts/upgrade/EDFUpgradeTemplate";

import {
  ConstructorArgs,
  deployWithoutProxy,
  getAddress,
  getContractPath,
  getDeployerSigner,
  loadContract,
  logArgs,
  logConfirmReview,
  logScriptHeader,
  logStartReview,
  readNetworkState,
  Sk,
  updateObjectInState,
} from "lib";

const LOCAL_TEST_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

type ResolvedStoredDelegationContract = StoredDelegationContract & {
  runtimeCodeHash: string;
};

async function resolveExpiryTimestamp(configuredExpiry: number | undefined): Promise<number> {
  if (configuredExpiry !== undefined) return configuredExpiry;
  if (hardhatNetwork.name !== "local" && hardhatNetwork.name !== "local-devnet") {
    throw new Error("EDF upgrade vote expiryTimestamp is required on this network");
  }

  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Failed to read the latest block for the local EDF test expiry");
  return latestBlock.timestamp + LOCAL_TEST_EXPIRY_SECONDS;
}

function getStoredDelegationContract(
  state: ReturnType<typeof readNetworkState>,
  id: string,
): ResolvedStoredDelegationContract {
  const stored = state[Sk.delegationFactory]?.delegationContracts?.[id] as StoredDelegationContract | undefined;
  if (
    !stored?.address ||
    !stored.owner ||
    !stored.delegate ||
    stored.cooldown === undefined ||
    !stored.runtimeCodeHash
  ) {
    throw new Error(`Delegation contract ${id} is missing its resolved on-chain configuration`);
  }
  return stored as ResolvedStoredDelegationContract;
}

export async function deployEDFUpgradeTemplate(dualGovernance?: string) {
  const state = readNetworkState();
  const parameters = readEDFUpgradeParameters();
  const deployerSigner = await getDeployerSigner();
  const deployer = deployerSigner.address;

  await logScriptHeader("EDF/DSM v5 — Deploy EDFUpgradeTemplate", deployer);

  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const locatorProxy = OssifiableProxy__factory.connect(locatorAddress, deployerSigner);
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);
  const oldDepositSecurityModule = await locator.depositSecurityModule();
  const oldDSM = DepositSecurityModule__factory.connect(oldDepositSecurityModule, deployerSigner);

  const factoryAddress = getAddress(Sk.delegationFactory, state);
  const factoryCode = await ethers.provider.getCode(factoryAddress);
  if (factoryCode === "0x") throw new Error(`DelegationFactory at ${factoryAddress} has no bytecode`);
  const factoryRuntimeCodeHash = ethers.keccak256(factoryCode);
  const storedFactoryCodeHash = state[Sk.delegationFactory]?.runtimeCodeHash as string | undefined;
  if (storedFactoryCodeHash && storedFactoryCodeHash.toLowerCase() !== factoryRuntimeCodeHash.toLowerCase()) {
    throw new Error(
      `DelegationFactory runtime code hash mismatch: state ${storedFactoryCodeHash}, actual ${factoryRuntimeCodeHash}`,
    );
  }

  const upgradeParams: EDFUpgradeParametersStruct = {
    chainId: parameters.chainId,
    locator: locatorAddress,
    oldLocatorImplementation: await locatorProxy.proxy__getImplementation(),
    newLocatorImplementation: state[Sk.lidoLocator].implementation.address,
    locatorAdmin: await locatorProxy.proxy__getAdmin(),
    agent: getAddress(Sk.appAgent, state),
    voting: getAddress(Sk.appVoting, state),
    dualGovernance: dualGovernance ?? getAddress(Sk.dgDualGovernance, state),
    stakingRouter: getAddress(Sk.stakingRouter, state),
    oldDepositSecurityModule,
    newDepositSecurityModule: getAddress(Sk.depositSecurityModule, state),
    oldDepositSecurityModuleVersion: await oldDSM.VERSION(),
    delegationFactory: factoryAddress,
    delegationFactoryRuntimeCodeHash: factoryRuntimeCodeHash,
    pauseIntentValidityPeriodBlocks: parameters.depositSecurityModule.pauseIntentValidityPeriodBlocks,
    maxOperatorsPerUnvetting: parameters.depositSecurityModule.maxOperatorsPerUnvetting,
    guardianQuorum: parameters.depositSecurityModule.quorum,
    topUpGateway: parameters.topUpGateway.address,
    depositorDelegationContract: getResolvedDelegationContractAddress(
      state,
      parameters.topUpGateway.delegationContractId,
    ),
    guardianMappings: parameters.depositSecurityModule.guardianMappings.map((mapping) => ({
      oldMember: mapping.oldMember,
      newMember: getResolvedDelegationContractAddress(state, mapping.delegationContractId),
    })),
    oracleCommittees: parameters.oracleCommittees.map((committee) => ({
      consensusContract: committee.consensusContract,
      quorum: committee.quorum,
      memberMappings: committee.memberMappings.map((mapping) => ({
        oldMember: mapping.oldMember,
        newMember: getResolvedDelegationContractAddress(state, mapping.delegationContractId),
      })),
    })),
    delegationContracts: parameters.executionDelegationFramework.delegationContracts.map(({ id }) => {
      const stored = getStoredDelegationContract(state, id);
      if (stored.factory && ethers.getAddress(stored.factory) !== ethers.getAddress(factoryAddress)) {
        throw new Error(`Delegation contract ${id} was not deployed by the configured factory`);
      }
      return {
        delegationContract: stored.address,
        owner: stored.owner,
        delegate: stored.delegate,
        cooldown: stored.cooldown,
        runtimeCodeHash: stored.runtimeCodeHash,
      };
    }),
  };
  const expiryTimestamp = await resolveExpiryTimestamp(parameters.upgradeVoteScript.expiryTimestamp);
  const constructorArgs: ConstructorArgs<EDFUpgradeTemplate__factory> = [upgradeParams, expiryTimestamp];

  logStartReview();
  await logArgs("EDFUpgradeTemplate", constructorArgs);
  await logConfirmReview();

  const template = await deployWithoutProxy(Sk.upgradeTemplate, "EDFUpgradeTemplate", deployer, constructorArgs);
  const configAddress = await template.getFunction("CONFIG")();
  updateObjectInState(Sk.upgradeConfig, {
    contract: await getContractPath("EDFUpgradeConfig"),
    address: configAddress,
    constructorArgs: [upgradeParams],
  });
}

export async function main() {
  await deployEDFUpgradeTemplate();
}
