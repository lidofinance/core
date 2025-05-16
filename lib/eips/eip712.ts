import { Addressable, Signature, Signer, TypedDataDomain } from "ethers";
import { network } from "hardhat";

export interface Permit {
  owner: string;
  spender: string;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}

export async function stethDomain(verifyingContract: Addressable): Promise<TypedDataDomain> {
  return {
    name: "Liquid staked Ether 2.0",
    version: "2",
    chainId: network.config.chainId!,
    verifyingContract: await verifyingContract.getAddress(),
  };
}

export async function signPermit(domain: TypedDataDomain, permit: Permit, signer: Signer): Promise<Signature> {
  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  return signer.signTypedData(domain, types, permit).then((signature) => Signature.from(signature));
}
