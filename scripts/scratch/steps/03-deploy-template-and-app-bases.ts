import { ethers } from "hardhat";

import { deployImplementation, deployWithoutProxy } from "lib/deploy";
import { log } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

async function main() {
  log.scriptStart(__filename);
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const templateConstructorArgs = [
    state.deployer,
    state.daoFactory.address,
    state.ens.address,
    state.miniMeTokenFactory.address,
    state.aragonID.address,
    state.apmRegistryFactory.address,
  ];

  await deployImplementation(Sk.appAgent, "Agent", deployer);
  await deployImplementation(Sk.appFinance, "Finance", deployer);
  await deployImplementation(Sk.appTokenManager, "TokenManager", deployer);
  await deployImplementation(Sk.appVoting, "Voting", deployer);

  await deployImplementation(Sk.appLido, "Lido", deployer);
  await deployImplementation(Sk.appOracle, "LegacyOracle", deployer);
  await deployImplementation(Sk.appNodeOperatorsRegistry, "NodeOperatorsRegistry", deployer);

  const template = await deployWithoutProxy(Sk.lidoTemplate, "LidoTemplate", state.deployer, templateConstructorArgs);
  const receipt = await ethers.provider.getTransactionReceipt(template.deploymentTx);
  updateObjectInState(Sk.lidoTemplate, { deployBlock: receipt?.blockNumber });

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
