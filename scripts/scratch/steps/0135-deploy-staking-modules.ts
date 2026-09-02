import { getDeployerState } from "#lib/deploy.js";

import { deployStakingModules } from "#scripts/utils/staking-modules.js";

export async function main() {
  const { state } = await getDeployerState();

  await deployStakingModules(state);
}
