import { AddressLike, BaseContract, BytesLike } from "ethers";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ACL__factory,
  Burner__MockForDistributeReward__factory,
  DAOFactory__factory,
  EIP712StETH__factory,
  EVMScriptRegistryFactory__factory,
  Kernel,
  Kernel__factory,
  Lido__DistributeRewardMock__factory,
  Lido__factory,
  LidoLocator,
} from "typechain-types";

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
  const kernelBase = await new Kernel__factory(rootAccount).deploy(true);
  const aclBase = await new ACL__factory(rootAccount).deploy();
  const EvmScriptRegistryFactory = await new EVMScriptRegistryFactory__factory(rootAccount).deploy();
  const daoFactory = await new DAOFactory__factory(rootAccount).deploy(kernelBase, aclBase, EvmScriptRegistryFactory);

  const tx = await daoFactory.newDAO(rootAccount);
  const txReceipt = await tx.wait();
  const daoAddress = findEvents(txReceipt!, "DeployDAO")[0].args[0];

  const dao = Kernel__factory.connect(daoAddress, rootAccount);
  const acl = ACL__factory.connect(await dao.acl(), rootAccount);
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

  const impl = await new Lido__factory(rootAccount).deploy();

  const lidoProxyAddress = await addAragonApp({
    dao,
    name: "lido",
    impl,
    rootAccount,
  });

  const lido = Lido__factory.connect(lidoProxyAddress, rootAccount);

  if (initialized) {
    const locator = await deployLidoLocator({ lido, ...locatorConfig }, rootAccount);
    const eip712steth = await new EIP712StETH__factory(rootAccount).deploy(lido);
    await lido.initialize(locator, eip712steth, { value: ether("1.0") });
  }

  return { lido, dao, acl };
}

export async function deployLidoDaoForNor({ rootAccount, initialized, locatorConfig = {} }: DeployLidoDaoArgs) {
  const { dao, acl } = await createAragonDao(rootAccount);

  const impl = await new Lido__DistributeRewardMock__factory(rootAccount).deploy();

  const lidoProxyAddress = await addAragonApp({
    dao,
    name: "lido",
    impl,
    rootAccount,
  });

  const lido = Lido__DistributeRewardMock__factory.connect(lidoProxyAddress, rootAccount);

  const burner = await new Burner__MockForDistributeReward__factory(rootAccount).deploy();

  if (initialized) {
    const locator = await deployLidoLocator({ lido, burner, ...locatorConfig }, rootAccount);
    const eip712steth = await new EIP712StETH__factory(rootAccount).deploy(lido);
    await lido.initialize(locator, eip712steth, { value: ether("1.0") });
  }

  return { lido, dao, acl, burner };
}

export async function hasPermission(
  dao: Kernel,
  app: BaseContract,
  role: string,
  who: AddressLike,
  how: BytesLike = "0x",
): Promise<boolean> {
  return dao.hasPermission(who, app, await app.getFunction(role)(), how);
}
