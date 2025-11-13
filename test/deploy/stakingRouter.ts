import { Contract } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { DepositContract__MockForBeaconChainDepositor, SRLib, StakingRouter__Harness } from "typechain-types";

import { GENESIS_TIME, proxify, SECONDS_PER_SLOT } from "lib";

export type StakingRouterWithLib = Contract & SRLib;

export interface DeployStakingRouterSigners {
  deployer: HardhatEthersSigner;
  admin: HardhatEthersSigner;
  user?: HardhatEthersSigner;
}

export interface DeployStakingRouterParams {
  depositContract?: DepositContract__MockForBeaconChainDepositor;
  secondsPerSlot?: bigint | undefined;
  genesisTime?: bigint | undefined;
}

export async function deployStakingRouter(
  { deployer, admin, user }: DeployStakingRouterSigners,
  { depositContract, secondsPerSlot = SECONDS_PER_SLOT, genesisTime = GENESIS_TIME }: DeployStakingRouterParams = {},
): Promise<{
  depositContract: DepositContract__MockForBeaconChainDepositor;
  stakingRouter: StakingRouter__Harness;
  impl: StakingRouter__Harness;
  stakingRouterWithLib: StakingRouterWithLib;
}> {
  if (!depositContract) {
    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor");
  }

  const beaconChainDepositor = await ethers.deployContract("BeaconChainDepositor", deployer);
  // const depositsTracker = await ethers.deployContract("DepositsTracker", deployer);
  const srLib = await ethers.deployContract("SRLib", deployer);
  const stakingRouterFactory = await ethers.getContractFactory("StakingRouter__Harness", {
    libraries: {
      ["contracts/0.8.25/lib/BeaconChainDepositor.sol:BeaconChainDepositor"]: await beaconChainDepositor.getAddress(),
      // ["contracts/common/lib/DepositsTracker.sol:DepositsTracker"]: await depositsTracker.getAddress(),
      ["contracts/0.8.25/sr/SRLib.sol:SRLib"]: await srLib.getAddress(),
    },
  });

  const impl = await stakingRouterFactory.connect(deployer).deploy(depositContract, secondsPerSlot, genesisTime);
  const [stakingRouter] = await proxify({ impl, admin, caller: user });

  const combinedIface = new ethers.Interface([...stakingRouter.interface.fragments, ...srLib.interface.fragments]);
  const stakingRouterWithLib = new ethers.Contract(
    stakingRouter.target,
    combinedIface.fragments,
    stakingRouter.runner,
  ) as StakingRouterWithLib;

  return { stakingRouter, depositContract, impl, stakingRouterWithLib };
}
