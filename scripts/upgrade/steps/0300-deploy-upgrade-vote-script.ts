import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { UpgradeVoteScript__factory } from "typechain-types";
import { UpgradeVoteScript } from "typechain-types/contracts/upgrade/UpgradeVoteScript";

import { ConstructorArgs, logArgs, logConfirmReview, logScriptHeader, logStartReview } from "lib";
import { deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;

  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  await logScriptHeader("SRv3/CMv2 — Deploy UpgradeVotingScript contract", deployer);

  const template = state[Sk.upgradeTemplate];

  const votingScriptParams: UpgradeVoteScript.ScriptParamsStruct = {
    upgradeTemplate: template.address,
    timeConstraints: parameters.upgradeVoteScript.timeConstraintsContract,
    enabledDaySpanStart: parameters.upgradeVoteScript.enabledDaySpanStart,
    enabledDaySpanEnd: parameters.upgradeVoteScript.enabledDaySpanEnd,
  };
  const upgradeVoteScriptConstructorArgs: ConstructorArgs<UpgradeVoteScript__factory> = [votingScriptParams];

  logStartReview();
  await logArgs("UpgradeVoteScript", upgradeVoteScriptConstructorArgs);
  await logConfirmReview();

  await deployWithoutProxy(Sk.upgradeVoteScript, "UpgradeVoteScript", deployer, [
    [
      template.address,
      parameters.upgradeVoteScript.timeConstraintsContract,
      parameters.upgradeVoteScript.enabledDaySpanStart,
      parameters.upgradeVoteScript.enabledDaySpanEnd,
    ],
  ]);
}
