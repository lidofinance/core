import { mockAragonVoting } from "scripts/utils/upgrade";

import { UpgradeTemplate } from "typechain-types";

import { getAddressValidated, isContractDeployed, loadContract, log, readNetworkState, Sk } from "lib";

export async function skip(): Promise<boolean> {
  const state = readNetworkState();
  // NOT skip if contract object exists in deployed state but address set as empty string or zero address
  const address = getAddressValidated(Sk.upgradeTemplate, state);
  // NOT skip if contract not deployed yet
  const isDeployed = !!(address && (await isContractDeployed(address)));

  if (isDeployed) {
    log(`UpgradeTemplate already deployed at ${address}`);
    const template = await loadContract<UpgradeTemplate>("UpgradeTemplate", address);

    const isFinished = await template.isUpgradeFinished();
    log(`isUpgradeFinished is ${isFinished}`);
    return isFinished;
  }

  return false;
}

export async function main() {
  await mockAragonVoting(readNetworkState());
}
