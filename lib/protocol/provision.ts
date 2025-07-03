import { log } from "lib";
import { ensureEIP4788BeaconBlockRootContractPresent, ensureEIP7002WithdrawalRequestContractPresent } from "lib/eips";

import {
  ensureDsmGuardians,
  ensureHashConsensusInitialEpoch,
  ensureOracleCommitteeMembers,
  ensureStakeLimit,
  finalizeWithdrawalQueue,
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

  // Ensure necessary precompiled contracts are present
  await ensureEIP7002WithdrawalRequestContractPresent();
  await ensureEIP4788BeaconBlockRootContractPresent();

  // Ensure protocol is fully operational
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

  await finalizeWithdrawalQueue(ctx);

  await ensureStakeLimit(ctx);

  await ensureDsmGuardians(ctx, 3n, 2n);

  alreadyProvisioned = true;

  log.success("Provisioned");
};
