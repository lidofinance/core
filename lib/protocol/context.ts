import { ContractTransactionReceipt, Interface } from "ethers";
import hre from "hardhat";

import { deployScratchProtocol, deployUpgrade, ether, findEventsWithInterfaces, impersonate, log } from "lib";

import { discover } from "./discover";
import { provision } from "./provision";
import { ProtocolContext, ProtocolContextFlags, ProtocolSigners, Signer } from "./types";

const getSigner = async (signer: Signer, balance = ether("100"), signers: ProtocolSigners) => {
  const signerAddress = signers[signer] ?? signer;
  return impersonate(signerAddress, balance);
};

export const withCSM = () => {
  return process.env.INTEGRATION_WITH_CSM !== "off";
};

export const getProtocolContext = async (): Promise<ProtocolContext> => {
  if (hre.network.name === "hardhat") {
    const networkConfig = hre.config.networks[hre.network.name];
    if (!networkConfig.forking?.enabled) {
      await deployScratchProtocol(hre.network.name);
    }
  } else {
    await deployUpgrade(hre.network.name);
  }

  const { contracts, signers } = await discover();
  const interfaces = Object.values(contracts).map((contract) => contract.interface);

  // By default, all flags are "on"
  const flags = {
    withCSM: withCSM(),
  } as ProtocolContextFlags;

  log.debug("Protocol context flags", {
    "With CSM": flags.withCSM,
  });

  const context = {
    contracts,
    signers,
    interfaces,
    flags,
    isScratch: true, // NB: gonna be updated upon merge of upgrade PR
    getSigner: async (signer: Signer, balance?: bigint) => getSigner(signer, balance, signers),
    getEvents: (receipt: ContractTransactionReceipt, eventName: string, extraInterfaces: Interface[] = []) =>
      findEventsWithInterfaces(receipt, eventName, [...interfaces, ...extraInterfaces]),
  } as ProtocolContext;

  await provision(context);

  return context;
};
