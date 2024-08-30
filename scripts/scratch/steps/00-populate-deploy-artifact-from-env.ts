import { ethers } from "hardhat";

import { log } from "lib";
import { persistNetworkState, readNetworkState, Sk } from "lib/state-file";

function getEnvVariable(name: string, defaultValue?: string): string {
  const value = process.env[name] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Environment variable ${name} is required`);
  }
  log(`${name} = ${value}`);
  return value;
}

export async function main() {
  // Retrieve environment variables
  const deployer = ethers.getAddress(getEnvVariable("DEPLOYER"));
  const gateSealFactoryAddress = getEnvVariable("GATE_SEAL_FACTORY", "");
  const genesisTime = parseInt(getEnvVariable("GENESIS_TIME"));
  const depositContractAddress = getEnvVariable("DEPOSIT_CONTRACT", "");
  const withdrawalQueueBaseUri = getEnvVariable("WITHDRAWAL_QUEUE_BASE_URI", "");
  const dsmPredefinedAddress = getEnvVariable("DSM_PREDEFINED_ADDRESS", "");

  const state = readNetworkState();

  // Update network-related information
  state.networkId = parseInt(await ethers.provider.send("net_version"));
  state.chainId = parseInt((await ethers.provider.getNetwork()).chainId.toString());
  state.deployer = deployer;

  // Update state with new values from environment variables
  state.chainSpec = { ...state.chainSpec, genesisTime };

  if (depositContractAddress) {
    state.chainSpec.depositContract = ethers.getAddress(depositContractAddress);
  }

  if (gateSealFactoryAddress) {
    state.gateSeal = {
      ...state.gateSeal,
      factoryAddress: gateSealFactoryAddress,
    };
  }

  if (withdrawalQueueBaseUri) {
    state.withdrawalQueueERC721.deployParameters = {
      ...state.withdrawalQueueERC721.deployParameters,
      baseUri: withdrawalQueueBaseUri,
    };
  }

  if (dsmPredefinedAddress) {
    state.depositSecurityModule.address = dsmPredefinedAddress;
    state.depositSecurityModule.deployParameters = {
      ...state.depositSecurityModule.deployParameters,
      usePredefinedAddressInstead: ethers.getAddress(dsmPredefinedAddress),
    };
  }

  // Initialize gas usage tracking
  state[Sk.scratchDeployGasUsed] = 0n.toString();

  persistNetworkState(state);

  log.emptyLine(); // Add an empty line for better readability
}
