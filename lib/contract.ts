import { BaseContract, ContractRunner } from "ethers";
import { artifacts, ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { NonPayableOverrides } from "typechain-types/common";

// constructor args
// example:  const constructorArgs:  ConstructorArgs<UpgradeTemporaryAdmin__factory>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FactoryWithDeploy = { deploy: (...args: any[]) => any };
type DeployArgs<F extends FactoryWithDeploy> = Parameters<F["deploy"]>;
type RequiredDeployArgs<F extends FactoryWithDeploy> = Required<DeployArgs<F>>;
export type ConstructorArgs<F extends FactoryWithDeploy> =
  RequiredDeployArgs<F> extends [...infer Args, infer Last]
    ? Last extends NonPayableOverrides & { from?: string }
      ? Args
      : DeployArgs<F>
    : DeployArgs<F>;

// initialize method args
// example: const initArgs: InitializeArgs<TopUpGateway> = [param1, param2];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InitializeArgs<T extends { initialize: (...args: any[]) => any }> = Parameters<T["initialize"]>;

// finalizeUpgrade_xxx method args
// example: for finalizeUpgrade_v5() -  const finArgs: FinalizeUpgradeArgs<StakingRouter, "v5">;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MethodArgs<T, K extends keyof T> = T[K] extends (...args: any[]) => any ? Parameters<T[K]> : never;
type FinalizeUpgradeMethod<T, Suffix extends string> = Extract<keyof T, `finalizeUpgrade_${Suffix}`>;
export type FinalizeUpgradeArgs<T, Suffix extends string> = MethodArgs<T, FinalizeUpgradeMethod<T, Suffix>>;

interface LoadedContractHelper {
  name: string;
  contractPath: string;
  address: string;
}

interface DeployedContractHelper {
  deploymentTx: string;
  deploymentGasUsed: bigint;
}

export type LoadedContract<T extends BaseContract = BaseContract> = T & LoadedContractHelper;

export type DeployedContract = LoadedContract<BaseContract> & DeployedContractHelper;

type FactoryConnectFuncType<ContractType> = (address: string, runner?: ContractRunner | null) => ContractType;

export interface ContractFactoryHelper<ContractType> {
  connect: FactoryConnectFuncType<ContractType>;
  name: string; // It does not belong specifically to the ContractFactory but it is there
}

export async function addContractHelperFields(contract: BaseContract, name: string): Promise<LoadedContract> {
  const artifact = await artifacts.readArtifact(name);
  (contract as unknown as LoadedContract).name = name;
  (contract as unknown as LoadedContract).contractPath = artifact.sourceName;
  (contract as unknown as LoadedContract).address = await contract.getAddress();
  return contract as unknown as LoadedContract;
}

export async function loadContract<ContractType extends BaseContract>(
  name: string,
  address: string,
  signer?: HardhatEthersSigner,
) {
  if (!signer) {
    signer = await ethers.provider.getSigner();
  }
  const result = await ethers.getContractAt(name, address, signer);
  return (await addContractHelperFields(result, name)) as unknown as LoadedContract<ContractType>;
}

export async function getContractPath(contractName: string) {
  const artifact = await artifacts.readArtifact(contractName);
  return artifact.sourceName;
}
