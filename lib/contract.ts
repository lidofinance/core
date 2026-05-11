import { BaseContract, ContractRunner } from "ethers";
import { artifacts, ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { NonPayableOverrides } from "typechain-types/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MethodArgs<C, M extends keyof C> = C[M] extends (...args: any[]) => any ? Parameters<C[M]> : never;

// constructor args
// example:  const constructorArgs:  ConstructorArgs<UpgradeTemporaryAdmin__factory>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContractWithConstructor = { deploy: (...args: any[]) => any };
type DeployArgs<C extends ContractWithConstructor> = MethodArgs<C, "deploy">;
type RequiredDeployArgs<C extends ContractWithConstructor> = Required<DeployArgs<C>>;
export type ConstructorArgs<C extends ContractWithConstructor> =
  RequiredDeployArgs<C> extends [...infer Args, infer Last]
    ? Last extends NonPayableOverrides & { from?: string } // check if `overrides?` are the last argument
      ? Args
      : DeployArgs<C>
    : DeployArgs<C>;

// initialize method args
// example: const initArgs: InitializeArgs<TopUpGateway> = [param1, param2];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContractWithInitialize = { initialize: (...args: any[]) => any };
export type InitializeArgs<C extends ContractWithInitialize> = MethodArgs<C, "initialize">;

// finalizeUpgrade_xxx method args
// example: for finalizeUpgrade_v5() -  const finArgs: FinalizeUpgradeArgs<StakingRouter, "v5">;
type ContractWithFinalizeUpgrade<C, Suffix extends string> = Extract<keyof C, `finalizeUpgrade_${Suffix}`>;
export type FinalizeUpgradeArgs<C, Suffix extends string> = MethodArgs<C, ContractWithFinalizeUpgrade<C, Suffix>>;

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

export async function encodeFunctionCall<T extends readonly unknown[] = readonly unknown[]>(
  contractName: string,
  method: string,
  args: T,
) {
  const artifact = await artifacts.readArtifact(contractName);
  const contractInterface = new ethers.Interface(artifact.abi);
  return contractInterface.encodeFunctionData(method, args);
}

export async function isContractDeployed(address: string): Promise<boolean> {
  const code = await ethers.provider.getCode(address);
  return code !== "0x";
}
