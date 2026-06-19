import { ZeroAddress } from "ethers";

import { certainAddress, ether, impersonate, log } from "lib";
import {
  ensureEIP4788BeaconBlockRootContractPresent,
  ensureEIP7002WithdrawalRequestContractPresent,
  ensureEIP7251MaxEffectiveBalanceRequestContractPresent,
} from "lib/eips";

import {
  ensureDsmGuardians,
  ensureHashConsensusInitialEpoch,
  ensureOracleCommitteeMembers,
  ensureSomeOddShareRate,
  ensureStakeLimit,
  norSdvtEnsureOperators,
  unpauseStaking,
  unpauseWithdrawalQueue,
  upDefaultTierShareLimit,
} from "./helpers";
import { ProtocolContext } from "./types";

let alreadyProvisioned = false;

export const resetProvisionedForTests = () => {
  alreadyProvisioned = false;
};

export const ensureNonZeroDepositsReserveTarget = async (ctx: ProtocolContext, target: bigint = ether("8")) => {
  const { acl, lido } = ctx.contracts;
  if ((await lido.getDepositsReserveTarget()) > 0n) return;

  const role = await lido.BUFFER_RESERVE_MANAGER_ROLE();
  const agent = await ctx.getSigner("agent");
  const hasRole = await acl["hasPermission(address,address,bytes32)"](agent.address, lido.address, role);
  if (!hasRole) {
    const permissionManager = await acl.getPermissionManager(lido.address, role);
    if (permissionManager === ZeroAddress) {
      const voting = await ctx.getSigner("voting");
      await acl.connect(voting).createPermission(agent.address, lido.address, role, agent.address);
    } else {
      if (permissionManager.toLowerCase() !== agent.address.toLowerCase()) {
        throw new Error(`BUFFER_RESERVE_MANAGER_ROLE manager must be agent, got: ${permissionManager}`);
      }
      await acl.connect(agent).grantPermission(agent.address, lido.address, role);
    }
  }

  await lido.connect(agent).setDepositsReserveTarget(target);
  log.debug("Set non-zero deposits reserve target", { target: target.toString() });
};

export const provisionWithoutReports = async (ctx: ProtocolContext) => {
  // Ensure necessary precompiled contracts are present
  await ensureEIP7002WithdrawalRequestContractPresent();
  await ensureEIP4788BeaconBlockRootContractPresent();
  await ensureEIP7251MaxEffectiveBalanceRequestContractPresent();

  // Ensure protocol is operational without creating Accounting reports.
  await ensureHashConsensusInitialEpoch(ctx);
  await ensureOracleCommitteeMembers(ctx, 5n, 4n);
  await unpauseStaking(ctx);
  await unpauseWithdrawalQueue(ctx);

  const ethHolder = await impersonate(certainAddress("withdrawalQueue:eth:whale"), ether("100000000"));
  await ethHolder.sendTransaction({ to: ctx.contracts.lido.address, value: ether("10000") });

  await ensureStakeLimit(ctx);
  await ensureNonZeroDepositsReserveTarget(ctx);
  await ensureDsmGuardians(ctx, 3n, 2n);
  await upDefaultTierShareLimit(ctx, ether("250"));
};

/**
 * In order to make the protocol fully operational from scratch deploy, the additional steps are required:
 */
export const provision = async (ctx: ProtocolContext) => {
  if (alreadyProvisioned) {
    log.debug("Already provisioned");
    return;
  }

  await provisionWithoutReports(ctx);

  await norSdvtEnsureOperators(ctx, ctx.contracts.nor, 10n, 15n, 10n);

  // NB: For scratch deployment share of SDVT module is quite low
  // so we need to ensure that there are enough operators in NOR
  // so there are enough share limit for SDVT to get the deposits
  // (see SDVT_STAKING_MODULE_TARGET_SHARE_BP)
  await norSdvtEnsureOperators(ctx, ctx.contracts.sdvt, 2n, 3n, 1n);

  if (ctx.isScratch) {
    await ensureSomeOddShareRate(ctx);
  }

  alreadyProvisioned = true;

  log.success("Provisioned");
};
