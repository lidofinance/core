import { ContractFactory, ContractTransactionReceipt, Signer } from "ethers";
import { ethers } from "hardhat";
import { FactoryOptions } from "hardhat/types";

import { LidoLocator } from "typechain-types";

import { addContractHelperFields, DeployedContract, getContractPath, loadContract, LoadedContract } from "lib/contract";
import { ConvertibleToString, cy, log, yl } from "lib/log";
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
  withStateFile = true,
): Promise<ContractTransactionReceipt> {
  log.withArguments(`Call: ${yl(contract.name)}[${cy(contract.address)}].${yl(funcName)}`, args);

  const tx = await contract.getFunction(funcName)(...args, txParams);

  const receipt = await tx.wait();
  const gasUsed = receipt.gasUsed;
  incrementGasUsed(gasUsed, withStateFile);

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
  withStateFile = true,
  signerOrOptions?: Signer | FactoryOptions,
): Promise<DeployedContract> {
  const txParams = await getDeployTxParams(deployer);
  const factory = (await ethers.getContractFactory(artifactName, signerOrOptions)) as ContractFactory;
  const contract = await factory.deploy(...constructorArgs, txParams);
  const tx = contract.deploymentTransaction();
  if (!tx) {
    throw new Error(`Failed to send the deployment transaction for ${artifactName}`);
  }

  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error(`Failed to wait till the transaction ${tx.hash} execution!`);
  }

  const gasUsed = receipt.gasUsed;
  incrementGasUsed(gasUsed, withStateFile);
  (contract as DeployedContract).deploymentGasUsed = gasUsed;
  (contract as DeployedContract).deploymentTx = tx.hash;

  await addContractHelperFields(contract, artifactName);

  return contract as DeployedContract;
}

export async function deployContract(
  artifactName: string,
  constructorArgs: unknown[],
  deployer: string,
  withStateFile = true,
  signerOrOptions?: Signer | FactoryOptions,
): Promise<DeployedContract> {
  const txParams = await getDeployTxParams(deployer);
  if (txParams.type !== 2) {
    throw new Error("Only EIP-1559 transactions (type 2) are supported");
  }

  return await deployContractType2(artifactName, constructorArgs, deployer, withStateFile, signerOrOptions);
}

export async function deployWithoutProxy(
  nameInState: Sk,
  artifactName: string,
  deployer: string,
  constructorArgs: ConvertibleToString[] = [],
  addressFieldName = "address",
  withStateFile = true,
): Promise<DeployedContract> {
  logWithConstructorArgs(`Deploying: ${yl(artifactName)} (without proxy)`, constructorArgs);

  const contract = await deployContract(artifactName, constructorArgs, deployer, withStateFile);

  if (withStateFile) {
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
  signerOrOptions?: Signer | FactoryOptions,
  withStateFile = true,
): Promise<DeployedContract> {
  logWithConstructorArgs(`Deploying implementation: ${yl(artifactName)}`, constructorArgs);

  const contract = await deployContract(artifactName, constructorArgs, deployer, withStateFile, signerOrOptions);

  if (withStateFile) {
    updateObjectInState(nameInState, {
      implementation: {
        contract: contract.contractPath,
        address: contract.address,
        constructorArgs: constructorArgs,
      },
    });
  }

  return contract;
}

export async function deployBehindOssifiableProxy(
  nameInState: Sk,
  artifactName: string,
  proxyOwner: string,
  deployer: string,
  constructorArgs: ConvertibleToString[] = [],
  implementation: null | string = null,
  withStateFile = true,
  signerOrOptions?: Signer | FactoryOptions,
) {
  if (implementation !== null) {
    log(`Using pre-deployed implementation of ${yl(artifactName)}: ${cy(implementation)}`);
  } else {
    logWithConstructorArgs(`Deploying implementation: ${yl(artifactName)} (with proxy)`, constructorArgs);
    const contract = await deployContract(artifactName, constructorArgs, deployer, withStateFile, signerOrOptions);
    implementation = contract.address;
  }

  const proxyConstructorArgs = [implementation, proxyOwner, "0x"];
  log.withArguments(
    `Deploying ${yl(PROXY_CONTRACT_NAME)} for ${yl(artifactName)} with constructor args `,
    proxyConstructorArgs,
  );

  const proxy = await deployContract(PROXY_CONTRACT_NAME, proxyConstructorArgs, deployer, withStateFile);

  if (withStateFile) {
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
  withStateFile = true,
) {
  logWithConstructorArgs(
    `Upgrading proxy ${cy(proxyAddress)} to new implementation: ${yl(artifactName)}`,
    constructorArgs as ConvertibleToString[],
  );

  const implementation = await deployContract(artifactName, constructorArgs, proxyOwner, withStateFile);

  const proxy = await loadContract(PROXY_CONTRACT_NAME, proxyAddress);
  await makeTx(proxy, "proxy__upgradeTo", [implementation.address], { from: proxyOwner });

  if (withStateFile) {
    updateObjectInState(nameInState, {
      implementation: {
        contract: implementation.contractPath,
        address: implementation.address,
        constructorArgs: constructorArgs,
      },
    });
  }
}

async function getLocatorConfig(locatorAddress: string) {
  const locator = await ethers.getContractAt("LidoLocator", locatorAddress);

  const addresses = [
    "accountingOracle",
    "depositSecurityModule",
    "elRewardsVault",
    "legacyOracle",
    "lido",
    "oracleReportSanityChecker",
    "postTokenRebaseReceiver",
    "burner",
    "stakingRouter",
    "treasury",
    "validatorsExitBusOracle",
    "withdrawalQueue",
    "withdrawalVault",
    "oracleDaemonConfig",
    "clProofVerifier",
  ] as (keyof LidoLocator.ConfigStruct)[];

  const configPromises = addresses.map((name) => locator[name]());

  const config = await Promise.all(configPromises);

  return Object.fromEntries(addresses.map((n, i) => [n, config[i]])) as LidoLocator.ConfigStruct;
}

export async function deployLidoLocatorImplementation(
  locatorAddress: string,
  configUpdate = {},
  proxyOwner: string,
  withStateFile = true,
) {
  const config = await getLocatorConfig(locatorAddress);
  const updated = { ...config, ...configUpdate };

  await updateProxyImplementation(Sk.lidoLocator, "LidoLocator", locatorAddress, proxyOwner, [updated], withStateFile);
}
