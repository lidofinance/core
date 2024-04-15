import { ethers } from "hardhat";

import { getContractAt } from "lib/contract";
import { makeTx } from "lib/deploy";
import { log } from "lib/log";
import { readNetworkState, Sk } from "lib/state-file";

async function main() {
  log.scriptStart(__filename);
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const template = await getContractAt("LidoTemplate", state[Sk.lidoTemplate].address);
  await makeTx(
    template,
    "finalizeDAO",
    [state.daoAragonId, state.vestingParams.unvestedTokensAmount, state.stakingRouter.proxy.address],
    { from: state.deployer },
  );

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
