import { BaseContract } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Kernel, LidoLocator } from "typechain-types";

import { ether, findEvents, streccak } from "lib";

import { deployLidoLocator } from "./locator";

interface CreateAddAppArgs {
  dao: Kernel;
  name: string;
  impl: BaseContract;
  rootAccount: HardhatEthersSigner;
}

interface DeployLidoDaoArgs {
  rootAccount: HardhatEthersSigner;
  initialized: boolean;
  locatorConfig?: Partial<LidoLocator.ConfigStruct>;
}

async function createAragonDao(rootAccount: HardhatEthersSigner) {
  const kernelBase = await ethers.deployContract("Kernel", [true], rootAccount);
  const aclBase = await ethers.deployContract("ACL", rootAccount);
  const evmScriptRegistryFactory = await ethers.deployContract("EVMScriptRegistryFactory", rootAccount);
  const daoFactory = await ethers.deployContract(
    "DAOFactory",
    [kernelBase, aclBase, evmScriptRegistryFactory],
    rootAccount,
  );

  const tx = await daoFactory.newDAO(rootAccount);
  const txReceipt = await tx.wait();
  const daoAddress = findEvents(txReceipt!, "DeployDAO")[0].args[0];

  const dao = await ethers.getContractAt("Kernel", daoAddress, rootAccount);
  const acl = await ethers.getContractAt("ACL", await dao.acl(), rootAccount);
  const APP_MANAGER_ROLE = await kernelBase.APP_MANAGER_ROLE();
  await acl.createPermission(rootAccount, await dao.getAddress(), APP_MANAGER_ROLE, rootAccount);

  return { dao, acl };
}

export async function addAragonApp({ dao, name, impl, rootAccount }: CreateAddAppArgs): Promise<string> {
  const tx = await dao["newAppInstance(bytes32,address,bytes,bool)"](
    streccak(`${name}.aragonpm.test`),
    await impl.getAddress(),
    "0x",
    false,
    { from: rootAccount },
  );

  const receipt = await tx.wait();

  return findEvents(receipt!, "NewAppProxy")[0].args[0];
}

// TODO: extract initialization from this function
export async function deployLidoDao({ rootAccount, initialized, locatorConfig = {} }: DeployLidoDaoArgs) {
  const { dao, acl } = await createAragonDao(rootAccount);

  const impl = await ethers.deployContract("Lido", rootAccount);

  const lidoProxyAddress = await addAragonApp({
    dao,
    name: "lido",
    impl,
    rootAccount,
  });

  const lido = await ethers.getContractAt("Lido", lidoProxyAddress, rootAccount);

  if (initialized) {
    const locator = await deployLidoLocator({ lido, ...locatorConfig }, rootAccount);
    const eip712steth = await ethers.deployContract("EIP712StETH", [lido], rootAccount);
    await lido.initialize(locator, eip712steth, { value: ether("1.0") });
  }

  return { lido, dao, acl };
}
