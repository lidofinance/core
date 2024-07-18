import { ether, impersonate } from "lib";

import { discover } from "./discovery";
import { ProtocolContext, ProtocolSigners, Signer } from "./types";

const getSigner = async (signer: Signer, balance = ether("100"), signers: ProtocolSigners) => {
  const signerAddress = signers[signer] ?? signer;
  return impersonate(signerAddress, balance);
};

export const getProtocolContext = async (): Promise<ProtocolContext> => {
  const { contracts, signers } = await discover();

  return {
    contracts,
    signers,
    interfaces: Object.entries(contracts).map(([, contract]) => contract.interface),
    getSigner: async (signer: Signer, balance?: bigint) => getSigner(signer, balance, signers),
  };
};
