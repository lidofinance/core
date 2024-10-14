import { ethers } from "hardhat";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { streccak } from "lib/keccak";
import { readNetworkState, Sk } from "lib/state-file";

const STAKING_MODULE_MANAGE_ROLE = streccak("STAKING_MODULE_MANAGE_ROLE");

const NOR_STAKING_MODULE_TARGET_SHARE_BP = 10000; // 100%
const NOR_STAKING_MODULE_MODULE_FEE_BP = 500; // 5%
const NOR_STAKING_MODULE_TREASURY_FEE_BP = 500; // 5%

const SDVT_STAKING_MODULE_TARGET_SHARE_BP = 400; // 4%
const SDVT_STAKING_MODULE_MODULE_FEE_BP = 800; // 8%
const SDVT_STAKING_MODULE_TREASURY_FEE_BP = 200; // 2%

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
      state.nodeOperatorsRegistry.deployParameters.stakingModuleTypeId,
      state[Sk.appNodeOperatorsRegistry].proxy.address,
      NOR_STAKING_MODULE_TARGET_SHARE_BP,
      NOR_STAKING_MODULE_MODULE_FEE_BP,
      NOR_STAKING_MODULE_TREASURY_FEE_BP,
    ],
    { from: deployer },
  );

  await makeTx(
    stakingRouter,
    "addStakingModule",
    [
      state.simpleDvt.deployParameters.stakingModuleTypeId,
      state[Sk.appSimpleDvt].proxy.address,
      SDVT_STAKING_MODULE_TARGET_SHARE_BP,
      SDVT_STAKING_MODULE_MODULE_FEE_BP,
      SDVT_STAKING_MODULE_TREASURY_FEE_BP,
    ],
    { from: deployer },
  );

  // Renounce STAKING_MODULE_MANAGE_ROLE from deployer
  await makeTx(stakingRouter, "renounceRole", [STAKING_MODULE_MANAGE_ROLE, deployer], { from: deployer });
}
