import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { certainAddress, ether, impersonate, log } from "lib";

import { ProtocolContext } from "../types";

import { report } from "./accounting";

/**
 * Mines a specified number of blocks to allow stake limit to increase.
 * With stake limit increase of 20 ETH per block and submission of 1,000 ETH,
 * we need at least 50 blocks to fully replenish the stake limit.
 */
const mineBlocks = async (blocks: number = 60) => {
  await ethers.provider.send("hardhat_mine", [`0x${blocks.toString(16)}`]);
};

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

  const ethHolder = await impersonate(certainAddress("withdrawalQueue:eth:whale"), ether("150000"));
  const stEthHolder = await impersonate(certainAddress("withdrawalQueue:stEth:whale"), ether("100000"));
  const stEthHolderAmount = ether("10000");

  // Here sendTransaction is used to validate native way of submitting ETH for stETH
  await stEthHolder.sendTransaction({ to: lido.address, value: stEthHolderAmount });

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

    // Mine blocks to increase stake limit before submission
    await mineBlocks();
    await ctx.contracts.lido.connect(ethHolder).submit(ZeroAddress, { value: ether("1000") });
  }

  // Mine blocks to increase stake limit before final submission
  await mineBlocks();
  await ctx.contracts.lido.connect(ethHolder).submit(ZeroAddress, { value: ether("1000") });

  log.success("Finalized withdrawal queue");
};
