import { ethers } from "hardhat";
import { checkArtifactDeployedAndLog } from "scripts/utils/upgrade";

import { UpgradeVoteScript__factory } from "typechain-types";
import { UpgradeVoteScript } from "typechain-types/contracts/upgrade/UpgradeVoteScript";

import {
  ConstructorArgs,
  deployWithoutProxy,
  logArgs,
  logConfirmReview,
  logScriptHeader,
  logStartReview,
  readNetworkState,
  Sk,
} from "lib";

export async function skip(): Promise<boolean> {
  return await checkArtifactDeployedAndLog(Sk.upgradeVoteScript);
}

export async function main() {
  const state = readNetworkState();
  const deployer = (await ethers.provider.getSigner()).address;

  await logScriptHeader("SRv3/CMv2 — Deploy UpgradeVotingScript contract", deployer);

  const template = state[Sk.upgradeTemplate];

  const votingScriptParams: UpgradeVoteScript.ScriptParamsStruct = {
    upgradeTemplate: template.address,
  };
  const upgradeVoteScriptConstructorArgs: ConstructorArgs<UpgradeVoteScript__factory> = [votingScriptParams];

  logStartReview();
  await logArgs("UpgradeVoteScript", upgradeVoteScriptConstructorArgs);
  await logConfirmReview();

  await deployWithoutProxy(Sk.upgradeVoteScript, "UpgradeVoteScript", deployer, upgradeVoteScriptConstructorArgs);
}
