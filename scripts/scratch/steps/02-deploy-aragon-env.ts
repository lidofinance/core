import chalk from "chalk";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { DAOFactory, DAOFactory__factory, ENS, ENS__factory } from "typechain-types";

import { getContractAt, loadContract, LoadedContract } from "lib/contract";
import { deployImplementation, deployWithoutProxy, makeTx } from "lib/deploy";
import { assignENSName } from "lib/ens";
import { findEvents } from "lib/event";
import { streccak } from "lib/keccak";
import { log, logSplitter } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

async function main() {
  log.scriptStart(__filename);
  const deployer = (await ethers.provider.getSigner()).address;
  let state = readNetworkState({ deployer });

  let ens: LoadedContract<ENS>;

  log.header(`ENS`);
  if (state[Sk.ens].address) {
    log(`Using ENS: ${chalk.yellow(state[Sk.ens].address)}`);
    ens = await loadContract<ENS>(ENS__factory, state[Sk.ens].address);
  } else {
    const ensFactory = await deployWithoutProxy(Sk.ensFactory, "ENSFactory", deployer);
    const receipt = await makeTx(ensFactory, "newENS", [deployer], { from: deployer });
    const ensAddress = findEvents(receipt, "DeployENS")[0].args.ens;

    ens = await loadContract<ENS>(ENS__factory, ensAddress);
    state = updateObjectInState(Sk.ens, {
      address: ensAddress,
      constructorArgs: [deployer],
      contract: ens.contractPath,
    });
  }

  log.header(`DAO factory`);
  let daoFactoryAddress = state[Sk.daoFactory].address;
  if (daoFactoryAddress) {
    log(`Using DAO factory: ${chalk.yellow(state[Sk.daoFactory].address)}`);
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
  const daoFactory = await loadContract<DAOFactory>(DAOFactory__factory, daoFactoryAddress);

  log.header(`APM registry factory`);
  const apmRegistryBase = await deployImplementation(Sk.aragonApmRegistry, "APMRegistry", deployer);
  const apmRepoBase = await deployWithoutProxy(Sk.aragonRepoBase, "Repo", deployer);
  const ensSubdomainRegistrarBase = await deployImplementation(
    Sk.ensSubdomainRegistrar,
    "ENSSubdomainRegistrar",
    deployer,
  );
  const apmRegistryFactoryArgs = [
    daoFactory.address,
    apmRegistryBase.address,
    apmRepoBase.address,
    ensSubdomainRegistrarBase.address,
    ens.address,
    ZeroAddress,
  ];
  const apmRegistryFactory = await deployWithoutProxy(
    Sk.apmRegistryFactory,
    "APMRegistryFactory",
    deployer,
    apmRegistryFactoryArgs,
  );

  log.header(`Aragon APM`);
  log(`Deploying APM for node ${state[Sk.aragonEnsLabelName]}.eth...`);
  const { apmRegistry, ensNodeName, ensNode } = await deployAPM(
    deployer,
    state[Sk.aragonEnsLabelName],
    ens,
    apmRegistryFactory,
  );
  updateObjectInState(Sk.ensNode, {
    nodeName: ensNodeName,
    nodeIs: ensNode,
  });
  state = updateObjectInState(Sk.aragonApmRegistry, {
    proxy: {
      address: apmRegistry.address,
    },
  });

  log.header(`MiniMeTokenFactory`);
  if (state[Sk.miniMeTokenFactory].address) {
    log(`Using pre-deployed MiniMeTokenFactory ${state[Sk.miniMeTokenFactory].address}`);
  } else {
    await deployWithoutProxy(Sk.miniMeTokenFactory, "MiniMeTokenFactory", deployer);
  }

  log.header(`AragonID`);
  if (state[Sk.aragonId].address) {
    log(`Using pre-deployed AragonID (FIFSResolvingRegistrar) ${state[Sk.aragonId].address}`);
  } else {
    await deployAragonID(deployer, ens);
  }

  log.scriptFinish(__filename);
}

async function deployAPM(owner: string, labelName: string, ens: ENS, apmRegistryFactory: LoadedContract) {
  log(`Deploying APM for node ${labelName}.eth...`);

  logSplitter();
  const { parentNode, labelHash, nodeName, node } = await assignENSName(
    "eth",
    labelName,
    owner,
    ens,
    apmRegistryFactory.address,
    "APMRegistryFactory",
  );

  logSplitter();
  log(`Using APMRegistryFactory: ${chalk.yellow(apmRegistryFactory.address)}`);
  const receipt = await makeTx(apmRegistryFactory, "newAPM", [parentNode, labelHash, owner], { from: owner });
  const apmAddress = findEvents(receipt, "DeployAPM")[0].args.apm;
  log(`APMRegistry address: ${chalk.yellow(apmAddress)}`);
  logSplitter();

  const apmRegistry = await getContractAt("APMRegistry", apmAddress);

  return {
    apmRegistry,
    ensNodeName: nodeName,
    ensNode: node,
  };
}

async function deployAragonID(owner: string, ens: ENS) {
  const publicNode = ethers.namehash("resolver.eth");
  const publicResolverAddress = await ens.resolver(publicNode);
  log(`Using public resolver: ${chalk.yellow(publicResolverAddress)}`);

  const nodeName = "aragonid.eth";
  const node = ethers.namehash(nodeName);
  log(`ENS node: ${chalk.yellow(nodeName)} (${node})`);

  const fifsResolvingRegistrarArgs = [await ens.getAddress(), publicResolverAddress, node];
  const aragonID = await deployWithoutProxy(Sk.aragonId, "FIFSResolvingRegistrar", owner, fifsResolvingRegistrarArgs);

  logSplitter();
  await assignENSName("eth", "aragonid", owner, ens, aragonID.address, "AragonID");

  logSplitter();
  await makeTx(aragonID, "register", [streccak("owner"), owner], { from: owner });

  return aragonID;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
