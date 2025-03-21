import { ContractTransactionReceipt, Interface } from "ethers";
import hre from "hardhat";
import { getMode } from "hardhat.helpers";

import { deployScratchProtocol, deployUpgrade, ether, findEventsWithInterfaces, impersonate, log } from "lib";

import { discover } from "./discover";
import { provision } from "./provision";
import { ProtocolContext, ProtocolContextFlags, ProtocolSigners, Signer } from "./types";

const getSigner = async (signer: Signer, balance = ether("100"), signers: ProtocolSigners) => {
  const signerAddress = signers[signer] ?? signer;
  return impersonate(signerAddress, balance);
};

export const getProtocolContext = async (): Promise<ProtocolContext> => {
  const isScratch = getMode() === "scratch";

  if (isScratch) {
    await deployScratchProtocol(hre.network.name);
  } else if (process.env.UPGRADE) {
    await deployUpgrade(hre.network.name);
  }

  const { contracts, signers } = await discover();
  const interfaces = Object.values(contracts).map((contract) => contract.interface);

  // By default, all flags are "on"
  const flags = {
    withCSM: process.env.INTEGRATION_WITH_CSM !== "off",
  } as ProtocolContextFlags;

  log.debug("Protocol context flags", {
    "With CSM": flags.withCSM,
  });

  const context = {
    contracts,
    signers,
    interfaces,
    flags,
    isScratch,
    getSigner: async (signer: Signer, balance?: bigint) => getSigner(signer, balance, signers),
    getEvents: (receipt: ContractTransactionReceipt, eventName: string, extraInterfaces: Interface[] = []) =>
      findEventsWithInterfaces(receipt, eventName, [...interfaces, ...extraInterfaces]),
  } as ProtocolContext;

  if (isScratch) {
    await provision(context);
  }

  return context;
};
