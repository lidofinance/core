import assert from "assert";
import { ethers } from "hardhat";
import { readStakingRouterV3VoteScriptParameters } from "scripts/utils/staking-router-v3-vote";

import { deployWithoutProxy, Sk } from "lib";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  assert.equal(process.env.DEPLOYER, deployer);

  const params = readStakingRouterV3VoteScriptParameters();

  await deployWithoutProxy(Sk.stakingRouterV3VoteScript, "StakingRouterV3VoteScript", deployer, [params]);
}
