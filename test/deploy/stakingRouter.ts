import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  BeaconChainDepositor,
  DepositContract__MockForBeaconChainDepositor,
  Lido__MockForStakingRouter,
  LidoLocator,
  StakingRouter__Harness,
} from "typechain-types";

import { MAX_EFFECTIVE_BALANCE_WC_TYPE_01, MAX_EFFECTIVE_BALANCE_WC_TYPE_02, proxify } from "lib";

import { deployLidoLocator } from "test/deploy";

export interface DeployStakingRouterSigners {
  deployer: HardhatEthersSigner;
  admin: HardhatEthersSigner;
  user?: HardhatEthersSigner;
}

export interface DeployStakingRouterParams {
  depositContract?: DepositContract__MockForBeaconChainDepositor;
  lido?: Lido__MockForStakingRouter;
  lidoLocator?: LidoLocator;
  mexEBType1?: bigint;
  mexEBType2?: bigint;
}

export async function deployStakingRouter(
  { deployer, admin, user }: DeployStakingRouterSigners,
  {
    depositContract,
    lido,
    lidoLocator,
    mexEBType1 = MAX_EFFECTIVE_BALANCE_WC_TYPE_01,
    mexEBType2 = MAX_EFFECTIVE_BALANCE_WC_TYPE_02,
  }: DeployStakingRouterParams = {},
): Promise<{
  depositContract: DepositContract__MockForBeaconChainDepositor;
  stakingRouter: StakingRouter__Harness;
  impl: StakingRouter__Harness;
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

  const impl = await stakingRouterFactory
    .connect(deployer)
    .deploy(depositContract, lido, lidoLocator, mexEBType1, mexEBType2);
  const [stakingRouter] = await proxify({ impl, admin, caller: user });

  return { stakingRouter, depositContract, impl, beaconChainDepositor };
}
