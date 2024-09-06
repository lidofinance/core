import { ethers } from "hardhat";

import { getContractAt } from "lib/contract";
import { makeTx } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const template = await getContractAt("LidoTemplate", state[Sk.lidoTemplate].address);

  // Finalize the DAO by calling the finalizeDAO function on the template
  await makeTx(
    template,
    "finalizeDAO",
    [state.daoAragonId, state.vestingParams.unvestedTokensAmount, state.stakingRouter.proxy.address],
    { from: state.deployer },
  );
}
