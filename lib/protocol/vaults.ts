import { StakingVault } from "typechain-types";

import { impersonate } from "lib";

import { ether } from "../units";

import { ProtocolContext } from "./types";

export async function setupLido(ctx: ProtocolContext) {
  const { lido } = ctx.contracts;
  const votingSigner = await ctx.getSigner("voting");

  await lido.connect(votingSigner).setMaxExternalRatioBP(20_00n);
}

export async function disconnectFromHub(ctx: ProtocolContext, stakingVault: StakingVault) {
  const agentSigner = await ctx.getSigner("agent");

  const { vaultHub } = ctx.contracts;

  await vaultHub.connect(agentSigner).disconnect(stakingVault);
}

export async function connectToHub(
  ctx: ProtocolContext,
  stakingVault: StakingVault,
  {
    reserveRatio,
    rebalanceThreshold,
    treasuryFeeBP,
    shareLimit,
  }: { reserveRatio: bigint; rebalanceThreshold: bigint; treasuryFeeBP: bigint; shareLimit: bigint },
) {
  const { vaultHub } = ctx.contracts;
  const agentSigner = await ctx.getSigner("agent");

  await vaultHub
    .connect(agentSigner)
    .connectVault(stakingVault, shareLimit, reserveRatio, rebalanceThreshold, treasuryFeeBP);
}

export async function generateFeesToClaim(ctx: ProtocolContext, stakingVault: StakingVault) {
  const { vaultHub } = ctx.contracts;
  const hubSigner = await impersonate(await vaultHub.getAddress(), ether("100"));
  const rewards = ether("1");
  await stakingVault.connect(hubSigner).report(rewards, 0n, 0n);
}
