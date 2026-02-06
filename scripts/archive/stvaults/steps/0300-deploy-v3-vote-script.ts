import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployerSigner = await ethers.provider.getSigner();
  const deployer = deployerSigner.address;
  const state = readNetworkState();
  const parameters = readUpgradeParameters();

  const template = state[Sk.v3Template];

  await deployWithoutProxy(Sk.v3VoteScript, "V3VoteScript", deployer, [
    [
      template.address,
      parameters.v3VoteScript.timeConstraintsContract,
      parameters.v3VoteScript.odcSlashingReserveWeRightShiftEpochs,
      parameters.v3VoteScript.odcSlashingReserveWeLeftShiftEpochs,
    ],
  ]);
}
