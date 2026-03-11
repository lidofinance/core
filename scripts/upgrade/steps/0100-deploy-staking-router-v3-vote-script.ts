import assert from "assert";
import { ethers } from "hardhat";
import { readStakingRouterV3VoteScriptParameters } from "scripts/utils/staking-router-v3-vote";

import { deployContract, deployWithoutProxy, log, Sk } from "lib";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  assert.equal(process.env.DEPLOYER, deployer);

  const params = readStakingRouterV3VoteScriptParameters();

  const csmStepsLib = await deployContract("CSMUpgradeSteps", [], deployer, false);
  log.success("CSMUpgradeSteps library deployed", csmStepsLib.address);

  const curatedStepsLib = await deployContract("CuratedModuleSteps", [], deployer, false);
  log.success("CuratedModuleSteps library deployed", curatedStepsLib.address);

  await deployWithoutProxy(
    Sk.stakingRouterV3VoteScript,
    "StakingRouterV3VoteScript",
    deployer,
    [params],
    "address",
    true,
    {
      libraries: {
        CSMUpgradeSteps: csmStepsLib.address,
        CuratedModuleSteps: curatedStepsLib.address,
      },
    },
  );
}
