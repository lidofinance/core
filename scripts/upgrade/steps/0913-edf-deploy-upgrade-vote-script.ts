import { EDFUpgradeVoteScript__factory } from "typechain-types";
import { EDFUpgradeVoteScript } from "typechain-types/contracts/upgrade/EDFUpgradeVoteScript";

import {
  ConstructorArgs,
  deployWithoutProxy,
  getDeployerSigner,
  logArgs,
  logConfirmReview,
  logScriptHeader,
  logStartReview,
  readNetworkState,
  Sk,
} from "lib";

export async function main() {
  const state = readNetworkState();
  const deployer = (await getDeployerSigner()).address;

  await logScriptHeader("EDF/DSM v5 — Deploy EDFUpgradeVoteScript", deployer);

  const templateAddress = state[Sk.upgradeTemplate]?.address as string | undefined;
  if (!templateAddress) throw new Error("EDFUpgradeTemplate is missing in deployment state");

  const scriptParams: EDFUpgradeVoteScript.ScriptParamsStruct = { upgradeTemplate: templateAddress };
  const constructorArgs: ConstructorArgs<EDFUpgradeVoteScript__factory> = [scriptParams];

  logStartReview();
  await logArgs("EDFUpgradeVoteScript", constructorArgs);
  await logConfirmReview();

  await deployWithoutProxy(Sk.upgradeVoteScript, "EDFUpgradeVoteScript", deployer, constructorArgs);
}
