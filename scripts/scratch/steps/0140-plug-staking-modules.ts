import { ethers } from "hardhat";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { streccak } from "lib/keccak";
import { readNetworkState, Sk } from "lib/state-file";

const STAKING_MODULE_MANAGE_ROLE = streccak("STAKING_MODULE_MANAGE_ROLE");

const NOR_STAKING_MODULE_STAKE_SHARE_LIMIT_BP = 10000; // 100%
const NOR_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP = 10000; // 100%
const NOR_STAKING_MODULE_MODULE_FEE_BP = 500; // 5%
const NOR_STAKING_MODULE_TREASURY_FEE_BP = 500; // 5%
const NOR_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK = 150;
const NOR_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE = 25;

const SDVT_STAKING_MODULE_TARGET_SHARE_BP = 400; // 4%
const SDVT_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP = 10000; // 100%
const SDVT_STAKING_MODULE_MODULE_FEE_BP = 800; // 8%
const SDVT_STAKING_MODULE_TREASURY_FEE_BP = 200; // 2%
const SDVT_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK = 150;
const SDVT_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE = 25;

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  // Get contract instances
  const stakingRouter = await loadContract("StakingRouter", state.stakingRouter.proxy.address);

  // Grant STAKING_MODULE_MANAGE_ROLE to deployer
  await makeTx(stakingRouter, "grantRole", [STAKING_MODULE_MANAGE_ROLE, deployer], { from: deployer });

  // Add staking module to StakingRouter
  await makeTx(
    stakingRouter,
    "addStakingModule",
    [
      state.nodeOperatorsRegistry.deployParameters.stakingModuleName,
      state[Sk.appNodeOperatorsRegistry].proxy.address,
      NOR_STAKING_MODULE_STAKE_SHARE_LIMIT_BP,
      NOR_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP,
      NOR_STAKING_MODULE_MODULE_FEE_BP,
      NOR_STAKING_MODULE_TREASURY_FEE_BP,
      NOR_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK,
      NOR_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE,
    ],
    { from: deployer },
  );

  // Add simple DVT module to StakingRouter
  await makeTx(
    stakingRouter,
    "addStakingModule",
    [
      state.simpleDvt.deployParameters.stakingModuleName,
      state[Sk.appSimpleDvt].proxy.address,
      SDVT_STAKING_MODULE_TARGET_SHARE_BP,
      SDVT_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP,
      SDVT_STAKING_MODULE_MODULE_FEE_BP,
      SDVT_STAKING_MODULE_TREASURY_FEE_BP,
      SDVT_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK,
      SDVT_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE,
    ],
    { from: deployer },
  );

  // Renounce STAKING_MODULE_MANAGE_ROLE from deployer
  await makeTx(stakingRouter, "renounceRole", [STAKING_MODULE_MANAGE_ROLE, deployer], { from: deployer });
}
