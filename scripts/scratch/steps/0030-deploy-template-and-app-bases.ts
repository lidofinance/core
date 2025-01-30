import { ethers } from "hardhat";

import { deployImplementation, deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  await Promise.all([
    // Deploy Aragon app implementations
    deployImplementation(Sk.appAgent, "Agent", deployer),
    deployImplementation(Sk.appFinance, "Finance", deployer),
    deployImplementation(Sk.appTokenManager, "TokenManager", deployer),
    deployImplementation(Sk.appVoting, "Voting", deployer),
    // Deploy Lido-specific app implementations
    deployImplementation(Sk.appLido, "Lido", deployer),
    deployImplementation(Sk.appOracle, "LegacyOracle", deployer),
  ]);

  const minFirstAllocationStrategy = await deployWithoutProxy(
    Sk.minFirstAllocationStrategy,
    "MinFirstAllocationStrategy",
    deployer,
  );
  await deployImplementation(Sk.appNodeOperatorsRegistry, "NodeOperatorsRegistry", deployer, [], {
    libraries: { MinFirstAllocationStrategy: minFirstAllocationStrategy.address },
  });

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
