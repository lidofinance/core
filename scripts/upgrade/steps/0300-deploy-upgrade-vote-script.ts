import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployerSigner = await ethers.provider.getSigner();
  const deployer = deployerSigner.address;
  const state = readNetworkState();
  const parameters = readUpgradeParameters();

  const template = state[Sk.upgradeTemplate];

  await deployWithoutProxy(Sk.upgradeVoteScript, "UpgradeVoteScript", deployer, [
    [template.address, parameters.upgradeVoteScript.timeConstraintsContract, parameters.upgradeVoteScript.enabledDaySpanStart, parameters.upgradeVoteScript.enabledDaySpanEnd],
  ]);
}
