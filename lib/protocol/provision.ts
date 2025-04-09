import { log } from "lib";
import { ensureEIP7002WithdrawalRequestContractPresent } from "lib/eips";

import {
  ensureHashConsensusInitialEpoch,
  ensureOracleCommitteeMembers,
  ensureStakeLimit,
  finalizeWithdrawalQueue,
  norEnsureOperators,
  sdvtEnsureOperators,
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

  // Ensure protocol is fully operational
  await ensureHashConsensusInitialEpoch(ctx);

  await ensureOracleCommitteeMembers(ctx, 5n);

  await unpauseStaking(ctx);
  await unpauseWithdrawalQueue(ctx);

  await norEnsureOperators(ctx, 3n, 5n);
  await sdvtEnsureOperators(ctx, 3n, 5n);

  await finalizeWithdrawalQueue(ctx);

  await ensureStakeLimit(ctx);

  alreadyProvisioned = true;

  log.success("Provisioned");
};
