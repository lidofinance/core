import { deployEDFUpgradeTemplate } from "scripts/upgrade/steps/0912-edf-deploy-upgrade-template";

import { getAddress, readNetworkState, Sk } from "lib";

export async function main() {
  const state = readNetworkState();

  // EDFUpgradeConfig requires a non-zero DG address. The direct devnet vote
  // helper never uses this value, so the Aragon Agent is a safe placeholder.
  await deployEDFUpgradeTemplate(getAddress(Sk.appAgent, state));
}
