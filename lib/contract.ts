import { BaseContract, ContractRunner } from "ethers";
import { artifacts, ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

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
