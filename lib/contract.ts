import { type BaseContract, type ContractRunner } from "ethers";
import hre from "hardhat";

import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import { type NonPayableOverrides } from "typechain-types/common.js";
import { getDeployerSigner } from "./account.js";

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
  const artifact = await hre.artifacts.readArtifact(name);
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
  const { ethers } = await hre.network.getOrCreate();
  if (!signer) {
    signer = await getDeployerSigner();
  }
  const result = await ethers.getContractAt(name, address, signer);
  return (await addContractHelperFields(result, name)) as unknown as LoadedContract<ContractType>;
}

export async function getContractPath(contractName: string) {
  const artifact = await hre.artifacts.readArtifact(contractName);
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
