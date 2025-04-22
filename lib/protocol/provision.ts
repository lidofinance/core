import { log } from "lib";

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

  // Ensure protocol is fully operational
  await ensureHashConsensusInitialEpoch(ctx);

  await ensureOracleCommitteeMembers(ctx, 5n, 4n);

  await unpauseStaking(ctx);
  await unpauseWithdrawalQueue(ctx);

  await norSdvtEnsureOperators(ctx, ctx.contracts.nor, 5n, 9n);
  await norSdvtEnsureOperators(ctx, ctx.contracts.sdvt, 5n, 9n);

  await finalizeWithdrawalQueue(ctx);

  await ensureStakeLimit(ctx);

  await ensureDsmGuardians(ctx, 3n, 2n);

  alreadyProvisioned = true;

  log.success("Provisioned");
};
