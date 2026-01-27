import { Contract } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  BeaconChainDepositor,
  DepositContract__MockForBeaconChainDepositor,
  Lido__MockForStakingRouter,
  LidoLocator,
  MinFirstAllocationStrategy,
  SRLib,
  StakingRouter__Harness,
} from "typechain-types";

import { proxify } from "lib";

import { deployLidoLocator } from "test/deploy";

export type StakingRouterWithLib = Contract & SRLib & MinFirstAllocationStrategy;

export interface DeployStakingRouterSigners {
  deployer: HardhatEthersSigner;
  admin: HardhatEthersSigner;
  user?: HardhatEthersSigner;
}

export interface DeployStakingRouterParams {
  depositContract?: DepositContract__MockForBeaconChainDepositor;
  lido?: Lido__MockForStakingRouter;
  lidoLocator?: LidoLocator;
}

export async function deployStakingRouter(
  { deployer, admin, user }: DeployStakingRouterSigners,
  { depositContract, lido, lidoLocator }: DeployStakingRouterParams = {},
): Promise<{
  depositContract: DepositContract__MockForBeaconChainDepositor;
  stakingRouter: StakingRouter__Harness;
  impl: StakingRouter__Harness;
  stakingRouterWithLib: StakingRouterWithLib;
  beaconChainDepositor: BeaconChainDepositor;
}> {
  if (!depositContract) {
    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor");
  }

  if (!lido) {
    lido = await ethers.deployContract("Lido__MockForStakingRouter", deployer);
  }

  if (!lidoLocator) {
    lidoLocator = await deployLidoLocator({ lido });
  }

  const beaconChainDepositor = await ethers.deployContract("BeaconChainDepositor", deployer);
  const allocLib = await ethers.deployContract("MinFirstAllocationStrategy", deployer);
  const srLib = await ethers.deployContract("SRLib", {
    signer: deployer,
    libraries: {
      ["contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]: await allocLib.getAddress(),
    },
  });
  const stakingRouterFactory = await ethers.getContractFactory("StakingRouter__Harness", {
    signer: deployer,
    libraries: {
      ["contracts/0.8.25/lib/BeaconChainDepositor.sol:BeaconChainDepositor"]: await beaconChainDepositor.getAddress(),
      ["contracts/0.8.25/sr/SRLib.sol:SRLib"]: await srLib.getAddress(),
    },
  });

  const impl = await stakingRouterFactory.connect(deployer).deploy(depositContract, lido, lidoLocator);
  const [stakingRouter] = await proxify({ impl, admin, caller: user });

  const combinedIface = new ethers.Interface([...stakingRouter.interface.fragments, ...srLib.interface.fragments]);
  const stakingRouterWithLib = new ethers.Contract(
    stakingRouter.target,
    combinedIface.fragments,
    stakingRouter.runner,
  ) as StakingRouterWithLib;

  return { stakingRouter, depositContract, impl, stakingRouterWithLib, beaconChainDepositor };
}
