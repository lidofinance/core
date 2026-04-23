import { ethers } from "hardhat";
import { readUpgradeParameters, skipIfContractInState } from "scripts/utils/upgrade";

import { UpgradeVoteScript__factory } from "typechain-types";
import { UpgradeVoteScript } from "typechain-types/contracts/upgrade/UpgradeVoteScript";

import { ConstructorArgs, log, logArgs, logConfirmReview, logScriptHeader, logStartReview, or } from "lib";
import { deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const state = readNetworkState();
  if (skipIfContractInState(state, Sk.upgradeVoteScript)) {
    log.warning(`Skipping step due to contract ${or(Sk.upgradeVoteScript)} is already in state`);
    return;
  }

  const parameters = readUpgradeParameters();
  const deployer = (await ethers.provider.getSigner()).address;

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
