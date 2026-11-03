import { ContractTransactionResponse } from "ethers";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { readWithdrawalRequests } from "lib/eips/eip7002";

import { ProtocolContext } from "../types";

type RoleHolder = {
  hasRole(role: string, account: string): Promise<boolean>;
  connect(runner: HardhatEthersSigner): {
    grantRole(role: string, account: string): Promise<ContractTransactionResponse>;
  };
};

/** Pops every pending request from the EIP-7002 queue so a test reads only its own requests. */
export const drainWithdrawalRequestsQueue = async () => {
  while ((await readWithdrawalRequests()).length > 0) {
    /* empty */
  }
};

/** Grants `role` on `contract` to `account` from the Agent, the admin of the triggerable withdrawals contracts. */
export const ensureRoleFromAgent = async (
  ctx: ProtocolContext,
  contract: RoleHolder,
  role: string,
  account: HardhatEthersSigner | string,
) => {
  const address = typeof account === "string" ? account : account.address;
  if (await contract.hasRole(role, address)) return;

  const agent = await ctx.getSigner("agent");
  await (await contract.connect(agent).grantRole(role, address)).wait();
};

/** Parameters of a gateway quota, as `ITriggerableWithdrawalsGateway.LimitConfig`. */
export type TriggerableWithdrawalsLimitConfig = { maxLimit: bigint; limitPerFrame: bigint; frameDurationInSec: bigint };

/** A disabled gateway quota. */
export const DISABLED_TRIGGERABLE_WITHDRAWALS_LIMIT: TriggerableWithdrawalsLimitConfig = {
  maxLimit: 0n,
  limitPerFrame: 0n,
  frameDurationInSec: 0n,
};

/**
 * A gateway quota with a long frame, so nothing is restored during a test and the consumed quota can be
 * checked exactly.
 */
export const fixedTriggerableWithdrawalsLimit = (maxLimit: bigint): TriggerableWithdrawalsLimitConfig => ({
  maxLimit,
  limitPerFrame: 1n,
  frameDurationInSec: 365n * 24n * 3600n,
});

/**
 * Sets the gateway limits of `consumer` from the Agent and starts both quotas full: the limits are disabled
 * first, so no consumed quota is carried over.
 */
export const setTriggerableWithdrawalsConsumerLimits = async (
  ctx: ProtocolContext,
  consumer: string,
  pwrLimit: TriggerableWithdrawalsLimitConfig,
  fwrLimit: TriggerableWithdrawalsLimitConfig,
) => {
  const gateway = ctx.contracts.triggerableWithdrawalsGateway;
  const agent = await ctx.getSigner("agent");
  const disabled = DISABLED_TRIGGERABLE_WITHDRAWALS_LIMIT;

  await ensureRoleFromAgent(ctx, gateway, await gateway.TW_EXIT_LIMIT_MANAGER_ROLE(), agent);
  await (await gateway.connect(agent).setConsumerLimits(consumer, disabled, disabled)).wait();
  await (await gateway.connect(agent).setConsumerLimits(consumer, pwrLimit, fwrLimit)).wait();
};
