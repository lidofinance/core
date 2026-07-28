import hre from "hardhat";

import { type HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import {
  type BeaconChainDepositor,
  type DepositContract__MockForBeaconChainDepositor,
  type Lido__MockForStakingRouter,
  type LidoLocator,
  type StakingRouter__Harness,
} from "typechain-types/index.js";

import { MAX_EFFECTIVE_BALANCE_WC_TYPE_01, MAX_EFFECTIVE_BALANCE_WC_TYPE_02, proxify } from "lib/index.js";

import { deployLidoLocator } from "test/deploy/index.js";

export interface DeployStakingRouterSigners {
  deployer: HardhatEthersSigner;
  admin: HardhatEthersSigner;
  user?: HardhatEthersSigner;
}

export interface DeployStakingRouterParams {
  depositContract?: DepositContract__MockForBeaconChainDepositor;
  lido?: Lido__MockForStakingRouter;
  lidoLocator?: LidoLocator;
  maxEBType1?: bigint;
  maxEBType2?: bigint;
}

export async function deployStakingRouter(
  { deployer, admin, user }: DeployStakingRouterSigners,
  {
    depositContract,
    lido,
    lidoLocator,
    maxEBType1 = MAX_EFFECTIVE_BALANCE_WC_TYPE_01,
    maxEBType2 = MAX_EFFECTIVE_BALANCE_WC_TYPE_02,
  }: DeployStakingRouterParams = {},
): Promise<{
  depositContract: DepositContract__MockForBeaconChainDepositor;
  stakingRouter: StakingRouter__Harness;
  impl: StakingRouter__Harness;
  beaconChainDepositor: BeaconChainDepositor;
}> {
  const { ethers } = await hre.network.getOrCreate();

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
      ["project/contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]:
        await allocLib.getAddress(),
    },
  });
  const stakingRouterFactory = await ethers.getContractFactory("StakingRouter__Harness", {
    signer: deployer,
    libraries: {
      ["project/contracts/0.8.25/lib/BeaconChainDepositor.sol:BeaconChainDepositor"]:
        await beaconChainDepositor.getAddress(),
      ["project/contracts/0.8.25/sr/SRLib.sol:SRLib"]: await srLib.getAddress(),
    },
  });

  const impl = await stakingRouterFactory
    .connect(deployer)
    .deploy(depositContract, lido, lidoLocator, maxEBType1, maxEBType2);
  const [stakingRouter] = await proxify({ impl, admin, caller: user });

  return { stakingRouter, depositContract, impl, beaconChainDepositor };
}
