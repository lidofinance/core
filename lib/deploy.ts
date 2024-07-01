import { ContractFactory, ContractTransactionReceipt, Signer } from "ethers";
import { ethers } from "hardhat";
import { FactoryOptions } from "hardhat/types";

import {
  addContractHelperFields,
  DeployedContract,
  getContractAt,
  getContractPath,
  LoadedContract,
} from "lib/contract";
import { ConvertibleToString, log, yl } from "lib/log";
import { incrementGasUsed, Sk, updateObjectInState } from "lib/state-file";

const GAS_PRIORITY_FEE = process.env.GAS_PRIORITY_FEE || null;
const GAS_MAX_FEE = process.env.GAS_MAX_FEE || null;

const PROXY_CONTRACT_NAME = "OssifiableProxy";

type TxParams = {
  from: string;
  value?: bigint | string;
};

export async function makeTx(
  contract: LoadedContract,
  funcName: string,
  args: ConvertibleToString[],
  txParams: TxParams,
): Promise<ContractTransactionReceipt> {
  log.lineWithArguments(`${yl(contract.name)}[${contract.address}].${yl(funcName)}`, args);

  const tx = await contract.getFunction(funcName)(...args, txParams);
  log(`tx sent: ${tx.hash} (nonce ${tx.nonce})...`);

  const receipt = await tx.wait();
  const gasUsed = receipt.gasUsed;
  incrementGasUsed(gasUsed);
  log(`tx executed: gasUsed ${gasUsed}`);
  log.emptyLine();

  return receipt;
}

async function getDeployTxParams(deployer: string) {
  const deployerSigner = await ethers.provider.getSigner();
  if (deployer !== deployerSigner.address) {
    throw new Error("DEPLOYER set in ENV must correspond to the first signer of hardhat");
  }

  if (GAS_PRIORITY_FEE !== null && GAS_MAX_FEE !== null) {
    return {
      type: 2,
      maxPriorityFeePerGas: ethers.parseUnits(String(GAS_PRIORITY_FEE), "gwei"),
      maxFeePerGas: ethers.parseUnits(String(GAS_MAX_FEE), "gwei"),
    };
  } else {
    throw new Error('Must specify gas ENV vars: "GAS_PRIORITY_FEE" and "GAS_MAX_FEE" in gwei (like just "3")');
  }
}

async function deployContractType2(
  artifactName: string,
  constructorArgs: unknown[],
  deployer: string,
  signerOrOptions?: Signer | FactoryOptions,
): Promise<DeployedContract> {
  const txParams = await getDeployTxParams(deployer);
  const factory = (await ethers.getContractFactory(artifactName, signerOrOptions)) as ContractFactory;
  const contract = await factory.deploy(...constructorArgs, txParams);
  const tx = contract.deploymentTransaction();
  if (!tx) {
    throw new Error(`Failed to send the deployment transaction for ${artifactName}`);
  }
  log(`sent deployment tx ${tx.hash} (nonce ${tx.nonce})...`);

  const receipt = await tx.wait();
  if (receipt) {
    const gasUsed = receipt.gasUsed;
    (contract as DeployedContract).deploymentGasUsed = gasUsed;
    (contract as DeployedContract).deploymentTx = tx.hash;
    incrementGasUsed(gasUsed);
    log(`deployed at ${receipt.to} (gas used ${gasUsed})`);
    log.emptyLine();
  }
  await addContractHelperFields(contract, artifactName);

  return contract as DeployedContract;
}

export async function deployContract(
  artifactName: string,
  constructorArgs: unknown[],
  deployer: string,
  signerOrOptions?: Signer | FactoryOptions,
): Promise<DeployedContract> {
  const txParams = await getDeployTxParams(deployer);
  if (txParams.type === 2) {
    return await deployContractType2(artifactName, constructorArgs, deployer, signerOrOptions);
  } else {
    throw Error("Tx type 1 is not supported");
  }
}

export async function deployWithoutProxy(
  nameInState: Sk | null,
  artifactName: string,
  deployer: string,
  constructorArgs: ConvertibleToString[] = [],
  addressFieldName = "address",
): Promise<DeployedContract> {
  log.lineWithArguments(`Deploying ${artifactName} (without proxy) with constructor args: `, constructorArgs);

  const contract = await deployContract(artifactName, constructorArgs, deployer);

  if (nameInState) {
    updateObjectInState(nameInState, {
      contract: await getContractPath(artifactName),
      [addressFieldName]: contract.address,
      constructorArgs: constructorArgs,
    });
  }

  return contract;
}

export async function deployImplementation(
  nameInState: Sk,
  artifactName: string,
  deployer: string,
  constructorArgs: ConvertibleToString[] = [],
  signerOrOptions?: Signer | FactoryOptions,
): Promise<DeployedContract> {
  log.lineWithArguments(
    `Deploying implementation for proxy of ${artifactName} with constructor args: `,
    constructorArgs,
  );
  const contract = await deployContract(artifactName, constructorArgs, deployer, signerOrOptions);

  updateObjectInState(nameInState, {
    implementation: {
      contract: contract.contractPath,
      address: contract.address,
      constructorArgs: constructorArgs,
    },
  });
  return contract;
}

export async function deployBehindOssifiableProxy(
  nameInState: Sk | null,
  artifactName: string,
  proxyOwner: string,
  deployer: string,
  constructorArgs: ConvertibleToString[] = [],
  implementation: null | string = null,
  signerOrOptions?: Signer | FactoryOptions,
) {
  if (implementation === null) {
    log.lineWithArguments(
      `Deploying implementation for proxy of ${artifactName} with constructor args: `,
      constructorArgs,
    );
    const contract = await deployContract(artifactName, constructorArgs, deployer, signerOrOptions);
    implementation = contract.address;
  } else {
    log(`Using pre-deployed implementation of ${artifactName}: ${implementation}`);
  }

  const proxyConstructorArgs = [implementation, proxyOwner, "0x"];
  log.lineWithArguments(
    `Deploying ${PROXY_CONTRACT_NAME} for ${artifactName} with constructor args: `,
    proxyConstructorArgs,
  );
  const proxy = await deployContract(PROXY_CONTRACT_NAME, proxyConstructorArgs, deployer);

  if (nameInState) {
    updateObjectInState(nameInState, {
      proxy: {
        contract: await getContractPath(PROXY_CONTRACT_NAME),
        address: proxy.address,
        constructorArgs: proxyConstructorArgs,
      },
      implementation: {
        contract: await getContractPath(artifactName),
        address: implementation,
        constructorArgs: constructorArgs,
      },
    });
  }

  return proxy;
}

export async function updateProxyImplementation(
  nameInState: Sk,
  artifactName: string,
  proxyAddress: string,
  proxyOwner: string,
  constructorArgs: unknown[],
) {
  const implementation = await deployContract(artifactName, constructorArgs, proxyOwner);

  const proxy = await getContractAt(PROXY_CONTRACT_NAME, proxyAddress);
  await makeTx(proxy, "proxy__upgradeTo", [implementation.address], { from: proxyOwner });

  updateObjectInState(nameInState, {
    implementation: {
      contract: implementation.contractPath,
      address: implementation.address,
      constructorArgs: constructorArgs,
    },
  });
}
