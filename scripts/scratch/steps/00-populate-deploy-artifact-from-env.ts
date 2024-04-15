import { ethers } from "hardhat";

import { log, Sk } from "lib";

import { persistNetworkState, readNetworkState } from "../../../lib/state-file";

function getEnvVariable(name: string, defaultValue?: string) {
  const value = process.env[name];
  if (value === undefined) {
    if (defaultValue === undefined) {
      throw new Error(`Env variable ${name} must be set`);
    }
    return defaultValue;
  } else {
    log(`Using env variable ${name}=${value}`);
    return value;
  }
}

async function main() {
  log.scriptStart(__filename);

  const deployer = ethers.getAddress(getEnvVariable("DEPLOYER"));
  const gateSealFactoryAddress = getEnvVariable("GATE_SEAL_FACTORY", "");
  const genesisTime = parseInt(getEnvVariable("GENESIS_TIME"));
  const depositContractAddress = getEnvVariable("DEPOSIT_CONTRACT", "");
  const withdrawalQueueBaseUri = getEnvVariable("WITHDRAWAL_QUEUE_BASE_URI", "");
  const dsmPredefinedAddress = getEnvVariable("DSM_PREDEFINED_ADDRESS", "");

  const state = readNetworkState();

  state.networkId = parseInt(await ethers.provider.send("net_version"));
  state.chainId = parseInt((await ethers.provider.getNetwork()).chainId.toString());
  state.deployer = deployer;
  if (gateSealFactoryAddress) {
    state.gateSeal = {
      ...state.gateSeal,
      factoryAddress: gateSealFactoryAddress,
    };
  }
  state.chainSpec = {
    ...state.chainSpec,
    genesisTime: genesisTime,
  };
  if (depositContractAddress) {
    state.chainSpec.depositContract = ethers.getAddress(depositContractAddress);
  }
  if (withdrawalQueueBaseUri) {
    state.withdrawalQueueERC721.deployParameters = {
      ...state.withdrawalQueueERC721.deployParameters,
      baseUri: withdrawalQueueBaseUri,
    };
  }
  if (dsmPredefinedAddress) {
    state.depositSecurityModule.deployParameters = {
      ...state.depositSecurityModule.deployParameters,
      usePredefinedAddressInstead: ethers.getAddress(dsmPredefinedAddress),
    };
    state.depositSecurityModule.address = dsmPredefinedAddress;
  }
  state[Sk.scratchDeployGasUsed] = 0n.toString();
  persistNetworkState(state);
  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
