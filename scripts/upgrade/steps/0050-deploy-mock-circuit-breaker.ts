import { ethers } from "hardhat";

import { deployWithoutProxy, getAddressValidated, isContractDeployed, log, readNetworkState, Sk } from "lib";

export async function skip(): Promise<boolean> {
  const state = readNetworkState();
  const address = getAddressValidated(Sk.circuitBreaker, state);
  return !!(address && (await isContractDeployed(address)));
}

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;

  log.splitter();
  log.header("[Mocks] Deploy CircuitBreakerMock contract");

  await deployWithoutProxy(Sk.circuitBreaker, "CircuitBreakerMock", deployer, []);
}
