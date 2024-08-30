import { ethers } from "hardhat";

import { deployImplementation, deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  // Deploy Aragon app implementations
  await deployImplementation(Sk.appAgent, "Agent", deployer);
  await deployImplementation(Sk.appFinance, "Finance", deployer);
  await deployImplementation(Sk.appTokenManager, "TokenManager", deployer);
  await deployImplementation(Sk.appVoting, "Voting", deployer);

  // Deploy Lido-specific app implementations
  await deployImplementation(Sk.appLido, "Lido", deployer);
  await deployImplementation(Sk.appOracle, "LegacyOracle", deployer);
  await deployImplementation(Sk.appNodeOperatorsRegistry, "NodeOperatorsRegistry", deployer);

  // Deploy LidoTemplate and update state with deployment block
  const template = await deployWithoutProxy(Sk.lidoTemplate, "LidoTemplate", state.deployer, [
    state.deployer,
    state.daoFactory.address,
    state.ens.address,
    state.miniMeTokenFactory.address,
    state.aragonID.address,
    state.apmRegistryFactory.address,
  ]);

  const receipt = await ethers.provider.getTransactionReceipt(template.deploymentTx);
  updateObjectInState(Sk.lidoTemplate, { deployBlock: receipt?.blockNumber });
}
