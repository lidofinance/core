import { ProtocolContext } from "../types";

/**
 * Unpauses the staking contract.
 */
export const unpauseStaking = async (ctx: ProtocolContext) => {
  const { lido } = ctx.contracts;
  if (await lido.isStakingPaused()) {
    const votingSigner = await ctx.getSigner("voting");
    await lido.connect(votingSigner).resume();
  }
};
