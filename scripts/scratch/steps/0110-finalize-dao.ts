import { loadContract } from "#lib/contract.js";
import { getDeployerState, makeTx } from "#lib/deploy.js";
import { Sk } from "#lib/state-file.js";

export async function main() {
  const { state } = await getDeployerState();

  const template = await loadContract("LidoTemplate", state[Sk.lidoTemplate].address);

  // Finalize the DAO by calling the finalizeDAO function on the template
  await makeTx(
    template,
    "finalizeDAO",
    [state.daoAragonId, state.vestingParams.unvestedTokensAmount, state.stakingRouter.proxy.address],
    { from: state.deployer },
  );
}
