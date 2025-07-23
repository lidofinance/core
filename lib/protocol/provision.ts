import { certainAddress, ether, impersonate, log } from "lib";

import {
  ensureDsmGuardians,
  ensureHashConsensusInitialEpoch,
  ensureOracleCommitteeMembers,
  ensureStakeLimit,
  norSdvtEnsureOperators,
  unpauseStaking,
  unpauseWithdrawalQueue,
} from "./helpers";
import { ProtocolContext } from "./types";

let alreadyProvisioned = false;

/**
 * In order to make the protocol fully operational from scratch deploy, the additional steps are required:
 */
export const provision = async (ctx: ProtocolContext) => {
  if (alreadyProvisioned) {
    log.success("Already provisioned");
    return;
  }

  await ensureHashConsensusInitialEpoch(ctx);

  await ensureOracleCommitteeMembers(ctx, 5n, 4n);

  await unpauseStaking(ctx);
  await unpauseWithdrawalQueue(ctx);

  await norSdvtEnsureOperators(ctx, ctx.contracts.nor, 10n, 15n, 10n);

  // NB: For scratch deployment share of SDVT module is quite low
  // so we need to ensure that there are enough operators in NOR
  // so there are enough share limit for SDVT to get the deposits
  // (see SDVT_STAKING_MODULE_TARGET_SHARE_BP)
  await norSdvtEnsureOperators(ctx, ctx.contracts.sdvt, 2n, 3n, 1n);

  // Ensure some initial TVL required for current tests
  const ethHolder = await impersonate(certainAddress("withdrawalQueue:eth:whale"), ether("100000000"));
  await ethHolder.sendTransaction({ to: ctx.contracts.lido.address, value: ether("100000") });

  await ensureStakeLimit(ctx);

  await ensureDsmGuardians(ctx, 3n, 2n);

  alreadyProvisioned = true;

  log.success("Provisioned");
};
