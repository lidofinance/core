import { ether, log, trace } from "lib";

import { ProtocolContext } from "../types";

/**
 * Unpauses the staking contract.
 */
export const unpauseStaking = async (ctx: ProtocolContext) => {
  const { lido } = ctx.contracts;
  if (await lido.isStakingPaused()) {
    log.warning("Unpausing staking contract");

    const votingSigner = await ctx.getSigner("voting");
    const tx = await lido.connect(votingSigner).resume();
    await trace("lido.resume", tx);

    log.success("Staking contract unpaused");
  }
};

export const ensureStakeLimit = async (ctx: ProtocolContext) => {
  const { lido } = ctx.contracts;

  const stakeLimitInfo = await lido.getStakeLimitFullInfo();
  if (!stakeLimitInfo.isStakingLimitSet) {
    log.warning("Setting staking limit");

    const maxStakeLimit = ether("150000");
    const stakeLimitIncreasePerBlock = ether("20"); // this is an arbitrary value

    const votingSigner = await ctx.getSigner("voting");
    const tx = await lido.connect(votingSigner).setStakingLimit(maxStakeLimit, stakeLimitIncreasePerBlock);
    await trace("lido.setStakingLimit", tx);

    log.success("Staking limit set");
  }
};
