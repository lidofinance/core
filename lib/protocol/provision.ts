import {
  ensureHashConsensusInitialEpoch,
  ensureOracleCommitteeMembers,
  ensureStakeLimit,
  norEnsureOperators,
  sdvtEnsureOperators,
  unpauseStaking,
  unpauseWithdrawalQueue,
} from "./helpers";
import { ProtocolContext } from "./types";

/**
 * In order to make the protocol fully operational from scratch deploy, the additional steps are required:
 */
export const provision = async (ctx: ProtocolContext) => {
  await ensureHashConsensusInitialEpoch(ctx);

  await ensureOracleCommitteeMembers(ctx, 5n);

  await unpauseStaking(ctx);

  await unpauseWithdrawalQueue(ctx);

  await norEnsureOperators(ctx, 3n, 5n);
  await sdvtEnsureOperators(ctx, 3n, 5n);

  await ensureStakeLimit(ctx);
};
