import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { LidoLocator, StakingRouter__factory } from "typechain-types";

import {
  ConstructorArgs,
  deployImplementation,
  deployWithoutProxy,
  getAddress,
  loadContract,
  log,
  logArgs,
  logConfirmReview,
  logScriptHeader,
  logStartReview,
  readNetworkState,
  Sk,
} from "lib";

function assertSameAddress(left: string, right: string, message: string) {
  if (left.toLowerCase() !== right.toLowerCase()) {
    throw new Error(`${message}: ${left} != ${right}`);
  }
}

export async function main() {
  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  const deployer = (await ethers.provider.getSigner()).address;

  await logScriptHeader("SRv3/CMv2 - hoodi StakingRouter fix (update4)", deployer);

  const chainSpec = state[Sk.chainSpec];
  const depositContractAddress = chainSpec.depositContract ?? chainSpec.depositContractAddress;
  if (!depositContractAddress) {
    throw new Error("Deposit contract address is missing in the state file");
  }

  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

  const lidoAddress = await locator.lido();
  const stakingRouterAddress = await locator.stakingRouter();
  assertSameAddress(stakingRouterAddress, getAddress(Sk.stakingRouter, state), "StakingRouter state/locator mismatch");

  const beaconChainDepositorAddress = getAddress(Sk.beaconChainDepositor, state);
  const minFirstAllocationStrategyAddress = getAddress(Sk.minFirstAllocationStrategy, state);

  const stakingRouterConstructorArgs: ConstructorArgs<StakingRouter__factory> = [
    depositContractAddress,
    lidoAddress,
    locatorAddress,
    parameters.stakingRouter.maxEBType1,
    parameters.stakingRouter.maxEBType2,
  ];

  logStartReview();
  log.info("SRLib linked libraries", {
    MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
  });
  log.info("StakingRouter linked libraries", {
    BeaconChainDepositor: beaconChainDepositorAddress,
  });
  await logArgs("SRLib", []);
  await logArgs("StakingRouter", stakingRouterConstructorArgs);
  await logConfirmReview();

  const srLib = await deployWithoutProxy(Sk.srLib, "SRLib", deployer, [], "address", true, {
    libraries: {
      MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
    },
  });

  await deployImplementation(Sk.stakingRouter, "StakingRouter", deployer, stakingRouterConstructorArgs, {
    libraries: {
      BeaconChainDepositor: beaconChainDepositorAddress,
      SRLib: srLib.address,
    },
  });
}
