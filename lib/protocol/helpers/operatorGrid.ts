import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard } from "typechain-types";
import { TierParamsStruct } from "typechain-types/contracts/0.8.25/vaults/OperatorGrid";

import { ether } from "lib/units";

import { ProtocolContext } from "../types";

export const DEFAULT_TIER_PARAMS: TierParamsStruct = {
  shareLimit: ether("1000"),
  reserveRatioBP: 20_00n,
  forcedRebalanceThresholdBP: 18_00n,
  infraFeeBP: 1_00n,
  liquidityFeeBP: 7_00n,
  reservationFeeBP: 0n,
};

export async function upDefaultTierShareLimit(ctx: ProtocolContext, increaseBy: bigint) {
  const { operatorGrid } = ctx.contracts;
  const agentSigner = await ctx.getSigner("agent");
  await grantRegistryRoleIfNotGranted(ctx, agentSigner);

  const existingTierParams = await operatorGrid.tier(await operatorGrid.DEFAULT_TIER_ID());

  await operatorGrid.connect(agentSigner).alterTiers(
    [await operatorGrid.DEFAULT_TIER_ID()],
    [
      {
        shareLimit: existingTierParams.shareLimit + increaseBy,
        reserveRatioBP: existingTierParams.reserveRatioBP,
        forcedRebalanceThresholdBP: existingTierParams.forcedRebalanceThresholdBP,
        infraFeeBP: existingTierParams.infraFeeBP,
        liquidityFeeBP: existingTierParams.liquidityFeeBP,
        reservationFeeBP: existingTierParams.reservationFeeBP,
      },
    ],
  );
}

export async function resetDefaultTierShareLimit(ctx: ProtocolContext) {
  const { operatorGrid } = ctx.contracts;
  const agentSigner = await ctx.getSigner("agent");
  await grantRegistryRoleIfNotGranted(ctx, agentSigner);

  await operatorGrid
    .connect(agentSigner)
    .alterTiers([await operatorGrid.DEFAULT_TIER_ID()], [{ ...DEFAULT_TIER_PARAMS, shareLimit: 0n }]);
}

export async function grantRegistryRoleIfNotGranted(ctx: ProtocolContext, signer: HardhatEthersSigner) {
  const { operatorGrid } = ctx.contracts;
  const agentSigner = await ctx.getSigner("agent");

  const role = await operatorGrid.REGISTRY_ROLE();
  const hasRole = await operatorGrid.hasRole(role, signer);

  if (!hasRole) {
    await operatorGrid.connect(agentSigner).grantRole(role, signer);
  }
}

export async function registerNOGroup(
  ctx: ProtocolContext,
  nodeOperator: HardhatEthersSigner,
  noShareLimit: bigint,
  tiers: TierParamsStruct[] = [DEFAULT_TIER_PARAMS],
) {
  const { operatorGrid } = ctx.contracts;

  const agentSigner = await ctx.getSigner("agent");

  await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, noShareLimit);
  await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, tiers);
}

export async function setUpOperatorGrid(
  ctx: ProtocolContext,
  nodeOperators: HardhatEthersSigner[],
  params: {
    noShareLimit: bigint;
    tiers: TierParamsStruct[];
  }[] = [],
  defaultTierParams: TierParamsStruct = DEFAULT_TIER_PARAMS,
) {
  const { operatorGrid } = ctx.contracts;
  const agentSigner = await ctx.getSigner("agent");
  await grantRegistryRoleIfNotGranted(ctx, agentSigner);

  await operatorGrid.connect(agentSigner).alterTiers([await operatorGrid.DEFAULT_TIER_ID()], [defaultTierParams]);

  for (const [i, nodeOperator] of nodeOperators.entries()) {
    await registerNOGroup(
      ctx,
      nodeOperator,
      params[i]?.noShareLimit ?? ether("1000"),
      params[i]?.tiers ?? [defaultTierParams],
    );
  }
}

export async function changeTier(
  ctx: ProtocolContext,
  dashboard: Dashboard,
  owner: HardhatEthersSigner,
  nodeOperator: HardhatEthersSigner,
): Promise<bigint> {
  const { operatorGrid } = ctx.contracts;

  const group = await operatorGrid.group(nodeOperator);
  if (group.tierIds.length === 0) {
    throw new Error("No tier found for node operator");
  }

  const stakingVault = await dashboard.stakingVault();

  await dashboard.connect(owner).changeTier(group.tierIds[0], group.shareLimit);
  await operatorGrid.connect(nodeOperator).changeTier(stakingVault, group.tierIds[0], group.shareLimit);

  return group.tierIds[0];
}
