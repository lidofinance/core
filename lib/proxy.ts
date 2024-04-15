import { BaseContract, BytesLike } from "ethers";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { OssifiableProxy, OssifiableProxy__factory } from "typechain-types";

interface ProxifyArgs<T> {
  impl: T;
  admin: HardhatEthersSigner;
  caller?: HardhatEthersSigner;
  data?: BytesLike;
}

export async function proxify<T extends BaseContract>({
  impl,
  admin,
  caller = admin,
  data = new Uint8Array(),
}: ProxifyArgs<T>): Promise<[T, OssifiableProxy]> {
  const implAddres = await impl.getAddress();

  const proxy = await new OssifiableProxy__factory(admin).deploy(implAddres, admin.address, data);

  let proxied = impl.attach(await proxy.getAddress()) as T;
  proxied = proxied.connect(caller) as T;

  return [proxied, proxy];
}
