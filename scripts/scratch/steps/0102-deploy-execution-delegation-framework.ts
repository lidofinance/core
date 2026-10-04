import { getDeployerState } from "#lib/deploy.js";

import { deployExecutionDelegationFramework } from "#scripts/utils/execution-delegation-framework.js";

export async function main() {
  const { state } = await getDeployerState();

  await deployExecutionDelegationFramework(state);
}
