import { loadContract } from "lib/contract.js";
import { makeTx } from "lib/deploy.js";
import { ethers } from "lib/hardhat.js";
import { readNetworkState, Sk } from "lib/state-file.js";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const template = await loadContract("LidoTemplate", state[Sk.lidoTemplate].address);

  // Finalize the DAO by calling the finalizeDAO function on the template
  await makeTx(
    template,
    "finalizeDAO",
    [state.daoAragonId, state.vestingParams.unvestedTokensAmount, state.stakingRouter.proxy.address],
    { from: state.deployer },
  );
}
