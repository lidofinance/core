import { ZeroAddress } from "ethers";

import { certainAddress, ether, impersonate, log } from "lib";
import { LIMITER_PRECISION_BASE } from "lib/constants";

import { ProtocolContext } from "../types";

import { ensureFirstPostMigrationReport, reportWithoutClActivation } from "./accounting";
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

  const ethToSubmit = ether("1000000"); // don't calculate required eth from withdrawal queue to accelerate tests
  await ensureFirstPostMigrationReport(ctx);

  const lastRequestId = await withdrawalQueue.getLastRequestId();
  while (lastRequestId != (await withdrawalQueue.getLastFinalizedRequestId())) {
    await ethHolder.sendTransaction({
      to: elRewardsVaultAddress,
      value: ethToSubmit,
    });
    await reportWithoutClActivation(ctx, { reportElVault: true });
  }
  await setMaxPositiveTokenRebase(ctx, initialMaxPositiveTokenRebase);
  await reportWithoutClActivation(ctx, { reportElVault: true });
};

export const finalizeWQViaSubmit = async (ctx: ProtocolContext) => {
  const { withdrawalQueue, lido } = ctx.contracts;
  const ethHolder = await impersonate(certainAddress("withdrawalQueue:eth:whale"), ether("1000000000"));

  const ethToSubmit = ether("1000000"); // don't calculate required eth from withdrawal queue to accelerate tests

  const stakeLimitInfo = await lido.getStakeLimitFullInfo();
  await removeStakingLimit(ctx);
  await ensureFirstPostMigrationReport(ctx);

  const lastRequestId = await withdrawalQueue.getLastRequestId();
  while (lastRequestId != (await withdrawalQueue.getLastFinalizedRequestId())) {
    await lido.connect(ethHolder).submit(ZeroAddress, { value: ethToSubmit });
    await reportWithoutClActivation(ctx, { reportElVault: false });
  }

  await setStakingLimit(
    ctx,
    stakeLimitInfo.maxStakeLimit,
    stakeLimitInfo.maxStakeLimit / stakeLimitInfo.maxStakeLimitGrowthBlocks,
  );
};
