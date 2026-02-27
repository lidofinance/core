import { ContractTransactionReceipt, Interface } from "ethers";

import { getMode } from "../../hardhat.helpers.js";
import { impersonate } from "../account.js";
import { findEventsWithInterfaces } from "../event.js";
import { networkName } from "../hardhat.js";
import { log } from "../log.js";
import { deployScratchProtocol, deployUpgrade } from "../scratch.js";
import { ether } from "../units.js";

import { discover } from "./discover.js";
import { MAINNET_LOCATOR_ADDRESS } from "./mainnet.js";
import { provision } from "./provision.js";
import { type ProtocolContext, type ProtocolContextFlags, type ProtocolSigners, type Signer } from "./types.js";

const getSigner = async (signer: Signer, balance = ether("100"), signers: ProtocolSigners) => {
  const signerAddress = signers[signer] ?? signer;
  return impersonate(signerAddress, balance);
};

export const withCSM = () => {
  return process.env.INTEGRATION_WITH_CSM !== "off";
};

export const ensureVaultsShareLimit = async (ctx: ProtocolContext) => {
  const { operatorGrid } = ctx.contracts;
  if (!operatorGrid) return;

  const agent = await ctx.getSigner("agent");

  // Grant REGISTRY_ROLE to agent if not granted (needed for alterTiers)
  const registryRole = await operatorGrid.REGISTRY_ROLE();
  const hasRegistryRole = await operatorGrid.hasRole(registryRole, agent);
  if (!hasRegistryRole) {
    await operatorGrid.connect(agent).grantRole(registryRole, agent);
  }

  const defaultTierId = await operatorGrid.DEFAULT_TIER_ID();

  const defaultTierParams = await operatorGrid.tier(defaultTierId);

  if (defaultTierParams.shareLimit === 0n || defaultTierParams.reserveRatioBP !== 50_00n) {
    await operatorGrid.connect(agent).alterTiers(
      [defaultTierId],
      [
        {
          shareLimit: ether("250"),
          reserveRatioBP: 50_00n,
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
    await deployUpgrade(networkName, process.env.STEPS_FILE!);
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
    isMainnet: contracts.locator.address.toLowerCase() === MAINNET_LOCATOR_ADDRESS.toLowerCase(),
    getSigner: async (signer: Signer, balance?: bigint) => getSigner(signer, balance, signers),
    getEvents: (receipt: ContractTransactionReceipt, eventName: string, extraInterfaces: Interface[] = []) =>
      findEventsWithInterfaces(receipt, eventName, [...interfaces, ...extraInterfaces]),
  } as ProtocolContext;

  if (isScratch) {
    await provision(context);
  } else {
    await ensureVaultsShareLimit(context);
  }

  return context;
};
