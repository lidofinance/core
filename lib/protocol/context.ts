import { ContractTransactionReceipt, Interface } from "ethers";
import hre from "hardhat";
import { getMode } from "hardhat.helpers";

import { deployScratchProtocol, deployUpgrade, ether, findEventsWithInterfaces, impersonate, log } from "lib";

import { discover } from "./discover";
import { MAINNET_LOCATOR_ADDRESS } from "./mainnet";
import { provision } from "./provision";
import { SEPOLIA_CHAIN_ID } from "./sepolia";
import { ProtocolContext, ProtocolContextFlags, ProtocolSigners, Signer } from "./types";

const getSigner = async (signer: Signer, balance = ether("100"), signers: ProtocolSigners) => {
  const signerAddress = signers[signer] ?? signer;
  return impersonate(signerAddress, balance);
};

export const withCSM = () => {
  return process.env.INTEGRATION_WITH_CSM !== "off";
};

// Opt-in (default off): when forking a local scratch deploy, run the same
// provisioning a MODE=scratch run does so the fork is fully operational. Set by
// dao-local-deploy.sh / dao-sepolia-fork-deploy.sh; leave unset for real
// testnet forks, which are already operational.
const PROVISION_ON_FORK_VALUES = new Set(["1", "true", "yes", "on"]);
const provisionOnFork = () => PROVISION_ON_FORK_VALUES.has((process.env.PROVISION_ON_FORK ?? "").trim().toLowerCase());

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
  // Two distinct concerns, deliberately separated:
  //  - deployFromScratch: re-deploy the whole protocol in-process now (MODE=scratch).
  //  - isScratch: the protocol under test is a *scratch* deployment — agent still
  //    holds the powers, there is no EasyTrack. Tests branch on this to pick the
  //    privileged signer (agent vs easyTrack). Forking a scratch deploy
  //    (PROVISION_ON_FORK) discovers it rather than redeploying, but it is still
  //    semantically scratch, so isScratch must be true there too — otherwise
  //    tests take the real-testnet EasyTrack path and hit APP_AUTH_FAILED.
  const deployFromScratch = getMode() === "scratch";
  const isScratch = deployFromScratch || provisionOnFork();

  if (deployFromScratch) {
    await deployScratchProtocol();
  } else if (process.env.UPGRADE) {
    await deployUpgrade(hre.network.name, process.env.STEPS_FILE!);
  }

  const { contracts, signers } = await discover(skipV3Contracts);
  const interfaces = Object.values(contracts).map((contract) => contract.interface);

  const { chainId } = await hre.ethers.provider.getNetwork();

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
    // see the comment on this field in ProtocolContext (lib/protocol/types.ts)
    supportsVariableDepositAmounts: chainId !== BigInt(SEPOLIA_CHAIN_ID),
    getSigner: async (signer: Signer, balance?: bigint) => getSigner(signer, balance, signers),
    getEvents: (receipt: ContractTransactionReceipt, eventName: string, extraInterfaces: Interface[] = []) =>
      findEventsWithInterfaces(receipt, eventName, [...interfaces, ...extraInterfaces]),
  } as ProtocolContext;

  if (isScratch) {
    // A scratch deploy is deployed-but-not-operational, so provision it: oracle
    // committee, hash-consensus initial epoch, unpause, seed TVL. This covers
    // both a fresh in-process scratch deploy (MODE=scratch) and forking a local
    // scratch deploy (PROVISION_ON_FORK) — the latter runs the same setup on the
    // robust in-process fork instead of mutating the external anvil. Real
    // testnet forks are already operational and only top up the share limit.
    await provision(context);
  } else {
    await ensureVaultsShareLimit(context);
  }

  return context;
};
