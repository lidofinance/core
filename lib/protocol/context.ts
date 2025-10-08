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

export const withCSM = () => {
  return process.env.INTEGRATION_WITH_CSM !== "off";
};

export const ensureVaultsShareLimit = async (ctx: ProtocolContext) => {
  const { operatorGrid } = ctx.contracts;

  const agent = await ctx.getSigner("agent");

  const defaultTierId = await operatorGrid.DEFAULT_TIER_ID();

  const defaultTierParams = await operatorGrid.tier(defaultTierId);

  if (defaultTierParams.shareLimit === 0n) {
    await operatorGrid.connect(agent).alterTiers(
      [defaultTierId],
      [
        {
          shareLimit: ether("250"),
          reserveRatioBP: defaultTierParams.reserveRatioBP,
          forcedRebalanceThresholdBP: defaultTierParams.forcedRebalanceThresholdBP,
          infraFeeBP: defaultTierParams.infraFeeBP,
          liquidityFeeBP: defaultTierParams.liquidityFeeBP,
          reservationFeeBP: defaultTierParams.reservationFeeBP,
        },
      ],
    );
  }
};

export const getProtocolContext = async (skipV3Contracts: boolean = false): Promise<ProtocolContext> => {
  const isScratch = getMode() === "scratch";

  if (isScratch) {
    await deployScratchProtocol();
  } else if (process.env.UPGRADE) {
    await deployUpgrade(hre.network.name, process.env.STEPS_FILE!);
  }

  const { contracts, signers } = await discover(skipV3Contracts);
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
    isScratch,
    getSigner: async (signer: Signer, balance?: bigint) => getSigner(signer, balance, signers),
    getEvents: (receipt: ContractTransactionReceipt, eventName: string, extraInterfaces: Interface[] = []) =>
      findEventsWithInterfaces(receipt, eventName, [...interfaces, ...extraInterfaces]),
  } as ProtocolContext;

  if (isScratch) {
    await provision(context);
  } else if (process.env.UPGRADE) {
    await ensureVaultsShareLimit(context);
  }

  return context;
};
