import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { certainAddress, ether, impersonate, log } from "lib";

import { ProtocolContext } from "../types";

import { report } from "./accounting";

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

export const finalizeWithdrawalQueue = async (ctx: ProtocolContext) => {
  const { lido, withdrawalQueue } = ctx.contracts;

  const unfinalizedAmount = await withdrawalQueue.unfinalizedStETH();
  const depositAmount = ether("10000");

  const ethHolder = await impersonate(
    certainAddress("withdrawalQueue:eth:whale"),
    unfinalizedAmount + depositAmount + ether("10"),
  );
  const stEthHolder = await impersonate(certainAddress("withdrawalQueue:stEth:whale"), ether("100000"));

  // Here sendTransaction is used to validate native way of submitting ETH for stETH
  await stEthHolder.sendTransaction({ to: lido.address, value: depositAmount });

  let lastFinalizedRequestId = await withdrawalQueue.getLastFinalizedRequestId();
  let lastRequestId = await withdrawalQueue.getLastRequestId();

  while (lastFinalizedRequestId != lastRequestId) {
    await report(ctx);

    lastFinalizedRequestId = await withdrawalQueue.getLastFinalizedRequestId();
    lastRequestId = await withdrawalQueue.getLastRequestId();

    log.debug("Withdrawal queue status", {
      "Last finalized request ID": lastFinalizedRequestId,
      "Last request ID": lastRequestId,
    });

    await ctx.contracts.lido.connect(ethHolder).submit(ZeroAddress, { value: depositAmount });

    // Mine N blocks to restore all staking limits
    const limits = await ctx.contracts.lido.getStakeLimitFullInfo();
    await ethers.provider.send("hardhat_mine", [`0x${limits.maxStakeLimitGrowthBlocks.toString(16)}`]);
  }

  log.success("Finalized withdrawal queue");
};
