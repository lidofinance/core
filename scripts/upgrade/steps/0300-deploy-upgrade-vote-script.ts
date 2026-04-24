import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { UpgradeVoteScript__factory } from "typechain-types";
import { UpgradeVoteScript } from "typechain-types/contracts/upgrade/UpgradeVoteScript";

import {
  ConstructorArgs,
  deployWithoutProxy,
  getAddressValidated,
  isContractDeployed,
  logArgs,
  logConfirmReview,
  logScriptHeader,
  logStartReview,
  readNetworkState,
  Sk,
} from "lib";

export async function skip(): Promise<boolean> {
  const state = readNetworkState();
  // NOT skip if contract object exists in deployed state but address set as empty string or zero address
  const address = getAddressValidated(Sk.upgradeVoteScript, state);
  // NOT skip if contract not deployed yet
  return !!(address && (await isContractDeployed(address)));
}

export async function main() {
  const state = readNetworkState();
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
