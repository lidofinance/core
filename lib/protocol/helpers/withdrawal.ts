import { expect } from "chai";
import { ZeroAddress } from "ethers";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether, log, trace, updateBalance } from "lib";

import { ProtocolContext } from "../types";

import { report } from "./accounting";

/**
 * Unpauses the withdrawal queue contract.
 */
export const unpauseWithdrawalQueue = async (ctx: ProtocolContext) => {
  const { withdrawalQueue } = ctx.contracts;
  if (await withdrawalQueue.isPaused()) {
    log.warning("Unpausing withdrawal queue contract");

    const resumeRole = await withdrawalQueue.RESUME_ROLE();
    const agentSigner = await ctx.getSigner("agent");
    const agentSignerAddress = await agentSigner.getAddress();

    await withdrawalQueue.connect(agentSigner).grantRole(resumeRole, agentSignerAddress);

    const tx = await withdrawalQueue.connect(agentSigner).resume();
    await trace("withdrawalQueue.resume", tx);

    await withdrawalQueue.connect(agentSigner).revokeRole(resumeRole, agentSignerAddress);

    log.success("Unpaused withdrawal queue contract");
  }
};

export const finalizeWithdrawalQueue = async (
  ctx: ProtocolContext,
  stEthHolder: HardhatEthersSigner,
  ethHolder: HardhatEthersSigner,
) => {
  const { lido, withdrawalQueue } = ctx.contracts;

  await updateBalance(ethHolder.address, ether("1000000"));
  await updateBalance(stEthHolder.address, ether("1000000"));

  const stEthHolderAmount = ether("10000");

  // Here sendTransaction is used to validate native way of submitting ETH for stETH
  const tx = await stEthHolder.sendTransaction({ to: lido.address, value: stEthHolderAmount });
  await trace("stEthHolder.sendTransaction", tx);

  const stEthHolderBalance = await lido.balanceOf(stEthHolder.address);
  expect(stEthHolderBalance).to.approximately(stEthHolderAmount, 10n, "stETH balance increased");

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

    const submitTx = await ctx.contracts.lido
      .connect(ethHolder)
      .submit(ZeroAddress, { value: ether("10000") });

    await trace("lido.submit", submitTx);
  }

  const submitTx = await ctx.contracts.lido
    .connect(ethHolder)
    .submit(ZeroAddress, { value: ether("10000") });

  await trace("lido.submit", submitTx);

  log.success("Finalized withdrawal queue");
};
