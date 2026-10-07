import { getDeployerSigner, logScriptHeader, readNetworkState } from "#lib";

import { deployOrReuseEDFDelegationContracts } from "#scripts/utils/edf-upgrade.js";
import { readEDFUpgradeParameters } from "#scripts/utils/upgrade.js";

export async function main() {
  const state = readNetworkState();
  const parameters = readEDFUpgradeParameters();
  const deployer = (await getDeployerSigner()).address;

  await logScriptHeader("EDF/DSM v5 — Deploy delegation contracts", deployer);
  await deployOrReuseEDFDelegationContracts(state, parameters);
}
