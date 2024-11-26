import { ethers } from "hardhat";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { readNetworkState, setValueInState, Sk } from "lib/state-file";

const NULL_CONTENT_URI =
  "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const template = await loadContract("LidoTemplate", state[Sk.lidoTemplate].address);

  // Create Lido app repos
  const lidoAppsReceipt = await makeTx(
    template,
    "createRepos",
    [
      [1, 0, 0], // Initial semantic version
      state[Sk.appLido].implementation.address,
      NULL_CONTENT_URI,
      state[Sk.appNodeOperatorsRegistry].implementation.address,
      NULL_CONTENT_URI,
      state[Sk.appOracle].implementation.address,
      NULL_CONTENT_URI,
    ],
    { from: deployer },
  );

  // Create standard Aragon app repos
  const aragonStdAppsReceipt = await makeTx(
    template,
    "createStdAragonRepos",
    [
      state["app:aragon-agent"].implementation.address,
      state["app:aragon-finance"].implementation.address,
      state["app:aragon-token-manager"].implementation.address,
      state["app:aragon-voting"].implementation.address,
    ],
    { from: deployer },
  );

  // Update state with transaction hashes
  setValueInState(Sk.lidoTemplateCreateStdAppReposTx, aragonStdAppsReceipt.hash);
  setValueInState(Sk.createAppReposTx, lidoAppsReceipt.hash);
}
