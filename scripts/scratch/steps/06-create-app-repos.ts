import { ethers } from "hardhat";

import { getContractAt } from "lib/contract";
import { makeTx } from "lib/deploy";
import { log } from "lib/log";
import { readNetworkState, setValueInState, Sk } from "lib/state-file";

const NULL_CONTENT_URI =
  "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

async function main() {
  log.scriptStart(__filename);
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  log.splitter();
  const template = await getContractAt("LidoTemplate", state[Sk.lidoTemplate].address);

  const createReposArguments = [
    [1, 0, 0], // Initial semantic version
    // Lido app
    state[Sk.appLido].implementation.address,
    NULL_CONTENT_URI,
    // NodeOperatorsRegistry app
    state[Sk.appNodeOperatorsRegistry].implementation.address,
    NULL_CONTENT_URI,
    // LegacyOracle app
    state[Sk.appOracle].implementation.address,
    NULL_CONTENT_URI,
  ];

  const lidoAppsReceipt = await makeTx(template, "createRepos", createReposArguments, { from: deployer });
  log(`Aragon Lido Apps Repos (Lido, AccountingOracle, NodeOperatorsRegistry deployed: ${lidoAppsReceipt.hash}`);

  const createStdAragonReposArguments = [
    state["app:aragon-agent"].implementation.address,
    state["app:aragon-finance"].implementation.address,
    state["app:aragon-token-manager"].implementation.address,
    state["app:aragon-voting"].implementation.address,
  ];

  const aragonStdAppsReceipt = await makeTx(template, "createStdAragonRepos", createStdAragonReposArguments, {
    from: deployer,
  });
  log(`=== Aragon Std Apps Repos (Agent, Finance, TokenManager, Voting deployed: ${aragonStdAppsReceipt.hash} ===`);
  setValueInState(Sk.lidoTemplateCreateStdAppReposTx, aragonStdAppsReceipt.hash);
  setValueInState(Sk.createAppReposTx, lidoAppsReceipt.hash);

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
