import { ethers } from "hardhat";

import { getContractAt } from "lib/contract";
import { makeTx } from "lib/deploy";
import { streccak } from "lib/keccak";
import { log } from "lib/log";
import { readNetworkState, Sk } from "lib/state-file";

const NOR_STAKING_MODULE_STAKE_SHARE_LIMIT_BP = 10000; // 100%
const NOR_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP = 10000; // 100%
const NOR_STAKING_MODULE_MODULE_FEE_BP = 500; // 5%
const NOR_STAKING_MODULE_TREASURY_FEE_BP = 500; // 5%
const NOR_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK = 150;
const NOR_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE = 25;
const STAKING_MODULE_MANAGE_ROLE = streccak("STAKING_MODULE_MANAGE_ROLE");

async function main() {
  log.scriptStart(__filename);
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const stakingRouter = await getContractAt("StakingRouter", state.stakingRouter.proxy.address);
  const nodeOperatorsRegistry = await getContractAt(
    "NodeOperatorsRegistry",
    state[Sk.appNodeOperatorsRegistry].proxy.address,
  );

  await makeTx(stakingRouter, "grantRole", [STAKING_MODULE_MANAGE_ROLE, deployer], { from: deployer });

  await makeTx(
    stakingRouter,
    "addStakingModule",
    [
      state.nodeOperatorsRegistry.deployParameters.stakingModuleTypeId,
      nodeOperatorsRegistry.address,
      NOR_STAKING_MODULE_STAKE_SHARE_LIMIT_BP,
      NOR_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP,
      NOR_STAKING_MODULE_MODULE_FEE_BP,
      NOR_STAKING_MODULE_TREASURY_FEE_BP,
      NOR_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK,
      NOR_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE,
    ],
    { from: deployer },
  );
  await makeTx(stakingRouter, "renounceRole", [STAKING_MODULE_MANAGE_ROLE, deployer], { from: deployer });

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
