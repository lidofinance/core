import { ProtocolContext } from "../types";

export const setMaxPositiveTokenRebase = async (ctx: ProtocolContext, maxPositiveTokenRebase: bigint) => {
  const { oracleReportSanityChecker: sanityChecker } = ctx.contracts;
  const agent = await ctx.getSigner("agent");

  const initialMaxPositiveTokenRebase = await sanityChecker.getMaxPositiveTokenRebase();

  const MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE = await sanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE();
  await sanityChecker.connect(agent).grantRole(MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE, agent.address);
  await sanityChecker.connect(agent).setMaxPositiveTokenRebase(maxPositiveTokenRebase);
  await sanityChecker.connect(agent).revokeRole(MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE, agent.address);
  return initialMaxPositiveTokenRebase;
};
