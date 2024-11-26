import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { DAOFactory, ENS } from "typechain-types";

import { loadContract, LoadedContract } from "lib/contract";
import { deployImplementation, deployWithoutProxy, makeTx } from "lib/deploy";
import { assignENSName } from "lib/ens";
import { findEvents } from "lib/event";
import { streccak } from "lib/keccak";
import { cy, log, mg, yl } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

async function deployAPM(
  owner: string,
  labelName: string,
  ens: LoadedContract<ENS>,
  apmRegistryFactory: LoadedContract,
) {
  // Assign ENS name and get relevant information
  const { parentNode, labelHash, nodeName, node } = await assignENSName(
    "eth",
    labelName,
    owner,
    ens,
    apmRegistryFactory.address,
    "APMRegistryFactory",
  );

  // Deploy new APM
  const receipt = await makeTx(apmRegistryFactory, "newAPM", [parentNode, labelHash, owner], { from: owner });
  const apmAddress = findEvents(receipt, "DeployAPM")[0].args.apm;
  log(`Using APMRegistry: ${cy(apmAddress)}`);
  log.emptyLine();

  const apmRegistry = await loadContract("APMRegistry", apmAddress);

  return {
    apmRegistry,
    ensNodeName: nodeName,
    ensNode: node,
  };
}

async function deployAragonID(owner: string, ens: LoadedContract<ENS>) {
  // Get public resolver
  const publicNode = ethers.namehash("resolver.eth");
  const publicResolverAddress = await ens.resolver(publicNode);
  log(`Using public resolver: ${cy(publicResolverAddress)}`);

  const nodeName = "aragonid.eth";
  const node = ethers.namehash(nodeName);
  log(` Node: ${yl(nodeName)} (${mg(node)})`);
  log.emptyLine();

  // Deploy FIFSResolvingRegistrar (AragonID)
  const fifsResolvingRegistrarArgs = [await ens.getAddress(), publicResolverAddress, node];
  const aragonID = await deployWithoutProxy(Sk.aragonId, "FIFSResolvingRegistrar", owner, fifsResolvingRegistrarArgs);

  // Assign ENS name to AragonID and register owner
  await assignENSName("eth", "aragonid", owner, ens, aragonID.address, "AragonID");
  await makeTx(aragonID, "register", [streccak("owner"), owner], { from: owner });

  return aragonID;
}

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  let state = readNetworkState({ deployer });

  let ens: LoadedContract<ENS>;

  // Deploy or load ENS
  log.header(`ENS`);
  if (state[Sk.ens].address) {
    log(`Using pre-deployed ENS: ${cy(state[Sk.ens].address)}`);
    ens = await loadContract<ENS>("ENS", state[Sk.ens].address);
  } else {
    const ensFactory = await deployWithoutProxy(Sk.ensFactory, "ENSFactory", deployer);
    const receipt = await makeTx(ensFactory, "newENS", [deployer], { from: deployer });
    const ensAddress = findEvents(receipt, "DeployENS")[0].args.ens;

    ens = await loadContract<ENS>("ENS", ensAddress);
    state = updateObjectInState(Sk.ens, {
      address: ensAddress,
      constructorArgs: [deployer],
      contract: ens.contractPath,
    });
  }

  // Deploy or load DAO factory
  log.header(`DAO factory`);
  let daoFactoryAddress = state[Sk.daoFactory].address;
  if (daoFactoryAddress) {
    log(`Using pre-deployed DAOFactory: ${cy(state[Sk.daoFactory].address)}`);
  } else {
    const kernelBase = await deployImplementation(Sk.aragonKernel, "Kernel", deployer, [true]);
    const aclBase = await deployImplementation(Sk.aragonAcl, "ACL", deployer);
    const evmScriptRegistryFactory = await deployWithoutProxy(
      Sk.evmScriptRegistryFactory,
      "EVMScriptRegistryFactory",
      deployer,
    );
    const daoFactoryArgs = [kernelBase.address, aclBase.address, evmScriptRegistryFactory.address];
    daoFactoryAddress = (await deployWithoutProxy(Sk.daoFactory, "DAOFactory", deployer, daoFactoryArgs)).address;
  }
  const daoFactory = await loadContract<DAOFactory>("DAOFactory", daoFactoryAddress);

  // Deploy APM registry factory
  log.header(`APM registry factory`);
  const apmRegistryBase = await deployImplementation(Sk.aragonApmRegistry, "APMRegistry", deployer);
  const apmRepoBase = await deployWithoutProxy(Sk.aragonRepoBase, "Repo", deployer);
  const ensSubdomainRegistrarBase = await deployImplementation(
    Sk.ensSubdomainRegistrar,
    "ENSSubdomainRegistrar",
    deployer,
  );

  const apmRegistryFactory = await deployWithoutProxy(Sk.apmRegistryFactory, "APMRegistryFactory", deployer, [
    daoFactory.address,
    apmRegistryBase.address,
    apmRepoBase.address,
    ensSubdomainRegistrarBase.address,
    ens.address,
    ZeroAddress,
  ]);

  // Deploy Aragon APM
  log.header(`Aragon APM`);
  const { apmRegistry, ensNodeName, ensNode } = await deployAPM(
    deployer,
    state[Sk.aragonEnsLabelName],
    ens,
    apmRegistryFactory,
  );

  updateObjectInState(Sk.ensNode, { nodeName: ensNodeName, nodeIs: ensNode });
  state = updateObjectInState(Sk.aragonApmRegistry, { proxy: { address: apmRegistry.address } });

  // Deploy or load MiniMeTokenFactory
  log.header(`MiniMeTokenFactory`);
  if (state[Sk.miniMeTokenFactory].address) {
    log(`Using pre-deployed MiniMeTokenFactory: ${cy(state[Sk.miniMeTokenFactory].address)}`);
  } else {
    await deployWithoutProxy(Sk.miniMeTokenFactory, "MiniMeTokenFactory", deployer);
  }

  // Deploy or load AragonID
  log.header(`AragonID`);
  if (state[Sk.aragonId].address) {
    log(`Using pre-deployed AragonID (FIFSResolvingRegistrar): ${cy(state[Sk.aragonId].address)}`);
  } else {
    await deployAragonID(deployer, ens);
  }
}
