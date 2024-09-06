import { ContractFactory, ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import {
  addContractHelperFields,
  DeployedContract,
  getContractAt,
  getContractPath,
  LoadedContract,
} from "lib/contract";
import { ConvertibleToString, cy, gr, log, yl } from "lib/log";
import { incrementGasUsed, Sk, updateObjectInState } from "lib/state-file";

const GAS_PRIORITY_FEE = process.env.GAS_PRIORITY_FEE || null;
const GAS_MAX_FEE = process.env.GAS_MAX_FEE || null;

const PROXY_CONTRACT_NAME = "OssifiableProxy";

type TxParams = {
  from: string;
  value?: bigint | string;
};

function logWithConstructorArgs(message: string, constructorArgs: ConvertibleToString[] = []) {
  if (constructorArgs.length > 0) {
    log.withArguments(`${message} with constructor args `, constructorArgs);
  } else {
    log(message);
  }
}

export async function makeTx(
  contract: LoadedContract,
  funcName: string,
  args: ConvertibleToString[],
  txParams: TxParams,
): Promise<ContractTransactionReceipt> {
  log.withArguments(`Call: ${yl(contract.name)}[${cy(contract.address)}].${yl(funcName)}`, args);

  const tx = await contract.getFunction(funcName)(...args, txParams);
  log(` Transaction: ${tx.hash} (nonce ${yl(tx.nonce)})...`);

  const receipt = await tx.wait();
  const gasUsed = receipt.gasUsed;
  incrementGasUsed(gasUsed);

  log(` Executed (gas used: ${yl(gasUsed)})`);
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
): Promise<DeployedContract> {
  const txParams = await getDeployTxParams(deployer);
  const factory = (await ethers.getContractFactory(artifactName)) as ContractFactory;
  const contract = await factory.deploy(...constructorArgs, txParams);
  const tx = contract.deploymentTransaction();
  if (!tx) {
    throw new Error(`Failed to send the deployment transaction for ${artifactName}`);
  }

  log(` Transaction: ${tx.hash} (nonce ${yl(tx.nonce)})`);

  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error(`Failed to wait till the transaction ${tx.hash} execution!`);
  }

  const gasUsed = receipt.gasUsed;
  incrementGasUsed(gasUsed);
  (contract as DeployedContract).deploymentGasUsed = gasUsed;
  (contract as DeployedContract).deploymentTx = tx.hash;

  log(` Deployed: ${gr(receipt.contractAddress!)} (gas used: ${yl(gasUsed)})`);
  log.emptyLine();

  await addContractHelperFields(contract, artifactName);

  return contract as DeployedContract;
}

export async function deployContract(
  artifactName: string,
  constructorArgs: unknown[],
  deployer: string,
): Promise<DeployedContract> {
  const txParams = await getDeployTxParams(deployer);
  if (txParams.type !== 2) {
    throw new Error("Only EIP-1559 transactions (type 2) are supported");
  }

  return await deployContractType2(artifactName, constructorArgs, deployer);
}

export async function deployWithoutProxy(
  nameInState: Sk | null,
  artifactName: string,
  deployer: string,
  constructorArgs: ConvertibleToString[] = [],
  addressFieldName = "address",
): Promise<DeployedContract> {
  logWithConstructorArgs(`Deploying: ${yl(artifactName)} (without proxy)`, constructorArgs);

  const contract = await deployContract(artifactName, constructorArgs, deployer);

  if (nameInState) {
    const contractPath = await getContractPath(artifactName);
    updateObjectInState(nameInState, {
      contract: contractPath,
      [addressFieldName]: contract.address,
      constructorArgs,
    });
  }

  return contract;
}

export async function deployImplementation(
  nameInState: Sk,
  artifactName: string,
  deployer: string,
  constructorArgs: ConvertibleToString[] = [],
): Promise<DeployedContract> {
  logWithConstructorArgs(`Deploying implementation: ${yl(artifactName)}`, constructorArgs);

  const contract = await deployContract(artifactName, constructorArgs, deployer);

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
) {
  if (implementation !== null) {
    log(`Using pre-deployed implementation of ${yl(artifactName)}: ${cy(implementation)}`);
  } else {
    logWithConstructorArgs(`Deploying implementation: ${yl(artifactName)} (with proxy)`, constructorArgs);
    const contract = await deployContract(artifactName, constructorArgs, deployer);
    implementation = contract.address;
  }

  const proxyConstructorArgs = [implementation, proxyOwner, "0x"];
  log.withArguments(
    `Deploying ${yl(PROXY_CONTRACT_NAME)} for ${yl(artifactName)} with constructor args `,
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
  logWithConstructorArgs(
    `Upgrading proxy ${cy(proxyAddress)} to new implementation: ${yl(artifactName)}`,
    constructorArgs as ConvertibleToString[],
  );

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
