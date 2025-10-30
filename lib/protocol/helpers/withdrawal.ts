import { ZeroAddress } from "ethers";

import { advanceChainTime, certainAddress, ether, impersonate, log } from "lib";
import { LIMITER_PRECISION_BASE } from "lib/constants";

import { ProtocolContext } from "../types";

import { report } from "./accounting";
import { setMaxPositiveTokenRebase } from "./sanity-checker";
import { removeStakingLimit, setStakingLimit } from "./staking";

/**
 * Unpauses the withdrawal queue contract.
 */
export const unpauseWithdrawalQueue = async (ctx: ProtocolContext) => {
  const { withdrawalQueue } = ctx.contracts;
  if (await withdrawalQueue.isPaused()) {
    const resumeRole = await withdrawalQueue.RESUME_ROLE();
    const agentSigner = await ctx.getSigner("agent");
    const agentSignerAddress = await agentSigner.getAddress();

    await withdrawalQueue.connect(agentSigner).grantRole(resumeRole, agentSignerAddress);
    await withdrawalQueue.connect(agentSigner).resume();
    await withdrawalQueue.connect(agentSigner).revokeRole(resumeRole, agentSignerAddress);

    log.success("Unpaused withdrawal queue contract");
  }
};

export const finalizeWQViaElVault = async (ctx: ProtocolContext) => {
  const { withdrawalQueue, locator } = ctx.contracts;
  const ethHolder = await impersonate(certainAddress("withdrawalQueue:eth:whale"), ether("100000000"));
  const elRewardsVaultAddress = await locator.elRewardsVault();

  const initialMaxPositiveTokenRebase = await setMaxPositiveTokenRebase(ctx, LIMITER_PRECISION_BASE);

  const ethToSubmit = ether("10000"); // don't calculate required eth from withdrawal queue to accelerate tests

  const lastRequestId = await withdrawalQueue.getLastRequestId();
  while (lastRequestId != (await withdrawalQueue.getLastFinalizedRequestId())) {
    await ethHolder.sendTransaction({
      to: elRewardsVaultAddress,
      value: ethToSubmit,
    });
    await report(ctx, { clDiff: 0n, reportElVault: true });
  }
  await setMaxPositiveTokenRebase(ctx, initialMaxPositiveTokenRebase);
  await report(ctx, { clDiff: 0n, reportElVault: true });
};

export const finalizeWQViaSubmit = async (ctx: ProtocolContext) => {
  const { withdrawalQueue, lido } = ctx.contracts;
  const ethHolder = await impersonate(certainAddress("withdrawalQueue:eth:whale"), ether("1000000000"));

  const ethToSubmit = ether("10000"); // don't calculate required eth from withdrawal queue to accelerate tests

  const stakeLimitInfo = await lido.getStakeLimitFullInfo();
  await removeStakingLimit(ctx);

  const lastRequestId = await withdrawalQueue.getLastRequestId();
  while (lastRequestId != (await withdrawalQueue.getLastFinalizedRequestId())) {
    await report(ctx, { clDiff: 0n, reportElVault: false });
    try {
      await lido.connect(ethHolder).submit(ZeroAddress, { value: ethToSubmit });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg.includes("STAKE_LIMIT")) {
        await advanceChainTime(2n * 24n * 60n * 60n);
        continue;
      }
      throw e;
    }
  }

  await setStakingLimit(
    ctx,
    stakeLimitInfo.maxStakeLimit,
    stakeLimitInfo.maxStakeLimit / stakeLimitInfo.maxStakeLimitGrowthBlocks,
  );
};
