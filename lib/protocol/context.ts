import { ContractTransactionReceipt, Interface } from "ethers";
import hre from "hardhat";
import { getMode } from "hardhat.helpers";

import { deployScratchProtocol, deployUpgrade, ether, findEventsWithInterfaces, impersonate, log, toBool } from "lib";

import { discover } from "./discover";
import { MAINNET_LOCATOR_ADDRESS } from "./mainnet";
import { provision } from "./provision";
import { ProtocolContext, ProtocolContextFlags, ProtocolSigners, Signer } from "./types";

const getSigner = async (signer: Signer, balance = ether("100"), signers: ProtocolSigners) => {
  const signerAddress = signers[signer] ?? signer;
  return impersonate(signerAddress, balance);
};

export const withCSM = () => {
  return process.env.INTEGRATION_WITH_CSM !== "off";
};

export const withCMv2 = () => {
  return process.env.INTEGRATION_WITH_CMv2 !== "off";
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

export const ensureCuratedModuleShares = async (ctx: ProtocolContext) => {
  const { stakingRouter } = ctx.contracts;
  const moduleId = 1n;
  const targetShare = 10_000n;
  const module = await stakingRouter.getStakingModule(moduleId);

  if (module.stakeShareLimit === targetShare && module.priorityExitShareThreshold === targetShare) return;

  const agent = await ctx.getSigner("agent");
  const role = await stakingRouter.STAKING_MODULE_SHARE_MANAGE_ROLE();
  if (!(await stakingRouter.hasRole(role, agent.address))) {
    await stakingRouter.connect(agent).grantRole(role, agent.address);
  }

  await stakingRouter.connect(agent).updateModuleShares(moduleId, targetShare, targetShare);
  log.debug("Updated curated module shares", {
    moduleId: moduleId.toString(),
    stakeShareLimit: targetShare.toString(),
    priorityExitShareThreshold: targetShare.toString(),
  });
};

export const getProtocolContext = async (skipV3Contracts: boolean = false): Promise<ProtocolContext> => {
  const isScratch = getMode() === "scratch";

  if (isScratch) {
    await deployScratchProtocol();
  } else if (toBool(process.env.UPGRADE)) {
    await deployUpgrade(hre.network.name, process.env.STEPS_FILE!);
  }

  const { contracts, signers, modules } = await discover(skipV3Contracts);
  const interfaces = Object.values(contracts).map((contract) => contract.interface);

  // By default, all flags are "on"
  const flags = {
    withCSM: withCSM(),
    withCMv2: withCMv2(),
  } as ProtocolContextFlags;

  log.debug("Protocol context flags", {
    "With CSM": flags.withCSM,
    "With CMv2": flags.withCMv2,
  });

  const context = {
    contracts,
    modules,
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
    await ensureCuratedModuleShares(context);
    await ensureVaultsShareLimit(context);
  }

  return context;
};
