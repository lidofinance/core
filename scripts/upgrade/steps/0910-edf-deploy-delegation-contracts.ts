import { deployOrReuseEDFDelegationContracts } from "scripts/utils/edf-upgrade";
import { readEDFUpgradeParameters } from "scripts/utils/upgrade";

import { getDeployerSigner, logScriptHeader, readNetworkState } from "lib";

export async function main() {
  const state = readNetworkState();
  const parameters = readEDFUpgradeParameters();
  const deployer = (await getDeployerSigner()).address;

  await logScriptHeader("EDF/DSM v5 — Deploy delegation contracts", deployer);
  await deployOrReuseEDFDelegationContracts(state, parameters);
}
